import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { getRecordingErrorTitle } from "../utils/recordingErrors";

function parseStyleDescriptions(value) {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    logger.warn(
      "Failed to parse AdamWispr style descriptions",
      { error: error.message },
      "dictation"
    );
    return {};
  }
}

async function autoCategorizeNewApp(settings, context) {
  if (settings.awAutoCategorizeMode !== "auto" || !context?.appName) {
    return;
  }

  try {
    const categories = await window.electronAPI.awGetAppCategories();
    const isKnown = categories.some((category) => {
      const appMatches = category.app_name && context.appName.includes(category.app_name);
      const urlPattern = category.url_pattern || "";
      const urlMatches = urlPattern ? context.url?.includes(urlPattern) : true;
      return appMatches && urlMatches;
    });

    if (isKnown) {
      return;
    }

    const existingCategoryNames = [...new Set(categories.map((category) => category.category))];
    if (existingCategoryNames.length === 0) {
      return;
    }

    // TODO: Wire auto-categorize to use ReasoningService
    // The LLM-backed category suggestion step is intentionally disabled for now.
  } catch (error) {
    logger.warn(
      "Failed to auto-categorize app after dictation",
      { appName: context?.appName, error: error.message },
      "dictation"
    );
  }
}

async function processAndPaste({
  cleanedText,
  rawTranscript,
  cleanupStatus,
  durationSeconds,
  pasteOptions,
  audioManager,
}) {
  const settings = getSettings();
  const defaultCategory = settings.awDefaultCategory || "Professional";
  const fallbackContext = {
    appName: "Unknown",
    category: defaultCategory,
    url: undefined,
  };

  let context = fallbackContext;
  let LearningService;

  try {
    const [{ ContextService }, learningModule] = await Promise.all([
      import("../services/ContextService"),
      import("../services/LearningService"),
    ]);

    LearningService = learningModule.LearningService;
    context = await ContextService.getCurrentContext();
  } catch (error) {
    logger.warn(
      "AdamWispr context lookup failed during post-processing",
      { error: error.message },
      "dictation"
    );
  }

  const textToPaste = cleanedText || rawTranscript;
  const wordCount = textToPaste.split(/\s+/).filter(Boolean).length;
  const safeDurationSeconds =
    Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const wpm = safeDurationSeconds > 0 ? (wordCount / safeDurationSeconds) * 60 : 0;

  await Promise.allSettled([
    window.electronAPI.awSaveDictationHistory(
      rawTranscript,
      textToPaste,
      context.appName,
      context.category,
      cleanupStatus
    ),
    window.electronAPI.awSaveDictationStats(
      wordCount,
      safeDurationSeconds,
      wpm,
      context.appName
    ),
  ]);

  const pasted = await audioManager.safePaste(textToPaste, pasteOptions);

  if (pasted && settings.awTextFieldTracking && LearningService) {
    void LearningService.startCorrectionMonitoring(textToPaste, context.appName).catch((error) => {
      logger.warn(
        "Failed to start correction monitoring",
        { appName: context.appName, error: error.message },
        "dictation"
      );
    });
  }

  if (pasted) {
    void autoCategorizeNewApp(settings, context);
  }

  return {
    textToPaste,
    context,
    cleanupStatus,
    pasted,
  };
}

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const { onToggle } = options;

  const performStartRecording = useCallback(async () => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        void playStartCue();
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.pauseMediaPlayback?.();
        }
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, []);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setAdamWisprContextProvider(async () => {
      const settings = getSettings();
      const hasAdamWisprSettings =
        !!settings.awDefaultCategory ||
        !!settings.awFormattingInstructions ||
        !!settings.awStyleDescriptions ||
        settings.awAutoLearningEnabled ||
        settings.awTextFieldTracking ||
        settings.awAutoCategorizeMode === "auto";

      if (!hasAdamWisprSettings) {
        return null;
      }

      try {
        const [{ ContextService }, correctionRows, profile] = await Promise.all([
          import("../services/ContextService"),
          window.electronAPI.awGetCorrections(500),
          window.electronAPI.awGetProfile(),
        ]);

        const context = await ContextService.getCurrentContext();

        return {
          profile,
          corrections: (correctionRows || []).map((entry) => ({
            original: entry.original_word,
            corrected: entry.corrected_word,
            frequency: entry.count,
          })),
          styleDescriptions: parseStyleDescriptions(settings.awStyleDescriptions),
          formattingInstructions: settings.awFormattingInstructions || "",
          appName: context?.appName,
          url: context?.url,
          pageTitle: context?.pageTitle,
          surroundingText: context?.surroundingText,
          category: context?.category || settings.awDefaultCategory || "Professional",
        };
      } catch (error) {
        logger.warn(
          "AdamWispr context collection failed",
          { error: error.message },
          "dictation"
        );
        return null;
      }
    });

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        const title = getRecordingErrorTitle(error, t);
        toast({
          title,
          description: error.description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }

        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            return;
          }

          const isStreaming = result.source?.includes("streaming");
          const { keepTranscriptionInClipboard } = getSettings();
          const rawTranscript = result.rawText?.trim() || result.text;
          const cleanedText = result.text?.trim() || rawTranscript;
          const cleanupStatus = cleanedText !== rawTranscript ? "success" : "skipped";
          const durationSeconds = audioManagerRef.current?.lastAudioMetadata?.durationMs
            ? audioManagerRef.current.lastAudioMetadata.durationMs / 1000
            : 0;
          const processingStart = performance.now();
          const processedResult = await processAndPaste({
            cleanedText,
            rawTranscript,
            cleanupStatus,
            durationSeconds,
            audioManager: audioManagerRef.current,
            pasteOptions: {
              ...(isStreaming ? { fromStreaming: true } : {}),
              restoreClipboard: !keepTranscriptionInClipboard,
            },
          });
          const processingDurationMs = Math.round(performance.now() - processingStart);

          setTranscript(processedResult.textToPaste);

          logger.info(
            "Dictation cleanup and paste timing",
            {
              totalMs: processingDurationMs,
              source: result.source,
              cleanupStatus: processedResult.cleanupStatus,
              textLength: processedResult.textToPaste.length,
              appName: processedResult.context?.appName,
              pasted: processedResult.pasted,
            },
            "dictation"
          );

          audioManagerRef.current.saveTranscription(processedResult.textToPaste, rawTranscript);

          logger.info(
            "Paste timing",
            {
              pasteMs: processingDurationMs,
              source: result.source,
              textLength: processedResult.textToPaste.length,
            },
            "streaming"
          );

          if (result.source === "openai" && getSettings().useLocalWhisper) {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      },
    });

    audioManagerRef.current.setContext("dictation");
    window.electronAPI.getSttConfig?.().then((config) => {
      if (config && audioManagerRef.current) {
        audioManagerRef.current.setSttConfig(config);
        if (audioManagerRef.current.shouldUseStreaming()) {
          audioManagerRef.current.warmupStreamingConnection();
        }
      }
    });

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording();
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [toast, onToggle, performStartRecording, performStopRecording, t]);

  const startRecording = async () => {
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await startRecording();
    } else if (isRecording) {
      await stopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    transcript,
    partialTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
