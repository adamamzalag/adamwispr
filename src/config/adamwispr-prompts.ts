// AdamWispr: System prompts for AI cleanup and formatting

export const DEFAULT_FORMATTING_INSTRUCTIONS = `You are a dictation cleanup assistant. Your job is to take raw speech-to-text output and produce clean, well-formatted text.

Rules:
- Fix grammar (subject-verb agreement, tense consistency, fragments) without changing meaning or voice
- Add proper punctuation (periods, commas, question marks) based on speech patterns
- Capitalize sentence starts and proper nouns
- Format numbers: "twenty five dollars" → "$25.00"
- Format dates: "march sixteenth" → "March 16"
- Format times: "five thirty pm" → "5:30 PM"
- Format emails: "adam at gmail dot com" → "adam@gmail.com"
- Format URLs: "google dot com" → "google.com"
- Create numbered lists when speaker says "first... second... third..." or similar
- Create bullet points for natural list cadence or "next point"
- Insert paragraph breaks for natural pauses or "new paragraph"
- Remove filler words: "um", "uh", "like" (as filler), "you know" (as filler)
- Handle self-corrections: "let's meet at 2... actually 3" → "let's meet at 3"
- Convert spoken punctuation: "comma" → ",", "period" → ".", "question mark" → "?"
- Preserve the speaker's voice and intent — clean up, don't rewrite

Output ONLY the cleaned text. No explanations, no quotes, no prefixes.`;

export function buildSystemPrompt(
  profile: Array<{ key: string; value: string }>,
  corrections: Array<{
    original_word: string;
    corrected_word: string;
    count: number;
  }>,
  styleDescriptions: Record<string, string>,
  formattingInstructions: string
): string {
  const parts: string[] = [];

  // Base instructions
  parts.push(formattingInstructions || DEFAULT_FORMATTING_INSTRUCTIONS);

  // User profile
  if (profile.length > 0) {
    parts.push("\n\n## About the speaker");
    const grouped: Record<string, string[]> = {};
    for (const { key, value } of profile) {
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(value);
    }
    for (const [key, values] of Object.entries(grouped)) {
      parts.push(`- ${key}: ${values.join(", ")}`);
    }
  }

  // Correction dictionary
  if (corrections.length > 0) {
    parts.push("\n\n## Known corrections (always apply these)");
    const topCorrections = corrections.slice(0, 50);
    for (const { original_word, corrected_word } of topCorrections) {
      parts.push(`- "${original_word}" → "${corrected_word}"`);
    }
  }

  // Style descriptions
  if (Object.keys(styleDescriptions).length > 0) {
    parts.push("\n\n## Style categories");
    for (const [category, description] of Object.entries(styleDescriptions)) {
      parts.push(`- ${category}: ${description}`);
    }
  }

  // Enforce token budget (~2000 tokens ≈ ~8000 chars)
  let prompt = parts.join("\n");
  if (prompt.length > 8000) {
    prompt =
      prompt.substring(0, 8000) +
      "\n\n[Profile truncated to fit token budget]";
  }

  return prompt;
}

export function buildUserMessage(
  rawTranscript: string,
  category: string,
  appName: string,
  url?: string,
  pageTitle?: string,
  surroundingText?: string
): string {
  const parts: string[] = [];

  parts.push(`Style: ${category}`);

  if (url) {
    parts.push(`App: ${appName} — ${url}`);
  } else if (pageTitle) {
    parts.push(`App: ${appName} — "${pageTitle}"`);
  } else {
    parts.push(`App: ${appName}`);
  }

  if (surroundingText) {
    parts.push(`\nSurrounding text (for context only):\n${surroundingText}`);
  }

  parts.push(`\nRaw dictation to clean up:\n${rawTranscript}`);

  return parts.join("\n");
}
