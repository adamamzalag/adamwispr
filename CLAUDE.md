# AdamWispr

Personalized fork of OpenWhispr for local voice-to-text dictation with AI-powered cleanup.

## Project Overview

AdamWispr is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT license) with 8 custom features added for personal use on Adam's MacBook Pro. Local transcription via Whisper.cpp/Parakeet, cloud cleanup via Claude Haiku 4.5 on OpenRouter.

## Key Documents

- **Design Spec:** `docs/superpowers/specs/2026-03-16-adamwispr-design.md`
- **Implementation Plan:** `docs/superpowers/plans/2026-03-16-adamwispr-implementation.md`

## Architecture

- **Tech Stack:** Electron 39, React 19, TypeScript, Zustand 5, SQLite, Tailwind CSS 4, shadcn/ui
- **Transcription:** Local (Whisper.cpp + Parakeet via sherpa-onnx)
- **AI Cleanup:** Claude Haiku 4.5 via OpenRouter (API key in main process only)
- **Internal Services:** ContextService, CleanupService, LearningService, NativeBridge
- **Native Context:** Swift helper binary using AXUIElement APIs

## Security Boundary

The OpenRouter API key lives in the **main process only**, encrypted via Electron's `safeStorage`. The renderer never receives the decrypted key. All API calls go through IPC.

## Fork Strategy

Option C (cherry-pick). We don't auto-sync with upstream OpenWhispr. We monitor their releases and cherry-pick or reimplement relevant fixes.

## Features Being Added

1. Context awareness (app + URL + surrounding text)
2. Style adaptation per app category
3. Smart formatting (full AI cleanup prompt)
4. Personalized learning (passive correction-based)
5. Clipboard preservation
6. Text field tracking
7. Usage statistics
8. Hotkey improvements (dual tap/hold, L/R modifiers)

## Development

```bash
npm install
npm run dev      # Development mode
npm run build    # Production build
```

## Conventions (Inherited from OpenWhispr)

- React components: `src/components/` (TSX)
- Helpers: `src/helpers/` (JS, main process)
- Hooks: `src/hooks/` (TS)
- Stores: `src/stores/` (Zustand, TS)
- Services: `src/services/` (TS)
- IPC pattern: `ipcMain.handle()` in ipcHandlers.js, expose in preload.js, call via `window.electronAPI.method()`
- All AdamWispr IPC channels prefixed with `aw-`
- All AdamWispr settings prefixed with `aw`
