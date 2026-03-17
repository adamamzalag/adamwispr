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

      if (!settings.awAutoLearningEnabled)
        return;

      const recentCorrections =
        await window.electronAPI.awGetRecentCorrections(7);
      const recentHistory = await window.electronAPI.awGetDictationHistory(50);
      const currentProfile = await window.electronAPI.awGetProfile();

      if (recentCorrections.length === 0 && recentHistory.length === 0) return;

      // TODO: Wire learning cycle to use ReasoningService instead of retired awRunCleanup
      // The LLM-backed profile extraction step is intentionally disabled for now.

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
