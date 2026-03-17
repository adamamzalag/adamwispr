// AdamWispr: Personalized learning service
// Monitors corrections, builds user profile via background learning loop

import { NativeBridge } from "./NativeBridge";

interface PasteSnapshot {
  pastedText: string;
  fieldContentBefore: string | null;
  appContext: string;
  timestamp: number;
}

let currentSnapshot: PasteSnapshot | null = null;
let monitoringTimeout: ReturnType<typeof setTimeout> | null = null;

export class LearningService {
  private static learningInterval: ReturnType<typeof setInterval> | null =
    null;
  private static correctionsSinceLastLoop = 0;

  /**
   * Start monitoring for corrections after a paste.
   */
  static async startCorrectionMonitoring(
    pastedText: string,
    appContext: string
  ): Promise<void> {
    this.stopCorrectionMonitoring();

    const context = await NativeBridge.getContext();
    const fieldContent = context.surroundingText;

    if (!fieldContent) {
      // Can't read this field — skip monitoring silently
      return;
    }

    currentSnapshot = {
      pastedText,
      fieldContentBefore: fieldContent,
      appContext,
      timestamp: Date.now(),
    };

    monitoringTimeout = setTimeout(() => {
      this.checkForCorrections();
    }, 60000);
  }

  static stopCorrectionMonitoring(): void {
    if (monitoringTimeout) {
      clearTimeout(monitoringTimeout);
      monitoringTimeout = null;
    }
    if (currentSnapshot) {
      this.checkForCorrections();
    }
  }

  private static async checkForCorrections(): Promise<void> {
    if (!currentSnapshot) return;

    const snapshot = currentSnapshot;
    currentSnapshot = null;

    try {
      const afterContext = await NativeBridge.getContext();
      const fieldContentAfter = afterContext.surroundingText;
      if (!fieldContentAfter) return;

      const pastedWords = snapshot.pastedText.split(/\s+/).filter(Boolean);
      if (pastedWords.length === 0) return;

      // Size heuristic
      const beforeLength = snapshot.pastedText.length;
      const diffRatio =
        Math.abs(fieldContentAfter.length - (snapshot.fieldContentBefore?.length ?? 0)) /
        beforeLength;

      if (diffRatio > 0.7) return; // Redo, not correction

      const corrections = this.findWordCorrections(
        snapshot.pastedText,
        fieldContentAfter
      );

      for (const { original, corrected } of corrections) {
        if (original.length <= 1 || corrected.length <= 1) continue;
        if (original === corrected) continue;

        await window.electronAPI.awSaveCorrection(
          original,
          corrected,
          snapshot.appContext
        );
        this.correctionsSinceLastLoop++;
      }

      const { useSettingsStore } = await import("../stores/settingsStore");
      const settings = useSettingsStore.getState();
      if (
        this.correctionsSinceLastLoop >= settings.awLearningCorrectionThreshold
      ) {
        this.runLearningIteration();
        this.correctionsSinceLastLoop = 0;
      }
    } catch {
      // Silently fail — correction monitoring is best-effort
    }
  }

  private static findWordCorrections(
    original: string,
    modified: string
  ): Array<{ original: string; corrected: string }> {
    const origWords = original.split(/\s+/).filter(Boolean);
    const modWords = modified.split(/\s+/).filter(Boolean);
    const corrections: Array<{ original: string; corrected: string }> = [];

    const minLen = Math.min(origWords.length, modWords.length);
    for (let i = 0; i < minLen; i++) {
      const origClean = origWords[i]
        .replace(/[.,!?;:'"]/g, "")
        .toLowerCase();
      const modClean = modWords[i]
        .replace(/[.,!?;:'"]/g, "")
        .toLowerCase();

      if (origClean !== modClean && origClean.length > 1) {
        corrections.push({
          original: origWords[i].replace(/[.,!?;:'"]/g, ""),
          corrected: modWords[i].replace(/[.,!?;:'"]/g, ""),
        });
      }
    }

    return corrections;
  }

  static startLearningLoop(
    intervalMinutes: number,
    _correctionThreshold: number
  ): void {
    this.stopLearningLoop();
    this.learningInterval = setInterval(
      () => {
        this.runLearningIteration();
      },
      intervalMinutes * 60 * 1000
    );
  }

  static stopLearningLoop(): void {
    if (this.learningInterval) {
      clearInterval(this.learningInterval);
      this.learningInterval = null;
    }
  }

  static async runLearningIteration(): Promise<void> {
    try {
      const { useSettingsStore } = await import("../stores/settingsStore");
      const settings = useSettingsStore.getState();
      const model = settings.awCleanupModel;

      if (!settings.awHasOpenRouterApiKey || !settings.awAutoLearningEnabled)
        return;

      const recentCorrections =
        await window.electronAPI.awGetRecentCorrections(7);
      const recentHistory = await window.electronAPI.awGetDictationHistory(50);
      const currentProfile = await window.electronAPI.awGetProfile();

      if (recentCorrections.length === 0 && recentHistory.length === 0) return;

      const systemPrompt = `You analyze dictation patterns to build a user profile. Extract facts about the user: names they mention, companies, tools, topics they discuss, communication style patterns. Output as JSON array: [{"key": "category", "value": "fact"}]. Categories: company, role, common_term, person, tool, topic, style_preference. Only output new facts not already in the existing profile.`;

      const userMessage = `Existing profile:\n${JSON.stringify(currentProfile.map((p: { key: string; value: string }) => ({ key: p.key, value: p.value })))}\n\nRecent corrections:\n${JSON.stringify(recentCorrections.map((c: { original_word: string; corrected_word: string; count: number }) => ({ from: c.original_word, to: c.corrected_word, count: c.count })))}\n\nRecent dictation samples:\n${recentHistory.slice(0, 20).map((h: { cleaned_text?: string; raw_transcript: string }) => h.cleaned_text || h.raw_transcript).join("\n---\n")}`;

      const result = await window.electronAPI.awRunCleanup({
        systemPrompt,
        userMessage,
        model,
        timeoutMs: 30000,
      });

      const content =
        result.status === "success" ? result.cleanedText : null;

      if (content) {
        try {
          const facts = JSON.parse(content);
          if (Array.isArray(facts)) {
            for (const { key, value } of facts) {
              if (key && value) {
                await window.electronAPI.awSaveProfileEntry(
                  key,
                  value,
                  "auto"
                );
              }
            }
          }
        } catch {
          // JSON parse failed — skip
        }
      }

      // Promote high-count corrections to profile
      for (const correction of recentCorrections) {
        if (correction.count >= 5) {
          await window.electronAPI.awSaveProfileEntry(
            "common_term",
            correction.corrected_word,
            "correction"
          );
        }
      }

      this.correctionsSinceLastLoop = 0;
    } catch {
      // Silently fail — learning is best-effort
    }
  }
}
