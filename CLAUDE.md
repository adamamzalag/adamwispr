# AdamWispr

Personalized fork of OpenWhispr for local voice-to-text dictation with context awareness, personalization, and style adaptation.

## Project Overview

AdamWispr is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT license) that EXTENDS OpenWhispr's existing systems with 8 custom features. We do NOT build parallel systems — we inject our context, personalization, and style data into OpenWhispr's existing AI cleanup pipeline.

## Key Documents

- **Design Spec:** `docs/superpowers/specs/2026-03-16-adamwispr-design.md`
- **Implementation Plan (CURRENT):** `docs/superpowers/plans/2026-03-17-adamwispr-revised-plan.md`
- **Original Plan (SUPERSEDED):** `docs/superpowers/plans/2026-03-16-adamwispr-implementation.md`

## Architecture

- **Tech Stack:** Electron 39, React 19, TypeScript, Zustand 5, SQLite, Tailwind CSS 4, shadcn/ui
- **Transcription:** Local (Whisper.cpp + Parakeet via sherpa-onnx)
- **AI Cleanup:** OpenWhispr's existing Intelligence pipeline (ReasoningService + prompts.ts). User configures API key and model in Intelligence settings. We inject context + profile into their prompt.
- **Our Services:** ContextService (app/URL/text detection), LearningService (correction tracking), NativeBridge (Swift helper)
- **Native Context:** Swift helper binary (`adamwispr-context-helper`) using AXUIElement APIs

## Key Principle: Extend, Don't Replace

OpenWhispr already has:
- AI Text Enhancement (ReasoningService) — we add context/personalization to their prompts
- API key management (Intelligence settings) — we use theirs, not our own
- Model selection — we use theirs
- Text monitoring (textEditMonitor) — we extend for correction learning
- Hotkey system (hotkeyManager + Globe key) — we extend for tap/hold mode

We only build new things OpenWhispr genuinely doesn't have: context awareness, personalization, clipboard preservation, stats.

## Fork Strategy

Option C (cherry-pick). We don't auto-sync with upstream OpenWhispr. We monitor their releases and cherry-pick or reimplement relevant fixes.

## Features Being Added

1. **Context awareness** — app + URL + surrounding text (via Swift helper) — BUILT
2. **Style adaptation** — per-app category with different tone/formatting — PARTIALLY BUILT
3. **Smart formatting** — extended via OpenWhispr's existing cleanup prompt — IN PROGRESS
4. **Personalized learning** — passive correction-based profile building — BUILT (needs wiring)
5. **Clipboard preservation** — save/restore around paste — NEEDS BUILDING (~50 lines)
6. **Text field tracking** — refocus original app on paste — NEEDS BUILDING (~150 lines)
7. **Usage statistics** — dictation metrics + dashboard — NEEDS BUILDING (~200 lines)
8. **Hotkey improvements** — dual tap/hold mode — NEEDS BUILDING (~200 lines)

## Current Status (Mar 17, 2026)

**ARCHITECTURAL PIVOT:** Discovered OpenWhispr's Intelligence pipeline already does AI cleanup. Revised plan to extend their system instead of building parallel one. Retiring CleanupService, openRouterClient, custom API key/model UI.

**What's done:**
- Fork, rename, 6 DB tables, settings, IPC, seed data
- Swift context helper (app detection, surrounding text, secure field check)
- ContextService fully operational
- LearningService infrastructure ready
- Pipeline wiring (processAndPaste in useAudioRecording.js) — working but will be refactored to use their pipeline

**What's next:** Phase 1 of revised plan — hook into ReasoningService/prompts.ts, retire duplicate code, wire context into their flow.

## Development

```bash
npm install
npm run dev      # Development mode (auto-downloads sherpa-onnx)
npm run build    # Production build
```

## Conventions

- React components: `src/components/` (TSX)
- Helpers: `src/helpers/` (JS, main process)
- Hooks: `src/hooks/` (TS)
- Stores: `src/stores/` (Zustand, TS)
- Services: `src/services/` (TS)
- IPC pattern: `ipcMain.handle()` in ipcHandlers.js, expose in preload.js, call via `window.electronAPI.method()`
- AdamWispr IPC channels prefixed with `aw-`
- AdamWispr settings prefixed with `aw`
- **Extend OpenWhispr's files when possible, don't create parallel systems**
