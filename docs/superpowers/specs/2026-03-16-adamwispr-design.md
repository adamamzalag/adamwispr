# AdamWispr — Design Specification

**Date:** 2026-03-16
**Status:** Reviewed
**Author:** Adam Amzalag + Claude

## Overview

AdamWispr is a personalized fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT license), a cross-platform open-source voice-to-text dictation app. The fork adds deep personalization, context awareness, style adaptation, and quality-of-life improvements for personal use on Adam's MacBook Pro.

## Fork Strategy

**Option C — Cherry-Pick.** We do not auto-sync with upstream. We monitor OpenWhispr releases periodically, evaluate relevant bug fixes or improvements, and either cherry-pick specific commits or reimplement ideas within our codebase. Over time, the codebases may diverge significantly — that's expected and acceptable.

**Integration approach:** Direct integration (not modular plugins). New features are built directly into OpenWhispr's existing files and architecture. This keeps the app seamless and avoids the complexity of a plugin system, at the cost of more manual work when pulling upstream changes.

**Internal modularity:** While we don't use a plugin system, new feature code should be organized into clean internal services with stable interfaces:
- `ContextService` — app detection, URL detection, surrounding text capture
- `CleanupService` — OpenRouter API calls, prompt construction, caching logic
- `LearningService` — correction monitoring, profile updates, background learning loop
- `NativeBridge` — Swift helper communication, hotkey events, pasteboard operations

These are internal boundaries for maintainability and debuggability, not external plugin APIs.

## Architecture

### Transcription Layer (Local, Offline)

- **Whisper.cpp** — OpenAI Whisper models (tiny through turbo), already in OpenWhispr
- **NVIDIA Parakeet** — via sherpa-onnx, already in OpenWhispr, supports 25 languages
- User chooses their preferred model in settings. Both options retained.
- All audio stays on-device. No audio is sent to any cloud service.

### AI Cleanup Layer (Cloud via OpenRouter)

- **Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) as default
- **API:** OpenRouter (Adam's existing API key)
- **Prompt caching:** Enabled via OpenRouter's Anthropic provider route with `cache_control` breakpoints. System prompt (user profile, dictionary, style rules, formatting instructions) is cached. Real-time context (app, URL, surrounding text, raw transcript) is sent per-request in the user message. Cache TTL: 1 hour. Note: profile/dictionary updates from the learning loop invalidate the cache — learning loop frequency should balance personalization freshness vs. cache hit rate. **Important:** Prompt caching is Anthropic-specific. The `CleanupService` must maintain a per-model capability map — when a non-Anthropic model is selected (e.g., GPT-4o-mini), `cache_control` breakpoints are omitted from the request. The UI should indicate when caching is active vs. unavailable for the selected model.
- **Request timeout:** Hard deadline of **3 seconds** per cleanup request. If OpenRouter hasn't responded within 3 seconds, paste the raw transcription and show a notification: "Cleanup timed out — raw text pasted." Late responses are discarded.
- **Overlapping dictations:** If a new dictation starts while a cleanup request is in-flight, cancel the pending request. The new dictation takes priority.
- **Fallback on API failure:** If OpenRouter is unreachable, rate-limited, or API key is invalid, raw transcription (Whisper/Parakeet output) is pasted without cleanup. A notification informs the user.
- **Cost estimate:** ~$2.73-4.35/month at 100 dictations/day
- **Model is configurable in settings** — can switch to GPT-4o-mini, GPT-4.1 Mini, Sonnet, or any OpenRouter-supported model

### Personalization Layer (Local SQLite)

All personalization data stored locally on-device in SQLite (extending OpenWhispr's existing database).

### UI Layer

OpenWhispr's existing Electron + React + Tailwind UI is kept intact. New features add settings panels and views that match the existing design language. No stripping or rebuilding of existing UI.

## Feature Specifications

### Feature 1: Context Awareness

**Purpose:** Detect what app/site Adam is dictating into and provide that context to the AI cleanup model.

**Three detection layers:**

1. **App detection** — macOS Accessibility API returns the frontmost application name (e.g., "Google Chrome", "Microsoft Teams", "Slack"). OpenWhispr's `textEditMonitor` already has partial support for this.

2. **URL/title detection** — For browsers (Chrome primarily), read the page title and/or URL via Accessibility API or AppleScript. Distinguishes Gmail vs WhatsApp Web vs Monday.com when all are in Chrome. Requires macOS Automation permission (System Settings > Privacy > Automation) in addition to Accessibility. URL detection should be **async/pre-cached** — poll on app switch or tab switch events, not on dictation start — to avoid adding 50-200ms latency per dictation.

   **Browser detection fallback chain** (in priority order):
   1. Full URL via AppleScript (Chrome, Safari — requires Automation permission per browser)
   2. Hostname extracted from window title (many browsers include "site.com" in title)
   3. Window title only (available via Accessibility API for all apps)
   4. App name only (always available)

   Each level provides useful context even if deeper levels fail. The `ContextService` reports the deepest level it could reach so the cleanup prompt can adjust expectations.

   **Supported browser matrix** (at launch):
   | Browser | URL via AppleScript | Title via AX | Notes |
   |---------|-------------------|--------------|-------|
   | Google Chrome | Yes | Yes | Primary target |
   | Safari | Yes | Yes | |
   | Arc | Partial | Yes | AppleScript support varies |
   | Firefox | No | Yes | No AppleScript support |
   | Other Chromium | No | Yes | Fallback to title parsing |

3. **Surrounding text** — Read content near the cursor in the active text field via Accessibility API. Provides context like email subject lines, recipient names, or conversation history to the cleanup model.

**Privacy & context redaction:**
- **Secure text fields** (password inputs, `AXRole = AXSecureTextField`): never read surrounding text, never send context. Dictation still works but cleanup uses app name only.
- **Password manager apps** (1Password, Bitwarden, etc.): added to a default denylist — no context sent.
- **Incognito/private windows:** detected where possible (Chrome window title includes "Incognito"). Context suppressed for these windows.
- **Per-app/site denylist:** configurable in Settings > Context. User can add any app or URL pattern to "never send context" list.
- **What is NOT sent:** raw surrounding text is truncated to ~500 characters nearest the cursor. Full page content is never captured.

**Data flow:** All three layers feed into the user message portion of the Haiku API call (not cached, since it changes per dictation).

### Feature 2: Style Adaptation

**Purpose:** Automatically adjust dictation output tone and formatting based on which app/site is being used.

**Default categories:**

| Category | Apps/Sites | Style Description |
|----------|-----------|-------------------|
| Professional | Teams, Gmail, Monday.com, Google Sheets/Docs, Word | Proper capitalization, full punctuation, complete sentences |
| Casual | WhatsApp, Telegram | Relaxed capitalization, lighter punctuation, natural tone |
| Technical | Claude, Claude Code, Codex, Terminal | Clear and direct, preserve technical terms exactly, no over-formatting |
| Default | Everything else | Professional (configurable) |

**Auto-categorization of new apps/sites:**

When the app detects a new app or URL that hasn't been categorized:

1. **First dictation in the new app uses the Default category** (Professional unless changed)
2. After the dictation completes, a background call to Haiku: "What category does [app/URL] belong to?" with existing categories as options
3. Haiku assigns a category
4. The mapping is stored
5. A subtle notification appears: "Added Monday.com → Professional. Change in settings."
6. All subsequent dictations in that app use the assigned style

**Settings:**
- Toggle between auto-categorize (Option 1, default) and ask-me-first (Option 2)
- Add/edit/remove categories
- Reassign apps to different categories
- For Chrome-based apps, URL pattern matching (e.g., "mail.google.com" → Professional)
- Edit style descriptions per category (these become part of the system prompt)

### Feature 3: Smart Formatting

**Purpose:** Comprehensive AI-powered formatting of raw transcription output.

**Handled by the Haiku cleanup system prompt (not code logic):**

| Formatting | Example |
|-----------|---------|
| Auto-punctuation | Periods, commas, question marks from speech cadence |
| Auto-capitalization | Sentence starts, proper nouns |
| Grammar correction | Subject-verb agreement, tense consistency, fragments — without changing meaning or voice |
| Number formatting | "twenty five dollars" → "$25.00" |
| Date formatting | "march sixteenth twenty twenty six" → "March 16, 2026" |
| Time formatting | "five thirty pm" → "5:30 PM" |
| Email/URL detection | "adam at gmail dot com" → "adam@gmail.com" |
| Numbered lists | "first... second... third..." → 1. 2. 3. |
| Bullet lists | "next point" or natural list cadence → bullet points |
| Paragraph breaks | Natural pauses or "new paragraph" → line breaks |
| Filler removal | Strips "um", "uh", "like", "you know" |
| Self-corrections | "let's meet at 2... actually 3" → "let's meet at 3" |
| Spoken punctuation | "comma", "period", "question mark" → actual punctuation |

**Settings:** A text field where the formatting instructions can be edited directly, with a sensible default. This allows fine-tuning without code changes.

### Feature 4: Personalized Learning

**Purpose:** Passively learn Adam's vocabulary, preferences, and patterns from corrections — no manual configuration required.

**4-layer system:**

#### Layer 0: Dictation History

**New SQLite table: `dictation_history`**
- `id` — auto-increment primary key
- `raw_transcript` — what Whisper/Parakeet produced
- `cleaned_text` — what Haiku returned (null if cleanup failed/timed out)
- `app_context` — app name + URL/title at time of dictation
- `style_category` — which style was applied
- `cleanup_status` — success / timeout / error / skipped
- `created_at` — timestamp

**Retention:** 30 days by default (configurable). Used by the background learning loop to analyze dictation patterns and extract profile data. Also provides the "retry" capability — if cleanup failed, the user can re-process from history.

#### Layer 1: Correction Dictionary

**New SQLite table: `corrections`**
- `original_word` — what the system produced
- `corrected_word` — what Adam changed it to
- `app_context` — which app/URL this happened in
- `timestamp` — when
- `count` — how many times this correction has been made

**Correction detection algorithm:**

Primary approach: **Snapshot-and-diff with anchored context.** Full region-based boundary tracking is fragile across apps (offset shifts on any edit, poor Accessibility API support in some web apps). Instead:

1. After auto-paste, store the **exact inserted string** and, if available via Accessibility API, the **selected range / cursor position** at insertion point. Also snapshot a **bounded context window** (~200 characters before and after the paste point) from the field content.
2. After monitoring window closes, snapshot the same context window region again
3. Diff against the bounded window (not the entire field) to find word-level changes
4. Monitoring window closes when: (a) a new dictation starts, (b) the user switches apps, or (c) 60 seconds pass with no edits

**Size-based heuristic for correction vs. new typing:**
- If the diff shows changes that are **small relative to the dictation length** (< 30% of character count changed), treat changed words as corrections
- If the diff shows the dictation was mostly deleted or entirely rewritten (> 70% changed), treat it as a redo — ignore
- New text appended *after* the pasted content is ignored (not a correction)

**Fallback for inaccessible text fields:**
- Some apps (Electron-based, certain web apps) don't expose text field content via Accessibility API
- In these cases, correction monitoring is silently skipped for that dictation
- The feature degrades gracefully — personalization still works from other apps where monitoring succeeds

**Minimum change threshold:**
- Only word-level and phrase-level edits count as corrections
- Single character changes (typo fixes unrelated to dictation) are ignored

#### Layer 2: User Profile

**New SQLite table: `user_profile`**
- Key-value store of learned facts
- Examples: `{key: "company", value: "Wicked Cushions"}`, `{key: "role", value: "COO"}`, `{key: "common_term", value: "BSR"}`

#### Layer 3: Real-Time Context

Collected at dictation time (not stored long-term):
- Active app name
- URL/page title (for browsers)
- Surrounding text in the active field
- Matched style category

#### Layer 4: Background Learning Loop

A background process that runs periodically (every 30 minutes or after 10+ new corrections):
1. Reviews recent corrections and dictation content
2. Sends a batch to Haiku: "Here are recent corrections and dictations. Extract any new facts about this user — names, terms, companies, preferences, patterns."
3. Merges results into `user_profile` table
4. Deduplicates and updates existing entries
5. Model: Same Haiku instance (not latency-sensitive, cost negligible)

#### How It's Used Per Dictation

System prompt structure:
```
[CACHED — profile + dictionary + style rules + formatting instructions]
You are a dictation cleanup assistant for Adam, COO of Wicked Cushions...
Known terms: ShipBob, BSR, Wicked Cushions, Monday.com...
Correction history: "ship bob" → "ShipBob", "bee ess are" → "BSR"...
Style rules per category...
Formatting instructions...

[NOT CACHED — changes per dictation]
Current app: Google Chrome — Gmail (Category: Professional)
Surrounding text: "Re: Q1 Inventory Report — Hi Sarah,"
Raw transcription: [Whisper/Parakeet output]
```

**Settings UI:**
- View/edit learned profile entries
- View/clear correction history
- Toggle auto-learning on/off
- Adjust learning frequency (time interval and correction count threshold)

### Feature 5: Clipboard Preservation

**Purpose:** Dictation auto-paste shouldn't overwrite whatever Adam last copied.

**Flow:**
1. Before pasting dictated text, save the pasteboard contents via `NSPasteboardItem` enumeration and record `NSPasteboard.changeCount`
2. Paste the dictation via existing paste mechanism
3. After ~500ms, check `NSPasteboard.changeCount` — only restore if unchanged (prevents overwriting a new copy operation the user made during the window)
4. Restore saved pasteboard items

**Supported pasteboard types (best-effort restoration):**
- Plain text (`NSPasteboardTypeString`) — always
- Rich text / RTF (`NSPasteboardTypeRTF`, `NSPasteboardTypeHTML`) — always
- File URLs (`NSPasteboardTypeFileURL`) — always
- Images (`NSPasteboardTypeTIFF`, `NSPasteboardTypePNG`) — always
- **Not supported:** promise-based items (lazy file providers), app-specific private pasteboard types, security-scoped bookmarks. These are silently dropped during restore. This is a known limitation — the vast majority of clipboard content is covered by the supported types above.

**Edge cases:**
- If clipboard was empty, skip restore
- If `changeCount` changed during the window (user copied something new), do not restore — their new clipboard content takes priority
- If restoration is partial (some types couldn't be restored), restore what's available — partial is better than nothing

### Feature 6: Text Field Tracking

**Purpose:** Text pastes into the field Adam was in when he started recording, even if he clicks elsewhere during dictation.

**Flow:**
1. When hotkey is pressed to start recording, capture the currently focused text field reference (`AXUIElement`) and the owning app
2. During recording, Adam can click elsewhere (check reference, look at another window)
3. When recording ends and text is ready, attempt to refocus the original app and field, then paste
4. Lock releases after paste completes

**Fallback behavior:** Writing directly to an unfocused text field is unreliable on macOS (varies by app). Instead, the approach is:
1. **Try:** Bring the original app to front via `NSRunningApplication.activate`, then set focus to the saved field via Accessibility API, then paste normally
2. **If that fails** (field reference is stale, app redrew UI): paste into whatever field is currently focused and show a brief notification: "Pasted into current field — original field was unavailable"
3. **If no text field is focused at all:** copy to clipboard without pasting, show notification: "Dictation copied to clipboard"

### Feature 7: Usage Statistics

**Purpose:** Track and display dictation usage patterns.

**New SQLite table: `dictation_stats`**
- `word_count` — words in this dictation
- `duration_seconds` — how long the recording was
- `wpm` — words per minute (calculated)
- `app_context` — which app
- `timestamp`

**Stats UI (new section in app, matching existing design):**
- Total words dictated (all time, this week, today)
- Average WPM
- Dictation count
- Streak (consecutive days of use)
- Time saved estimate (words dictated ÷ assumed 40 WPM typing speed, configurable in settings)
- Per-app breakdown (which apps get the most dictation)

### Feature 8: Hotkey Improvements

**Purpose:** More flexible hotkey configuration than stock OpenWhispr.

**Dual-mode activation:**
- Same key supports both tap-to-toggle AND hold-to-talk simultaneously
- Differentiated by timing: hold ~300ms+ = hold mode; release before that = tap mode
- No need to choose between modes in settings — both always work

**Extended key support:**
- Single key binding (e.g., just right Alt — no modifier combo required)
- Left/right modifier distinction (left Command vs right Command as separate bindable keys)
- Full customization via "press your desired key" capture interface in settings

**Implementation note:** macOS doesn't natively distinguish left/right modifiers at the Electron level. OpenWhispr already has a Swift helper for Globe key support. This helper will be extended to capture left/right modifier events and expose them to the Electron app.

**Permissions & onboarding:**
- Modifier-only global hotkeys require **Accessibility** permission. The app should detect if the permission is missing and guide the user through granting it during initial setup.
- If **Input Monitoring** permission is also required (depends on signing and implementation of the event tap), include it in the onboarding flow.
- **Fallback binding:** If modifier-only capture fails (permission denied, unsigned app limitations), fall back to a safe default combo (e.g., Ctrl+Space) and notify the user that single-modifier binding requires additional permissions.

## Settings Persistence

All AdamWispr-specific settings are stored in OpenWhispr's existing settings infrastructure (Zustand store backed by `electron-store` or equivalent). New settings include:

**New SQLite tables (summary):**
- `dictation_history` — raw/cleaned transcript pairs, 30-day retention
- `corrections` — word-level correction mappings with frequency counts
- `user_profile` — learned facts key-value store
- `dictation_stats` — per-dictation metrics for usage statistics
- `app_categories` — app/URL → category mappings
- `context_denylist` — apps/URLs where context is never sent

**Stored in settings store (not SQLite):**
- OpenRouter API key (encrypted at rest via `safeStorage`)
- Selected model + model capability flags
- Style descriptions per category
- Formatting instructions (editable prompt text)
- Hotkey binding configuration
- Feature toggles (learning, clipboard preservation, text field tracking)
- Learning frequency, hold threshold, typing speed assumption

## Settings UI Summary

All new features have configurable settings, accessible within OpenWhispr's existing settings interface:

| Setting | Location | Default |
|---------|----------|---------|
| OpenRouter API key | Settings > AI | — (required) |
| Cleanup model | Settings > AI | Claude Haiku 4.5 |
| App categories | Settings > Context | Professional, Casual, Technical |
| App/URL → category mappings | Settings > Context | Auto-populated |
| Auto-categorization mode | Settings > Context | Auto (with option for ask-me-first) |
| Style descriptions per category | Settings > Context | Preset defaults |
| Formatting instructions | Settings > Formatting | Full default prompt |
| Auto-learning toggle | Settings > Personalization | On |
| Learning frequency | Settings > Personalization | Every 30 min or 10 corrections |
| Profile viewer/editor | Settings > Personalization | — |
| Correction history viewer | Settings > Personalization | — |
| Hotkey binding | Settings > Hotkeys | Existing OpenWhispr default |
| Hold threshold (ms) | Settings > Hotkeys | 300ms |
| Stats display | Settings > Stats | All enabled |
| Clipboard preservation toggle | Settings > General | On |
| Text field tracking toggle | Settings > General | On |
| Context denylist | Settings > Context | 1Password, Bitwarden (defaults) |
| Cleanup timeout (seconds) | Settings > AI | 3 |
| Dictation history retention (days) | Settings > Personalization | 30 |
| Typing speed for time-saved calc | Settings > Stats | 40 WPM |

## Required macOS Permissions

| Permission | Purpose | Required by |
|-----------|---------|-------------|
| **Accessibility** | Read focused app/field, surrounding text, paste simulation, hotkey event tap | Context awareness, text field tracking, correction monitoring, hotkeys |
| **Automation (per browser)** | Read Chrome/Safari URL and tab title via AppleScript | URL detection for context awareness |
| **Microphone** | Audio capture for transcription | Core dictation |
| **Input Monitoring** | May be required for modifier-only global hotkeys depending on signing | Hotkey improvements |
| **Screen Recording** | May be needed for system audio capture in meeting mode (inherited from OpenWhispr) | Meeting transcription |

The app should detect missing permissions on first launch and guide through an onboarding flow. If a permission is denied, affected features degrade gracefully with user notification.

## App Identity

- **Name:** AdamWispr
- **Branding:** Rename in menu bar, dock, window titles, about screen
- **Platform:** macOS only (Apple Silicon MacBook Pro)
- **Distribution:** Local build only, not published to any store

## Technical Stack (Inherited from OpenWhispr)

| Layer | Technology |
|-------|-----------|
| Framework | Electron v39 |
| Frontend | React 19, TypeScript, Tailwind CSS v4, Radix UI, shadcn/ui |
| State | Zustand |
| Local STT | whisper.cpp, sherpa-onnx (Parakeet) |
| Database | SQLite (better-sqlite3) |
| Native helpers | Swift (hotkey, Globe key — extended for L/R modifiers) |
| Build | electron-builder, Vite |
| AI API | OpenRouter (Claude Haiku 4.5 default) |

## Out of Scope (Not Building)

- Mobile apps (iOS/Android)
- Command Mode (select text → speak instruction to rewrite)
- Advanced voice commands ("delete last sentence", "undo")
- Custom voice macros/snippets
- Multi-user / team features
- Cloud sync of personalization data
- Fine-tuning a custom model

## Resolved Design Decisions

1. **Background learning loop timing:** Runs on schedule (every 30 min or 10 corrections) regardless of idle state, since it's a lightweight Haiku call.
2. **Correction history pruning:** Keep last 90 days or 10,000 entries (whichever is smaller). High-count corrections (≥5 occurrences) are promoted to the user profile dictionary and can be pruned from corrections table.
3. **System prompt size management:** Cap the system prompt at ~2,000 tokens of personalization data. When the profile + dictionary exceeds this, prioritize by correction frequency and recency. Rarely-triggered corrections are pruned first.

## Open Questions

1. Should stats be exportable (CSV/JSON)?
2. Optimal hold-vs-tap threshold — 300ms is the default but may feel sluggish for tap-to-toggle. May need user testing to calibrate (configurable in settings regardless).
