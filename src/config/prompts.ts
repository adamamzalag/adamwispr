import promptData from "./promptData.json";
import i18n, { normalizeUiLanguage } from "../i18n";
import { en as enPrompts, type PromptBundle } from "../locales/prompts";
import { getLanguageInstruction } from "../utils/languageSupport";

export const CLEANUP_PROMPT = promptData.CLEANUP_PROMPT;
export const FULL_PROMPT = promptData.FULL_PROMPT;
/** @deprecated Use FULL_PROMPT — kept for PromptStudio compat */
export const UNIFIED_SYSTEM_PROMPT = promptData.FULL_PROMPT;

export interface AdamWisprPromptData {
  profile?: Array<{ key: string; value: string }>;
  corrections?: Array<{ original: string; corrected: string; frequency: number }>;
  styleDescriptions?: Record<string, string>;
  formattingInstructions?: string;
  appName?: string;
  url?: string;
  pageTitle?: string;
  surroundingText?: string;
  category?: string;
}

function getPromptBundle(uiLanguage?: string): PromptBundle {
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");

  return {
    cleanupPrompt: t("cleanupPrompt", { defaultValue: enPrompts.cleanupPrompt }),
    fullPrompt: t("fullPrompt", { defaultValue: enPrompts.fullPrompt }),
    dictionarySuffix: t("dictionarySuffix", { defaultValue: enPrompts.dictionarySuffix }),
  };
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function maxEditsForLength(len: number): number {
  if (len <= 4) return 0;
  if (len <= 6) return 1;
  return 2;
}

function detectAgentName(transcript: string, agentName: string): boolean {
  const name = agentName.trim();
  if (!name || name.length < 2) return false;

  // Layer 1: Exact word-boundary match
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`, "i").test(transcript)) return true;

  // Layer 2: Space-normalized exact match (STT splitting compound names)
  const nameLower = name.toLowerCase().replace(/\s+/g, "");
  const words = transcript
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:'"()]/g, "").toLowerCase())
    .filter(Boolean);

  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] + words[i + 1] === nameLower) return true;
  }

  // Layer 3: Fuzzy Levenshtein match (STT mishearings)
  const maxEdits = maxEditsForLength(nameLower.length);
  if (maxEdits === 0) return false;

  for (const word of words) {
    if (
      Math.abs(word.length - nameLower.length) <= maxEdits &&
      levenshteinDistance(word, nameLower) <= maxEdits
    ) {
      return true;
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    const combined = words[i] + words[i + 1];
    if (
      Math.abs(combined.length - nameLower.length) <= maxEdits &&
      levenshteinDistance(combined, nameLower) <= maxEdits
    ) {
      return true;
    }
  }

  return false;
}

export function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  transcript?: string,
  uiLanguage?: string,
  adamWisprData?: AdamWisprPromptData
): string {
  const name = agentName?.trim() || "Assistant";
  const prompts = getPromptBundle(uiLanguage);

  let promptTemplate: string | null = null;
  if (typeof window !== "undefined" && window.localStorage) {
    const customPrompt = window.localStorage.getItem("customUnifiedPrompt");
    if (customPrompt) {
      try {
        promptTemplate = JSON.parse(customPrompt);
      } catch {}
    }
  }

  let prompt: string;
  if (promptTemplate) {
    prompt = promptTemplate.replace(/\{\{agentName\}\}/g, name);
  } else {
    const useFullPrompt = transcript ? detectAgentName(transcript, name) : false;
    prompt = (useFullPrompt ? prompts.fullPrompt : prompts.cleanupPrompt).replace(
      /\{\{agentName\}\}/g,
      name
    );
  }

  const langInstruction = getLanguageInstruction(language);
  if (langInstruction) {
    prompt += "\n\n" + langInstruction;
  }

  if (customDictionary && customDictionary.length > 0) {
    prompt += prompts.dictionarySuffix + customDictionary.join(", ");
  }

  const adamWisprAddendum = buildAdamWisprSystemAddendum(adamWisprData);
  if (adamWisprAddendum) {
    prompt += `\n\n${adamWisprAddendum}`;
  }

  return prompt;
}

export function buildAdamWisprSystemAddendum(data?: AdamWisprPromptData): string {
  if (!data) return "";

  const sections: string[] = [];

  const profile = data.profile?.filter(
    (entry) => entry?.key?.trim() && entry?.value?.trim()
  );
  if (profile && profile.length > 0) {
    sections.push(
      [
        "About the user:",
        ...profile.map((entry) => `- ${entry.key.trim()}: ${entry.value.trim()}`),
      ].join("\n")
    );
  }

  const corrections = data.corrections?.filter(
    (entry) => entry?.original?.trim() && entry?.corrected?.trim()
  );
  if (corrections && corrections.length > 0) {
    sections.push(
      [
        "When you see these words, correct them:",
        ...corrections.map(
          (entry) =>
            `- ${entry.original.trim()} -> ${entry.corrected.trim()}${
              Number.isFinite(entry.frequency) ? ` (frequency: ${entry.frequency})` : ""
            }`
        ),
      ].join("\n")
    );
  }

  const styleDescriptions = Object.entries(data.styleDescriptions ?? {}).filter(
    ([category, description]) => category.trim() && description.trim()
  );
  if (styleDescriptions.length > 0) {
    sections.push(
      [
        "Style guides by category:",
        ...styleDescriptions.map(
          ([category, description]) => `- ${category.trim()}: ${description.trim()}`
        ),
      ].join("\n")
    );
  }

  const formattingInstructions = data.formattingInstructions?.trim();
  if (formattingInstructions) {
    sections.push(`Formatting instructions:\n${formattingInstructions}`);
  }

  const surroundingText = isUsefulSurroundingText(data.surroundingText);
  const contextLines = [
    data.appName?.trim() ? `- App: ${data.appName.trim()}` : null,
    data.category?.trim() ? `- Category: ${data.category.trim()}` : null,
    data.url?.trim() ? `- URL: ${data.url.trim()}` : null,
    data.pageTitle?.trim() ? `- Page title: ${data.pageTitle.trim()}` : null,
    surroundingText ? `- Surrounding text: ${surroundingText}` : null,
  ].filter(Boolean);
  if (contextLines.length > 0) {
    sections.push(["Current dictation context:", ...contextLines].join("\n"));
  }

  return sections.join("\n\n");
}

export function isUsefulSurroundingText(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned) return null;
  // Filter out text that's mostly non-alphanumeric (terminal UI, box-drawing chars, etc.)
  const alphanumCount = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphanumCount / cleaned.length < 0.3) return null;
  return cleaned.slice(0, 300);
}

export function getWordBoost(customDictionary?: string[]): string[] {
  if (!customDictionary || customDictionary.length === 0) return [];
  return customDictionary.filter((w) => w.trim());
}

const DEFAULT_AGENT_SYSTEM_PROMPT =
  "You are a helpful voice assistant. Respond concisely and conversationally. " +
  "Keep answers brief unless the user asks for detail. " +
  "You may be given a transcription of spoken input, so handle informal phrasing gracefully.";

export function getAgentSystemPrompt(): string {
  if (typeof window !== "undefined" && window.localStorage) {
    const custom = window.localStorage.getItem("agentSystemPrompt");
    if (custom) return custom;
  }
  return DEFAULT_AGENT_SYSTEM_PROMPT;
}
