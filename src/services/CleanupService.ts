// AdamWispr: AI cleanup service (renderer side)
// Builds prompts and delegates API calls to main process via IPC

import {
  buildSystemPrompt,
  buildUserMessage,
} from "../config/adamwispr-prompts";
import type { AppContext } from "./ContextService";

export interface CleanupRequest {
  rawTranscript: string;
  context: AppContext;
  corrections: Array<{
    original_word: string;
    corrected_word: string;
    count: number;
  }>;
  profile: Array<{ key: string; value: string }>;
  styleDescriptions: Record<string, string>;
  formattingInstructions: string;
}

export interface CleanupResult {
  cleanedText: string;
  status: "success" | "timeout" | "error" | "skipped";
  latencyMs: number;
  errorMessage?: string;
}

// Model capability flags
const MODEL_CAPABILITIES: Record<string, { supportsCaching: boolean }> = {
  "anthropic/claude-haiku-4.5": { supportsCaching: true },
  "anthropic/claude-sonnet-4.6": { supportsCaching: true },
  "anthropic/claude-opus-4.6": { supportsCaching: true },
  "openai/gpt-4o-mini": { supportsCaching: false },
  "openai/gpt-4.1-mini": { supportsCaching: false },
};

export class CleanupService {
  /**
   * Clean up raw transcript using AI model via main process IPC.
   * Renderer builds the prompt, main process makes the API call (holds the key).
   */
  static async cleanup(request: CleanupRequest): Promise<CleanupResult> {
    const start = Date.now();

    const systemPrompt = buildSystemPrompt(
      request.profile,
      request.corrections,
      request.styleDescriptions,
      request.formattingInstructions
    );

    const userMessage = buildUserMessage(
      request.rawTranscript,
      request.context.category,
      request.context.appName,
      request.context.isDenylisted ? undefined : request.context.url,
      request.context.isDenylisted ? undefined : request.context.pageTitle,
      request.context.isDenylisted ? undefined : request.context.surroundingText
    );

    const { useSettingsStore } = await import("../stores/settingsStore");
    const settings = useSettingsStore.getState();

    if (!settings.awHasOpenRouterApiKey) {
      return {
        cleanedText: request.rawTranscript,
        status: "error",
        latencyMs: Date.now() - start,
        errorMessage: "OpenRouter API key not configured",
      };
    }

    try {
      const result = await window.electronAPI.awRunCleanup({
        systemPrompt,
        userMessage,
        model: settings.awCleanupModel,
        timeoutMs: (settings.awCleanupTimeout || 3) * 1000,
      });

      return {
        cleanedText: result.cleanedText || request.rawTranscript,
        status: result.status,
        latencyMs: Date.now() - start,
        errorMessage: result.errorMessage,
      };
    } catch (err: unknown) {
      return {
        cleanedText: request.rawTranscript,
        status: "error",
        latencyMs: Date.now() - start,
        errorMessage: (err as Error).message,
      };
    }
  }

  static supportsCaching(modelId: string): boolean {
    return MODEL_CAPABILITIES[modelId]?.supportsCaching ?? false;
  }

  /**
   * Auto-categorize a new app/URL via AI model (main process IPC).
   */
  static async autoCategorize(
    appName: string,
    url: string | undefined,
    existingCategories: string[]
  ): Promise<string> {
    const { useSettingsStore } = await import("../stores/settingsStore");
    const settings = useSettingsStore.getState();

    if (!settings.awHasOpenRouterApiKey)
      return settings.awDefaultCategory || "Professional";

    try {
      const category = await window.electronAPI.awAutoCategorize({
        appName,
        url,
        categories: existingCategories,
        model: settings.awCleanupModel,
      });
      return category || settings.awDefaultCategory || "Professional";
    } catch {
      return settings.awDefaultCategory || "Professional";
    }
  }
}
