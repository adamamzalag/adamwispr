# AdamWispr — Revised Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Date:** 2026-03-17
**Replaces:** `2026-03-16-adamwispr-implementation.md` (original plan — architectural pivot)

**Goal:** Extend OpenWhispr's existing systems with personalization, context awareness, and quality-of-life features — NOT build parallel custom systems.

**Key Insight:** OpenWhispr already has a full AI cleanup pipeline (ReasoningService + prompts.ts + Intelligence settings UI). Instead of building our own CleanupService/openRouterClient/settings, we inject our context, profile, and style data into THEIR existing pipeline. Less code, faster, easier to maintain.

**Spec:** `docs/superpowers/specs/2026-03-16-adamwispr-design.md`

---

## Architecture Change Summary

| What | Old Approach | New Approach |
|------|-------------|--------------|
| AI Cleanup | Separate CleanupService → openRouterClient → OpenRouter | Extend OpenWhispr's ReasoningService + prompts.ts |
| API Key | Custom encrypted storage + AdamWispr settings UI | Use OpenWhispr's existing Intelligence API key settings |
| Model Selection | Custom dropdown in AdamWispr settings | Use OpenWhispr's existing Intelligence model selector |
| Context/Profile | Injected via our custom pipeline | Injected into OpenWhispr's existing prompt builder |
| Latency | Extra API call (~2.2s) on top of their pipeline | Single API call — our data rides along with theirs |

## What We Keep From Original Build

- Swift context helper binary (`resources/adamwispr-context-helper.swift`) — genuinely new
- ContextService (`src/services/ContextService.ts`) — app/URL/text detection
- NativeBridge (`src/services/NativeBridge.ts`) — native macOS API wrapper
- Database tables (corrections, user_profile, dictation_stats, dictation_history, app_categories, context_denylist)
- IPC handlers for database operations
- Seed data (17 app categories, 3 denylist entries)
- Settings for AdamWispr-specific features (learning, categories, styles — NOT model/API key)

## What We Retire

- `src/helpers/openRouterClient.js` — delete, use their ReasoningService instead
- `src/services/CleanupService.ts` — delete, extend their pipeline
- AdamWispr API key field in settings UI — use their Intelligence settings
- AdamWispr model selector in settings UI — use their Intelligence settings
- The `aw-run-cleanup` and `aw-auto-categorize` IPC handlers — use their existing API call path

---

## Phase 1: Integrate Into OpenWhispr's Pipeline

### Task 1: Understand & Hook Into ReasoningService

**Files to study:**
- `src/services/ReasoningService.ts` — the main AI cleanup service
- `src/services/BaseReasoningService.ts` — base class
- `src/config/prompts.ts` — prompt builder (getSystemPrompt, CLEANUP_PROMPT)
- `src/config/promptData.json` — raw prompt templates
- `src/hooks/useAudioRecording.js` — where cleanup is called

**Goal:** Find the exact point where the cleanup prompt is constructed and the API call is made. Inject our personalization data into THEIR prompt.

**IMPORTANT — prompt layer separation (from Codex review):**
- **System prompt (cacheable):** User profile, correction dictionary, style descriptions, formatting rules — these are STATIC between dictations
- **User message (per-dictation):** App name, URL, surrounding text, style category, raw transcript — these CHANGE every dictation
- Do NOT put dynamic context in the system prompt or it kills caching and leaks stale context

**Decision on OpenRouter/timeout:** We accept OpenWhispr's provider system and timeout behavior for now. Their Intelligence settings support OpenRouter via the "Custom" provider tab. If latency is still bad after the pivot, we revisit timeout/cancellation in Phase 3.

- [ ] **Step 1:** Read ReasoningService.ts and trace the full cleanup call path
- [ ] **Step 2:** Read prompts.ts — find where CLEANUP_PROMPT is assembled and where custom dictionary is injected
- [ ] **Step 3:** Identify TWO hook points:
  - System prompt: where to inject static personalization (profile, corrections, style descriptions)
  - User message: where to inject dynamic context (app name, URL, surrounding text, category)
- [ ] **Step 4:** Implement system prompt injection — modify prompts.ts `getSystemPrompt()` to include:
  - User profile entries (from user_profile table)
  - Top correction mappings (from corrections table)
  - Style descriptions per category
- [ ] **Step 5:** Implement user message injection — modify the point where raw transcript is sent to include:
  - App context (from ContextService): app name, URL, page title
  - Style category (Professional/Casual/Technical)
  - Surrounding text (if available and not denylisted)
- [ ] **Step 6:** Simplify useAudioRecording.js — remove our parallel processAndPaste wrapper. Instead:
  - Collect context before their cleanup call
  - Pass context to their prompt builder
  - Keep our post-paste hooks (save history, save stats, start correction monitoring, auto-categorize)
- [ ] **Step 7:** Test — dictate in different apps, verify context and profile appear, verify style adaptation

### Task 2: Wire Context Into Dictation Flow

Instead of our custom processAndPaste wrapper, inject context collection at the right point in their existing flow.

- [ ] **Step 1:** Before their cleanup call, collect context via ContextService
- [ ] **Step 2:** Pass context data to the prompt builder
- [ ] **Step 3:** Save dictation history + stats after paste (keep our DB tracking)
- [ ] **Step 4:** Start correction monitoring after paste (keep our learning)
- [ ] **Step 5:** Auto-categorize new apps (keep, but use their API call path)
- [ ] **Step 6:** Test full flow with context — dictate in Gmail, verify professional style; dictate in WhatsApp, verify casual style

---

### Task 3: Clean Up Retired Code

**IMPORTANT:** Only do this AFTER Tasks 1-2 are working and tested. Do not delete code that's still being used.

**Full retire list (from Codex review):**
- [ ] **Step 1:** Delete `src/helpers/openRouterClient.js`
- [ ] **Step 2:** Delete `src/services/CleanupService.ts`
- [ ] **Step 3:** Remove `aw-run-cleanup` and `aw-auto-categorize` IPC handlers from ipcHandlers.js
- [ ] **Step 4:** Remove corresponding preload bindings (`awRunCleanup`, `awAutoCategorize`)
- [ ] **Step 5:** Remove secure key storage: `aw-has-api-key`, `aw-set-api-key` IPC handlers, `_awGetApiKey` function, `_awReadSecureStore`, `_awWriteSecureStore`, `awKeyPath`
- [ ] **Step 6:** Remove preload bindings: `awHasApiKey`, `awSetApiKey`
- [ ] **Step 7:** Remove from settingsStore.ts: `awHasOpenRouterApiKey`, `awCleanupModel`, `awCleanupTimeout`, and their setters. Keep all other `aw*` settings.
- [ ] **Step 8:** Remove from SettingsPage.tsx: API key input + model selector from AdamWisprSection. Keep the section for other settings (categories, learning, styles).
- [ ] **Step 9:** Remove startup sync for `awHasOpenRouterApiKey` from initializeSettings()
- [ ] **Step 10:** Simplify LearningService.ts — use their ReasoningService for the background learning API call instead of `awRunCleanup`
- [ ] **Step 11:** Remove `src/config/adamwispr-prompts.ts` (our custom prompt builder — no longer needed, prompts.ts handles it)
- [ ] **Step 12:** Verify build, test dictation still works end-to-end
- [ ] **Step 13:** Commit with clear message about what was retired and why

---

## Phase 2: Complete Remaining Features

### Task 4: Wire Correction Learning

The LearningService and correction tracking infrastructure already exist. Wire them in.

- [ ] **Step 1:** Ensure corrections are being collected after paste (textEditMonitor integration)
- [ ] **Step 2:** Ensure corrections feed into the prompt (via prompts.ts injection from Task 1)
- [ ] **Step 3:** Start the background learning loop on app launch
- [ ] **Step 4:** Test — dictate, fix a word, verify it's learned, dictate again, verify the fix is applied

### Task 5: Clipboard Preservation

~50 lines. Infrastructure exists in NativeBridge.

- [ ] **Step 1:** Implement `aw-save-pasteboard` and `aw-restore-pasteboard` IPC handlers (using Electron clipboard API)
- [ ] **Step 2:** Wire into paste flow: save before paste, take post-paste fingerprint, restore after 500ms
- [ ] **Step 3:** Test — copy some text, dictate, verify original clipboard is restored

### Task 6: Hotkey Tap + Hold Mode

~200 lines. Extend existing hotkeyManager.

- [ ] **Step 1:** Add hold detection to the Globe key / hotkey handler
- [ ] **Step 2:** Use `awHoldThresholdMs` setting for timing (default 300ms)
- [ ] **Step 3:** Quick tap = toggle (start/stop), long hold = push-to-talk (record while held)
- [ ] **Step 4:** Test both modes

### Task 7: Usage Statistics

~200 lines. DB exists, need collection + UI.

- [ ] **Step 1:** Ensure dictation stats are saved after each dictation (word count, WPM, duration, app)
- [ ] **Step 2:** Create StatsView component matching OpenWhispr's settings design
- [ ] **Step 3:** Add Stats section to settings sidebar
- [ ] **Step 4:** Test — dictate several times, check stats page

### Task 8: AdamWispr Settings UI (Revised)

Smaller than before — only settings for OUR features, not duplicating their API/model settings.

- [ ] **Step 1:** Revise AdamWispr settings section to show:
  - Context settings (app categories table, denylist, auto-categorize mode)
  - Personalization (auto-learning toggle, profile viewer, corrections viewer)
  - Style descriptions per category (editable)
  - Feature toggles (clipboard preservation, text field tracking)
- [ ] **Step 2:** Remove API key and model selector (user configures those in Intelligence)
- [ ] **Step 3:** Test all settings controls

---

## Phase 3: Polish & Optimize

### Task 9: Latency Optimization

- [ ] **Step 1:** Measure baseline latency with their Intelligence pipeline (no custom overhead)
- [ ] **Step 2:** If still slow, test with Anthropic API key directly (bypassing OpenRouter) — compare latency
- [ ] **Step 3:** Investigate prompt caching effectiveness
- [ ] **Step 4:** Consider smaller/faster models for cleanup (GPT-4o-mini, Haiku)

### Task 10: Text Field Tracking (V1)

- [ ] **Step 1:** Capture frontmost app PID on recording start
- [ ] **Step 2:** Re-activate captured app before paste
- [ ] **Step 3:** Fallback: paste into current field if refocus fails

### Task 11: Integration Testing & Final Polish

- [ ] **Step 1:** Full end-to-end test checklist (all 8 features)
- [ ] **Step 2:** Fix any issues
- [ ] **Step 3:** Update docs, commit, push

---

## Summary

| Phase | Tasks | What It Delivers |
|-------|-------|-----------------|
| 1: Pipeline Integration | Tasks 1-3 | Hook into their pipeline, wire context, retire duplicate code |
| 2: Remaining Features | Tasks 4-8 | Corrections, clipboard, hotkeys, stats, settings |
| 3: Polish | Tasks 9-11 | Latency optimization, text field tracking, final testing |

**Total tasks:** 11 (down from 18)
**Key difference:** Extending existing code, not building parallel systems
**Task ordering:** Build first (Tasks 1-2), verify working, THEN delete old code (Task 3)
