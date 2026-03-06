import { useState, useEffect, useRef, useCallback } from "react";
import { getSettings } from "../stores/settingsStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import logger from "../utils/logger";

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  transcript: string;
  partialTranscript: string;
  error: string | null;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = `
const BUFFER_SIZE = ${MEETING_AUDIO_BUFFER_SIZE};
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
`;

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return blobUrl;
  };
})();

const getMeetingMicConstraints = async (): Promise<MediaStreamConstraints> => {
  const { preferBuiltInMic, selectedMicDeviceId } = getSettings();
  const micProcessing = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  };

  if (preferBuiltInMic) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtInMic = devices.find(
        (device) => device.kind === "audioinput" && isBuiltInMicrophone(device.label)
      );

      if (builtInMic?.deviceId) {
        return {
          audio: {
            deviceId: { exact: builtInMic.deviceId },
            ...micProcessing,
          },
        };
      }
    } catch (err) {
      logger.debug(
        "Failed to enumerate microphones for meeting transcription",
        { error: (err as Error).message },
        "meeting"
      );
    }
  }

  if (selectedMicDeviceId && selectedMicDeviceId !== "default") {
    return {
      audio: {
        deviceId: { exact: selectedMicDeviceId },
        ...micProcessing,
      },
    };
  }

  return { audio: micProcessing };
};

const createAudioPipeline = async ({
  stream,
  context,
  label,
  onChunk,
}: {
  stream: MediaStream;
  context: AudioContext;
  label: string;
  onChunk: (chunk: ArrayBuffer) => void;
}) => {
  if (context.state === "suspended") {
    await context.resume();
  }

  await context.audioWorklet.addModule(getMeetingWorkletBlobUrl());

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor");
  let chunkCount = 0;

  processor.port.onmessage = (event) => {
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;

    if (chunkCount < 10 || chunkCount % 50 === 0) {
      const samples = new Int16Array(chunk);
      let maxAmplitude = 0;
      for (let i = 0; i < samples.length; i++) {
        const normalized = Math.abs(samples[i]) / 0x7fff;
        if (normalized > maxAmplitude) maxAmplitude = normalized;
      }

      logger.debug(
        `${label} audio chunk`,
        { maxAmplitude: maxAmplitude.toFixed(6), samples: samples.length },
        "meeting"
      );
    }

    chunkCount++;
    onChunk(chunk);
  };

  source.connect(processor);
  processor.connect(context.destination);

  return { source, processor };
};

const flushAndDisconnectProcessor = async (processor: AudioWorkletNode | null) => {
  if (!processor) return;

  try {
    processor.port.postMessage("stop");
    await new Promise((resolve) => {
      window.setTimeout(resolve, MEETING_STOP_FLUSH_TIMEOUT_MS);
    });
  } catch {}

  processor.port.onmessage = null;
  processor.disconnect();
};

const getSystemAudioStream = async (): Promise<MediaStream | null> => {
  try {
    // Use getDisplayMedia (handled by setDisplayMediaRequestHandler in main process)
    // which properly captures system audio via macOS ScreenCaptureKit loopback.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    logger.debug(
      "Display media stream obtained",
      {
        audioTracks: audioTracks.length,
        videoTracks: videoTracks.length,
        audioSettings: audioTracks[0]?.getSettings(),
      },
      "meeting"
    );

    if (!audioTracks.length) {
      logger.error("No audio track in display media stream", {}, "meeting");
      videoTracks.forEach((t) => t.stop());
      return null;
    }

    // Video tracks must stay alive — stopping them kills the ScreenCaptureKit loopback audio

    audioTracks[0].addEventListener("ended", () => {
      logger.error("Audio track ended unexpectedly", {}, "meeting");
    });

    return stream;
  } catch (err) {
    logger.error("Failed to capture system audio", { error: (err as Error).message }, "meeting");
    return null;
  }
};

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);

  const cleanup = useCallback(async () => {
    if (processorRef.current) {
      await flushAndDisconnectProcessor(processorRef.current);
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (micProcessorRef.current) {
      await flushAndDisconnectProcessor(micProcessorRef.current);
      micProcessorRef.current = null;
    }

    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }

    if (micStreamRef.current) {
      try {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      micStreamRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    if (micContextRef.current) {
      try {
        await micContextRef.current.close();
      } catch {}
      micContextRef.current = null;
    }

    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;
    setIsRecording(false);

    await cleanup();
    isRecordingRef.current = false;

    try {
      const result = await window.electronAPI?.meetingTranscriptionStop?.();
      if (result?.success && result.transcript) {
        setTranscript(result.transcript);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      setError((err as Error).message);
      logger.error(
        "Meeting transcription stop failed",
        { error: (err as Error).message },
        "meeting"
      );
    }

    logger.info("Meeting transcription stopped", {}, "meeting");
  }, [cleanup]);

  const startTranscription = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) return;
    isStartingRef.current = true;

    logger.info("Meeting transcription starting...", {}, "meeting");
    setTranscript("");
    setPartialTranscript("");
    setError(null);

    try {
      const [startResult, stream] = await Promise.all([
        window.electronAPI?.meetingTranscriptionStart?.({
          provider: "openai-realtime",
          model: "gpt-4o-mini-transcribe",
        }),
        getSystemAudioStream(),
      ]);
      if (!startResult?.success) {
        logger.error(
          "Meeting transcription IPC start failed",
          { error: startResult?.error },
          "meeting"
        );
        stream?.getTracks().forEach((track) => track.stop());
        isStartingRef.current = false;
        return;
      }

      if (!stream) {
        logger.error("Could not capture system audio for meeting transcription", {}, "meeting");
        await window.electronAPI?.meetingTranscriptionStop?.();
        isStartingRef.current = false;
        return;
      }
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      const partialCleanup = window.electronAPI?.onMeetingTranscriptionPartial?.((text) => {
        setPartialTranscript(text);
      });
      if (partialCleanup) ipcCleanupsRef.current.push(partialCleanup);

      const finalCleanup = window.electronAPI?.onMeetingTranscriptionFinal?.((text) => {
        setTranscript(text);
        setPartialTranscript("");
      });
      if (finalCleanup) ipcCleanupsRef.current.push(finalCleanup);

      const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
        setError(err);
        logger.error("Meeting transcription stream error", { error: err }, "meeting");
      });
      if (errorCleanup) ipcCleanupsRef.current.push(errorCleanup);

      const pendingAudioChunks: ArrayBuffer[] = [];
      let socketReady = false;

      const { source, processor } = await createAudioPipeline({
        stream,
        context: audioContext,
        label: "Meeting system",
        onChunk: (chunk) => {
          if (!isRecordingRef.current) return;
          const samples = new Int16Array(chunk);
          let hasSignal = false;
          for (let i = 0; i < samples.length; i++) {
            if (samples[i] !== 0) {
              hasSignal = true;
              break;
            }
          }
          if (!hasSignal) return;
          if (socketReady) {
            window.electronAPI?.meetingTranscriptionSend?.(chunk);
            return;
          }
          pendingAudioChunks.push(chunk.slice(0));
        },
      });
      sourceRef.current = source;
      processorRef.current = processor;

      try {
        const micStream = await navigator.mediaDevices.getUserMedia(
          await getMeetingMicConstraints()
        );
        micStreamRef.current = micStream;

        const micContext = new AudioContext({ sampleRate: 24000 });
        micContextRef.current = micContext;

        const { source: micSource, processor: micProcessor } = await createAudioPipeline({
          stream: micStream,
          context: micContext,
          label: "Meeting mic",
          onChunk: (chunk) => {
            if (!isRecordingRef.current) return;
            if (socketReady) {
              window.electronAPI?.meetingTranscriptionSend?.(chunk);
              return;
            }
            pendingAudioChunks.push(chunk.slice(0));
          },
        });
        micSourceRef.current = micSource;
        micProcessorRef.current = micProcessor;

        const micTrack = micStream.getAudioTracks()[0];
        logger.info(
          "Mic capture started for meeting transcription",
          {
            label: micTrack?.label,
            settings: micTrack?.getSettings(),
          },
          "meeting"
        );
      } catch (micErr) {
        logger.error(
          "Mic capture failed, continuing with system audio only",
          { error: (micErr as Error).message },
          "meeting"
        );
      }

      isRecordingRef.current = true;
      isStartingRef.current = false;
      setIsRecording(true);
      socketReady = true;

      for (const chunk of pendingAudioChunks) {
        window.electronAPI?.meetingTranscriptionSend?.(chunk);
      }

      logger.info(
        "Meeting transcription started successfully",
        { bufferedChunks: pendingAudioChunks.length },
        "meeting"
      );
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
      isStartingRef.current = false;
      await cleanup();
    }
  }, [cleanup]);

  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        void cleanup().finally(() => {
          isRecordingRef.current = false;
        });
      }
    };
  }, [cleanup]);

  return {
    isRecording,
    transcript,
    partialTranscript,
    error,
    startTranscription,
    stopTranscription,
  };
}
