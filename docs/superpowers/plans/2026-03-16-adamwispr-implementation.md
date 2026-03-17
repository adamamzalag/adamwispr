# AdamWispr Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork OpenWhispr and add 8 custom features: context awareness, style adaptation, smart formatting, personalized learning, clipboard preservation, text field tracking, usage statistics, and hotkey improvements.

**Architecture:** Fork of OpenWhispr (Electron + React + TypeScript). Direct integration approach with clean internal service boundaries (`ContextService`, `CleanupService`, `LearningService`, `NativeBridge`). Local transcription via Whisper.cpp/Parakeet, cloud cleanup via Claude Haiku 4.5 on OpenRouter.

**Security boundary:** The OpenRouter API key and all API calls live in the **main process only**. The renderer never receives the decrypted key. All cleanup/categorization requests go through IPC — the renderer sends transcript + context, the main process makes the API call and returns the result. This follows Electron's security best practices for context isolation.

**Tech Stack:** Electron 39, React 19, TypeScript, Zustand 5, SQLite (better-sqlite3), Tailwind CSS 4, shadcn/ui, OpenRouter API

**Spec:** `docs/superpowers/specs/2026-03-16-adamwispr-design.md`

**Important codebase conventions (from OpenWhispr):**
- React components (TSX/TS): `src/components/`
- Node.js helpers (JS): `src/helpers/`
- React hooks (TS): `src/hooks/`
- Zustand stores (TS): `src/stores/`
- Services (TS): `src/services/`
- IPC: `ipcMain.handle()` in `src/helpers/ipcHandlers.js`, expose in `preload.js`, call via `window.electronAPI.method()`
- Settings: Add to `src/stores/settingsStore.ts`, use via `useSettings()` hook
- i18n: `src/locales/{lang}/translation.json`

---

## Chunk 1: Fork Setup & Foundation

### Task 1: Fork and Rename

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml` or equivalent build config
- Modify: `src/components/` (any files referencing app name in UI)
- Modify: `main.js` (app title/name references)

- [ ] **Step 1: Fork the repo**

```bash
# On GitHub: Fork OpenWhispr/openwhispr to your account
# Then clone locally:
git clone https://github.com/AdamAmzalag/adamwispr.git ~/AdamWispr
cd ~/AdamWispr
git remote add upstream https://github.com/OpenWhispr/openwhispr.git
git remote set-url upstream --push no-push  # prevent accidental push to upstream
```

- [ ] **Step 2: Rename the app**

In `package.json`, change:
```json
{
  "name": "adamwispr",
  "productName": "AdamWispr",
  "description": "Personalized voice-to-text dictation"
}
```

Search and replace "OpenWhispr" with "AdamWispr" in:
- Window titles in `main.js`
- About/settings UI components
- Any user-facing strings in `src/locales/en/translation.json`

- [ ] **Step 3: Verify build works**

```bash
npm install
npm run dev
```

Expected: App launches with "AdamWispr" branding.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: fork OpenWhispr and rename to AdamWispr"
```

---

### Task 2: Add New SQLite Tables

**Files:**
- Modify: `src/helpers/database.js`
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`

- [ ] **Step 1: Add schema migrations to `database.js`**

Add to the database initialization section (after existing `CREATE TABLE IF NOT EXISTS` statements):

```sql
-- Dictation history (raw + cleaned pairs for learning)
CREATE TABLE IF NOT EXISTS dictation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_transcript TEXT NOT NULL,
  cleaned_text TEXT,
  app_context TEXT,
  style_category TEXT,
  cleanup_status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Correction mappings (learned from user edits)
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_word TEXT NOT NULL,
  corrected_word TEXT NOT NULL,
  app_context TEXT,
  count INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(original_word, corrected_word)
);

-- User profile (learned facts)
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT DEFAULT 'auto',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(key, value)
);

-- Dictation statistics
CREATE TABLE IF NOT EXISTS dictation_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_count INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  wpm REAL NOT NULL,
  app_context TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- App/URL category mappings
CREATE TABLE IF NOT EXISTS app_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT,
  url_pattern TEXT,
  category TEXT NOT NULL,
  auto_assigned INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(app_name, url_pattern)
);
-- NOTE: url_pattern uses empty string '' (not NULL) for app-only entries.
-- SQLite treats each NULL as unique, so UNIQUE(app_name, NULL) would create duplicates.

-- Context denylist
CREATE TABLE IF NOT EXISTS context_denylist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT,
  url_pattern TEXT,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Add CRUD functions for each table**

Add to `database.js`:

```javascript
// --- Dictation History ---
function saveDictationHistory(rawTranscript, cleanedText, appContext, styleCategory, cleanupStatus) {
  const stmt = db.prepare(`
    INSERT INTO dictation_history (raw_transcript, cleaned_text, app_context, style_category, cleanup_status)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(rawTranscript, cleanedText, appContext, styleCategory, cleanupStatus);
}

function getDictationHistory(limit = 50) {
  return db.prepare('SELECT * FROM dictation_history ORDER BY created_at DESC LIMIT ?').all(limit);
}

function pruneOldDictationHistory(retentionDays = 30) {
  return db.prepare('DELETE FROM dictation_history WHERE created_at < datetime("now", ? || " days")').run(`-${retentionDays}`);
}

// --- Corrections ---
function saveCorrection(originalWord, correctedWord, appContext) {
  const stmt = db.prepare(`
    INSERT INTO corrections (original_word, corrected_word, app_context)
    VALUES (?, ?, ?)
    ON CONFLICT(original_word, corrected_word)
    DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(originalWord, correctedWord, appContext);
}

function getCorrections(limit = 500) {
  return db.prepare('SELECT * FROM corrections ORDER BY count DESC, updated_at DESC LIMIT ?').all(limit);
}

function getRecentCorrections(sinceDays = 7) {
  return db.prepare('SELECT * FROM corrections WHERE updated_at > datetime("now", ? || " days") ORDER BY count DESC').all(`-${sinceDays}`);
}

function pruneOldCorrections(retentionDays = 90, maxEntries = 10000) {
  db.prepare('DELETE FROM corrections WHERE created_at < datetime("now", ? || " days")').run(`-${retentionDays}`);
  // Keep only top maxEntries by count
  db.prepare(`DELETE FROM corrections WHERE id NOT IN (SELECT id FROM corrections ORDER BY count DESC LIMIT ?)`).run(maxEntries);
}

// --- User Profile ---
function saveProfileEntry(key, value, source = 'auto') {
  const stmt = db.prepare(`
    INSERT INTO user_profile (key, value, source)
    VALUES (?, ?, ?)
    ON CONFLICT(key, value) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(key, value, source);
}

function getProfile() {
  return db.prepare('SELECT * FROM user_profile ORDER BY key').all();
}

function deleteProfileEntry(id) {
  return db.prepare('DELETE FROM user_profile WHERE id = ?').run(id);
}

// --- Dictation Stats ---
function saveDictationStats(wordCount, durationSeconds, wpm, appContext) {
  const stmt = db.prepare(`
    INSERT INTO dictation_stats (word_count, duration_seconds, wpm, app_context)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(wordCount, durationSeconds, wpm, appContext);
}

function getStats() {
  const allTime = db.prepare(`
    SELECT COUNT(*) as total_dictations, SUM(word_count) as total_words,
           AVG(wpm) as avg_wpm, SUM(duration_seconds) as total_duration
    FROM dictation_stats
  `).get();

  const today = db.prepare(`
    SELECT COUNT(*) as dictations, SUM(word_count) as words
    FROM dictation_stats WHERE date(created_at) = date('now')
  `).get();

  const thisWeek = db.prepare(`
    SELECT COUNT(*) as dictations, SUM(word_count) as words
    FROM dictation_stats WHERE created_at > datetime('now', '-7 days')
  `).get();

  const perApp = db.prepare(`
    SELECT app_context, COUNT(*) as dictations, SUM(word_count) as words
    FROM dictation_stats GROUP BY app_context ORDER BY words DESC LIMIT 20
  `).all();

  const streak = calculateStreak();

  return { allTime, today, thisWeek, perApp, streak };
}

function calculateStreak() {
  const days = db.prepare(`
    SELECT DISTINCT date(created_at) as day FROM dictation_stats
    ORDER BY day DESC LIMIT 365
  `).all();

  let streak = 0;
  const today = new Date().toISOString().split('T')[0];
  let expected = today;

  for (const { day } of days) {
    if (day === expected) {
      streak++;
      const d = new Date(expected);
      d.setDate(d.getDate() - 1);
      expected = d.toISOString().split('T')[0];
    } else {
      break;
    }
  }
  return streak;
}

// --- App Categories ---
function saveAppCategory(appName, urlPattern, category, autoAssigned = false) {
  const stmt = db.prepare(`
    INSERT INTO app_categories (app_name, url_pattern, category, auto_assigned)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(app_name, url_pattern) DO UPDATE SET category = ?, auto_assigned = ?
  `);
  return stmt.run(appName, urlPattern, category, autoAssigned ? 1 : 0, category, autoAssigned ? 1 : 0);
}

function getAppCategories() {
  return db.prepare('SELECT * FROM app_categories ORDER BY app_name').all();
}

function deleteAppCategory(id) {
  return db.prepare('DELETE FROM app_categories WHERE id = ?').run(id);
}

// --- Context Denylist ---
function saveDenylistEntry(appName, urlPattern, reason) {
  const stmt = db.prepare(`
    INSERT INTO context_denylist (app_name, url_pattern, reason) VALUES (?, ?, ?)
  `);
  return stmt.run(appName, urlPattern, reason);
}

function getDenylist() {
  return db.prepare('SELECT * FROM context_denylist ORDER BY app_name').all();
}

function deleteDenylistEntry(id) {
  return db.prepare('DELETE FROM context_denylist WHERE id = ?').run(id);
}
```

- [ ] **Step 3: Export all new functions**

Add to the module.exports at the bottom of `database.js`:

```javascript
module.exports = {
  // ... existing exports ...
  saveDictationHistory, getDictationHistory, pruneOldDictationHistory,
  saveCorrection, getCorrections, getRecentCorrections, pruneOldCorrections,
  saveProfileEntry, getProfile, deleteProfileEntry,
  saveDictationStats, getStats,
  saveAppCategory, getAppCategories, deleteAppCategory,
  saveDenylistEntry, getDenylist, deleteDenylistEntry,
};
```

- [ ] **Step 4: Add IPC handlers**

In `src/helpers/ipcHandlers.js`, add handlers for each database operation:

```javascript
// --- AdamWispr: Dictation History ---
ipcMain.handle('aw-save-dictation-history', (_, raw, cleaned, app, style, status) =>
  db.saveDictationHistory(raw, cleaned, app, style, status));
ipcMain.handle('aw-get-dictation-history', (_, limit) =>
  db.getDictationHistory(limit));

// --- AdamWispr: Corrections ---
ipcMain.handle('aw-save-correction', (_, original, corrected, app) =>
  db.saveCorrection(original, corrected, app));
ipcMain.handle('aw-get-corrections', (_, limit) =>
  db.getCorrections(limit));
ipcMain.handle('aw-get-recent-corrections', (_, days) =>
  db.getRecentCorrections(days));

// --- AdamWispr: Profile ---
ipcMain.handle('aw-save-profile-entry', (_, key, value, source) =>
  db.saveProfileEntry(key, value, source));
ipcMain.handle('aw-get-profile', () => db.getProfile());
ipcMain.handle('aw-delete-profile-entry', (_, id) =>
  db.deleteProfileEntry(id));

// --- AdamWispr: Stats ---
ipcMain.handle('aw-save-dictation-stats', (_, wordCount, duration, wpm, app) =>
  db.saveDictationStats(wordCount, duration, wpm, app));
ipcMain.handle('aw-get-stats', () => db.getStats());

// --- AdamWispr: App Categories ---
ipcMain.handle('aw-save-app-category', (_, app, url, cat, auto) =>
  db.saveAppCategory(app, url, cat, auto));
ipcMain.handle('aw-get-app-categories', () => db.getAppCategories());
ipcMain.handle('aw-delete-app-category', (_, id) =>
  db.deleteAppCategory(id));

// --- AdamWispr: Denylist ---
ipcMain.handle('aw-save-denylist-entry', (_, app, url, reason) =>
  db.saveDenylistEntry(app, url, reason));
ipcMain.handle('aw-get-denylist', () => db.getDenylist());
ipcMain.handle('aw-delete-denylist-entry', (_, id) =>
  db.deleteDenylistEntry(id));
```

- [ ] **Step 5: Expose in preload.js**

Add to the `electronAPI` object in `preload.js`:

```javascript
// --- AdamWispr APIs ---
awSaveDictationHistory: (raw, cleaned, app, style, status) =>
  ipcRenderer.invoke('aw-save-dictation-history', raw, cleaned, app, style, status),
awGetDictationHistory: (limit) =>
  ipcRenderer.invoke('aw-get-dictation-history', limit),
awSaveCorrection: (original, corrected, app) =>
  ipcRenderer.invoke('aw-save-correction', original, corrected, app),
awGetCorrections: (limit) =>
  ipcRenderer.invoke('aw-get-corrections', limit),
awGetRecentCorrections: (days) =>
  ipcRenderer.invoke('aw-get-recent-corrections', days),
awSaveProfileEntry: (key, value, source) =>
  ipcRenderer.invoke('aw-save-profile-entry', key, value, source),
awGetProfile: () =>
  ipcRenderer.invoke('aw-get-profile'),
awDeleteProfileEntry: (id) =>
  ipcRenderer.invoke('aw-delete-profile-entry', id),
awSaveDictationStats: (wordCount, duration, wpm, app) =>
  ipcRenderer.invoke('aw-save-dictation-stats', wordCount, duration, wpm, app),
awGetStats: () =>
  ipcRenderer.invoke('aw-get-stats'),
awSaveAppCategory: (app, url, cat, auto) =>
  ipcRenderer.invoke('aw-save-app-category', app, url, cat, auto),
awGetAppCategories: () =>
  ipcRenderer.invoke('aw-get-app-categories'),
awDeleteAppCategory: (id) =>
  ipcRenderer.invoke('aw-delete-app-category', id),
awSaveDenylistEntry: (app, url, reason) =>
  ipcRenderer.invoke('aw-save-denylist-entry', app, url, reason),
awGetDenylist: () =>
  ipcRenderer.invoke('aw-get-denylist'),
awDeleteDenylistEntry: (id) =>
  ipcRenderer.invoke('aw-delete-denylist-entry', id),
```

- [ ] **Step 6: Verify database tables are created**

```bash
npm run dev
# Check console for any database errors
# Open dev tools, run: await window.electronAPI.awGetStats()
# Expected: { allTime: { total_dictations: 0, ... }, ... }
```

- [ ] **Step 7: Commit**

```bash
git add src/helpers/database.js src/helpers/ipcHandlers.js preload.js
git commit -m "feat: add SQLite tables and IPC for AdamWispr features"
```

---

### Task 3: Add New Settings and Secure API Key Storage

**Files:**
- Modify: `src/stores/settingsStore.ts`
- Modify: `src/helpers/ipcHandlers.js` (secure API key storage + cleanup IPC stubs)
- Modify: `preload.js` (expose secure API key + cleanup IPC)
- Create: `src/helpers/openRouterClient.js` (main-process API client — stub, implemented in Task 8)

- [ ] **Step 1: Add AdamWispr settings to SettingsState interface**

Add to the `SettingsState` interface:

```typescript
// --- AdamWispr Settings ---
// AI Cleanup (NOTE: actual API key is in main process only — see Task 3 Step 3b)
awHasOpenRouterApiKey: boolean;  // boolean indicator, key lives in main process
awCleanupModel: string;
awCleanupTimeout: number;
// Context
awAutoCategorizeMode: 'auto' | 'ask';
awDefaultCategory: string;
// Style descriptions (JSON string of category -> description)
awStyleDescriptions: string;
// Formatting
awFormattingInstructions: string;
// Personalization
awAutoLearningEnabled: boolean;
awLearningFrequencyMinutes: number;
awLearningCorrectionThreshold: number;
awDictationHistoryRetentionDays: number;
// Features
awClipboardPreservation: boolean;
awTextFieldTracking: boolean;
// Hotkeys
awHoldThresholdMs: number;
// Stats
awTypingSpeedWpm: number;
```

- [ ] **Step 2: Add defaults and setters**

Add to the store initialization:

```typescript
// --- AdamWispr Defaults ---
// NOTE: awOpenRouterApiKey is NOT stored in Zustand. It lives in the main process only.
// The renderer can check if a key is set via awHasApiKey(), but never receives the actual key.
awHasOpenRouterApiKey: false, // true/false indicator only, set via IPC on init
awCleanupModel: localStorage.getItem('awCleanupModel') || 'anthropic/claude-haiku-4-5-20251001',
awCleanupTimeout: Number(localStorage.getItem('awCleanupTimeout')) || 3,
awAutoCategorizeMode: (localStorage.getItem('awAutoCategorizeMode') as 'auto' | 'ask') || 'auto',
awDefaultCategory: localStorage.getItem('awDefaultCategory') || 'Professional',
awStyleDescriptions: localStorage.getItem('awStyleDescriptions') || JSON.stringify({
  Professional: 'Proper capitalization, full punctuation, complete sentences, formal tone',
  Casual: 'Relaxed capitalization, lighter punctuation, natural conversational tone',
  Technical: 'Clear and direct, preserve technical terms exactly, no over-formatting',
}),
awFormattingInstructions: localStorage.getItem('awFormattingInstructions') || '',
awAutoLearningEnabled: localStorage.getItem('awAutoLearningEnabled') !== 'false',
awLearningFrequencyMinutes: Number(localStorage.getItem('awLearningFrequencyMinutes')) || 30,
awLearningCorrectionThreshold: Number(localStorage.getItem('awLearningCorrectionThreshold')) || 10,
awDictationHistoryRetentionDays: Number(localStorage.getItem('awDictationHistoryRetentionDays')) || 30,
awClipboardPreservation: localStorage.getItem('awClipboardPreservation') !== 'false',
awTextFieldTracking: localStorage.getItem('awTextFieldTracking') !== 'false',
awHoldThresholdMs: Number(localStorage.getItem('awHoldThresholdMs')) || 300,
awTypingSpeedWpm: Number(localStorage.getItem('awTypingSpeedWpm')) || 40,

// Setters
setAwOpenRouterApiKey: createStringSetter('awOpenRouterApiKey'),
setAwCleanupModel: createStringSetter('awCleanupModel'),
setAwCleanupTimeout: createNumericSetter('awCleanupTimeout'),
setAwAutoCategorizeMode: createStringSetter('awAutoCategorizeMode'),
setAwDefaultCategory: createStringSetter('awDefaultCategory'),
setAwStyleDescriptions: createStringSetter('awStyleDescriptions'),
setAwFormattingInstructions: createStringSetter('awFormattingInstructions'),
setAwAutoLearningEnabled: createBooleanSetter('awAutoLearningEnabled'),
setAwLearningFrequencyMinutes: createNumericSetter('awLearningFrequencyMinutes'),
setAwLearningCorrectionThreshold: createNumericSetter('awLearningCorrectionThreshold'),
setAwDictationHistoryRetentionDays: createNumericSetter('awDictationHistoryRetentionDays'),
setAwClipboardPreservation: createBooleanSetter('awClipboardPreservation'),
setAwTextFieldTracking: createBooleanSetter('awTextFieldTracking'),
setAwHoldThresholdMs: createNumericSetter('awHoldThresholdMs'),
setAwTypingSpeedWpm: createNumericSetter('awTypingSpeedWpm'),
```

- [ ] **Step 3b: Add encrypted API key storage via IPC**

The OpenRouter API key must be stored encrypted using Electron's `safeStorage` API and **never sent to the renderer process**. The renderer only knows whether a key is configured (boolean), and sends cleanup requests via IPC.

Add to `ipcHandlers.js`:

```javascript
const { safeStorage } = require('electron');
const Store = require('electron-store'); // or use existing env file approach
const secureStore = new Store({ name: 'adamwispr-secure' });

// Get decrypted key (main process internal use only)
function getApiKey() {
  const encrypted = secureStore.get('openRouterApiKey');
  if (!encrypted) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch { return ''; }
}

// Renderer can check if key is set, but never gets the actual key
ipcMain.handle('aw-has-api-key', () => {
  return !!getApiKey();
});

// Renderer sends key to store it, main process encrypts and saves
ipcMain.handle('aw-set-api-key', (_, key) => {
  if (!key) { secureStore.delete('openRouterApiKey'); return false; }
  const encrypted = safeStorage.encryptString(key).toString('base64');
  secureStore.set('openRouterApiKey', encrypted);
  return true;
});

// Main-process cleanup call — renderer sends transcript + context, main process calls OpenRouter
ipcMain.handle('aw-run-cleanup', async (_, { rawTranscript, context, corrections, profile,
    styleDescriptions, formattingInstructions, model, timeoutMs }) => {
  const apiKey = getApiKey();
  if (!apiKey) return { cleanedText: rawTranscript, status: 'error', errorMessage: 'No API key configured' };
  // (Full implementation in Task 8 — CleanupService runs in main process)
  // Uses apiKey internally, never exposes it
});

// Main-process auto-categorize call
ipcMain.handle('aw-auto-categorize', async (_, { appName, url, categories, model }) => {
  const apiKey = getApiKey();
  if (!apiKey) return 'Professional';
  // (Full implementation in Task 8)
});

// NOTE: Learning iterations reuse the 'aw-run-cleanup' IPC handler
// (same OpenRouter call pattern, just with a different prompt).
// No separate learning IPC needed.
```

Expose in `preload.js`:
```javascript
awHasApiKey: () => ipcRenderer.invoke('aw-has-api-key'),
awSetApiKey: (key) => ipcRenderer.invoke('aw-set-api-key', key),
awRunCleanup: (request) => ipcRenderer.invoke('aw-run-cleanup', request),
awAutoCategorize: (request) => ipcRenderer.invoke('aw-auto-categorize', request),
// Learning iterations reuse awRunCleanup — no separate IPC needed
```

In settings store initialization:
```typescript
// Check if key exists (boolean only):
const hasKey = await window.electronAPI.awHasApiKey();
set({ awHasOpenRouterApiKey: hasKey });
```

The setter updates main process and local boolean:
```typescript
setAwOpenRouterApiKey: async (key: string) => {
  const success = await window.electronAPI.awSetApiKey(key);
  set({ awHasOpenRouterApiKey: !!key && success });
},
```

Note: If `electron-store` is not a dependency, use OpenWhispr's existing `.env` file approach or a simple JSON file encrypted with `safeStorage`.

- [ ] **Step 3c: Add to storage type sets**

```typescript
// Add to BOOLEAN_SETTINGS
'awAutoLearningEnabled', 'awClipboardPreservation', 'awTextFieldTracking'

// Add to NUMERIC_SETTINGS
'awCleanupTimeout', 'awLearningFrequencyMinutes', 'awLearningCorrectionThreshold',
'awDictationHistoryRetentionDays', 'awHoldThresholdMs', 'awTypingSpeedWpm'
```

- [ ] **Step 4: Verify settings load**

```bash
npm run dev
# Open dev tools, check that settings load without errors
# Verify defaults are populated in localStorage
```

- [ ] **Step 5: Commit**

```bash
git add src/stores/settingsStore.ts src/helpers/ipcHandlers.js preload.js
git commit -m "feat: add AdamWispr settings and secure API key storage"
```

---

### Task 4: Create Internal Service Stubs

**Files:**
- Create: `src/services/ContextService.ts`
- Create: `src/services/CleanupService.ts`
- Create: `src/services/LearningService.ts`
- Create: `src/services/NativeBridge.ts`

- [ ] **Step 1: Create ContextService stub**

```typescript
// src/services/ContextService.ts

export interface AppContext {
  appName: string;
  url?: string;
  pageTitle?: string;
  surroundingText?: string;
  category: string;
  detectionLevel: 'url' | 'hostname' | 'title' | 'app-only';
  isDenylisted: boolean;
}

export class ContextService {
  /**
   * Get the current context for dictation cleanup.
   * Returns app name, URL (for browsers), surrounding text, and matched category.
   */
  static async getCurrentContext(): Promise<AppContext> {
    // TODO: Implement in Phase 2
    return {
      appName: 'Unknown',
      category: 'Professional',
      detectionLevel: 'app-only',
      isDenylisted: false,
    };
  }

  /**
   * Check if the current context is denylisted (no context should be sent).
   */
  static async isDenylisted(appName: string, url?: string): Promise<boolean> {
    // TODO: Implement in Phase 2
    return false;
  }

  /**
   * Auto-categorize a new app/URL using Haiku.
   */
  static async autoCategorize(appName: string, url?: string): Promise<string> {
    // TODO: Implement in Phase 3
    return 'Professional';
  }
}
```

- [ ] **Step 2: Create CleanupService stub**

```typescript
// src/services/CleanupService.ts

export interface CleanupRequest {
  rawTranscript: string;
  context: import('./ContextService').AppContext;
  corrections: Array<{ original: string; corrected: string }>;
  profile: Array<{ key: string; value: string }>;
  styleDescription: string;
  formattingInstructions: string;
}

export interface CleanupResult {
  cleanedText: string;
  status: 'success' | 'timeout' | 'error' | 'skipped';
  latencyMs: number;
}

// Model capability flags
const MODEL_CAPABILITIES: Record<string, { supportsCaching: boolean }> = {
  'anthropic/claude-haiku-4-5-20251001': { supportsCaching: true },
  'anthropic/claude-sonnet-4-6': { supportsCaching: true },
  'anthropic/claude-opus-4-6': { supportsCaching: true },
  'openai/gpt-4o-mini': { supportsCaching: false },
  'openai/gpt-4.1-mini': { supportsCaching: false },
};

export class CleanupService {
  /**
   * Send raw transcript to OpenRouter for AI cleanup.
   * Handles timeout, cancellation, caching, and fallback.
   */
  static async cleanup(request: CleanupRequest): Promise<CleanupResult> {
    // TODO: Implement in Phase 3
    return {
      cleanedText: request.rawTranscript,
      status: 'skipped',
      latencyMs: 0,
    };
  }

  /**
   * Check if the selected model supports prompt caching.
   */
  static supportsCaching(modelId: string): boolean {
    return MODEL_CAPABILITIES[modelId]?.supportsCaching ?? false;
  }

  /**
   * Cancel any in-flight cleanup request.
   */
  static cancelPending(): void {
    // TODO: Implement in Phase 3
  }
}
```

- [ ] **Step 3: Create LearningService stub**

```typescript
// src/services/LearningService.ts

export class LearningService {
  private static learningInterval: ReturnType<typeof setInterval> | null = null;
  private static pendingCorrections = 0;

  /**
   * Start monitoring for corrections after a paste.
   * Uses snapshot-and-diff with bounded context window.
   */
  static async startCorrectionMonitoring(
    pastedText: string,
    appContext: string
  ): Promise<void> {
    // TODO: Implement in Phase 4
  }

  /**
   * Stop monitoring for the current paste.
   */
  static stopCorrectionMonitoring(): void {
    // TODO: Implement in Phase 4
  }

  /**
   * Start the background learning loop.
   * Runs every N minutes or after M corrections.
   */
  static startLearningLoop(intervalMinutes: number, correctionThreshold: number): void {
    // TODO: Implement in Phase 4
  }

  /**
   * Stop the background learning loop.
   */
  static stopLearningLoop(): void {
    if (this.learningInterval) {
      clearInterval(this.learningInterval);
      this.learningInterval = null;
    }
  }

  /**
   * Run one iteration of the learning loop.
   * Reviews recent corrections and dictations, extracts profile data.
   */
  static async runLearningIteration(): Promise<void> {
    // TODO: Implement in Phase 4
  }
}
```

- [ ] **Step 4: Create NativeBridge stub**

```typescript
// src/services/NativeBridge.ts

export interface PasteboardState {
  items: Array<{ type: string; data: unknown }>;
  changeCount: number;
}

// Unified context result from Swift helper (matches Task 6 getContext() interface)
export interface NativeContext {
  appName: string;
  windowTitle: string | null;
  surroundingText: string | null;
  isSecureField: boolean;
  fieldRole: string | null;
  fieldSubrole: string | null;
}

export class NativeBridge {
  /**
   * Get full context via Swift helper (app name, window title, surrounding text, secure field check).
   * This is the PRIMARY context method — replaces individual getFrontmostApp/getSurroundingText/isSecureTextField.
   */
  static async getContext(): Promise<NativeContext> {
    // TODO: Implement in Phase 2 (Task 6)
    return { appName: 'Unknown', windowTitle: null, surroundingText: null,
             isSecureField: false, fieldRole: null, fieldSubrole: null };
  }

  /**
   * Get Chrome/Safari URL via AppleScript.
   */
  static async getBrowserUrl(appName: string): Promise<string | null> {
    // TODO: Implement in Phase 2 (Task 6)
    return null;
  }

  /**
   * Save the current pasteboard state.
   */
  static async savePasteboard(): Promise<PasteboardState> {
    // TODO: Implement in Phase 5
    return { items: [], changeCount: 0 };
  }

  /**
   * Restore a previously saved pasteboard state.
   */
  static async restorePasteboard(state: PasteboardState): Promise<boolean> {
    // TODO: Implement in Phase 5
    return false;
  }

  /**
   * Capture the currently focused text field reference for later refocusing.
   */
  static async captureFieldReference(): Promise<string | null> {
    // TODO: Implement in Phase 5
    return null;
  }

  /**
   * Refocus a previously captured text field.
   */
  static async refocusField(reference: string): Promise<boolean> {
    // TODO: Implement in Phase 5
    return false;
  }
}
```

- [ ] **Step 5: Verify services compile**

```bash
npm run dev
# Check for TypeScript errors
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ContextService.ts src/services/CleanupService.ts \
        src/services/LearningService.ts src/services/NativeBridge.ts
git commit -m "feat: add service stubs for ContextService, CleanupService, LearningService, NativeBridge"
```

---

### Task 5: Seed Default App Categories and Denylist

**Files:**
- Modify: `src/helpers/database.js` (add seed function)
- Modify: `main.js` (call seed on first run)

- [ ] **Step 1: Add seed function to database.js**

```javascript
function seedDefaultData() {
  const existingCategories = db.prepare('SELECT COUNT(*) as count FROM app_categories').get();
  if (existingCategories.count > 0) return; // Already seeded

  // Default app categories
  const categories = [
    // Professional
    { app: 'Microsoft Teams', url: '', category: 'Professional' },
    { app: 'Google Chrome', url: 'mail.google.com', category: 'Professional' },
    { app: 'Google Chrome', url: 'monday.com', category: 'Professional' },
    { app: 'Google Chrome', url: 'docs.google.com', category: 'Professional' },
    { app: 'Google Chrome', url: 'sheets.google.com', category: 'Professional' },
    { app: 'Microsoft Word', url: '', category: 'Professional' },
    { app: 'Microsoft Outlook', url: '', category: 'Professional' },
    // Casual
    { app: 'Google Chrome', url: 'web.whatsapp.com', category: 'Casual' },
    { app: 'Google Chrome', url: 'web.telegram.org', category: 'Casual' },
    { app: 'WhatsApp', url: '', category: 'Casual' },
    { app: 'Telegram', url: '', category: 'Casual' },
    // Technical
    { app: 'Terminal', url: '', category: 'Technical' },
    { app: 'iTerm2', url: '', category: 'Technical' },
    { app: 'Claude', url: '', category: 'Technical' },
    { app: 'Google Chrome', url: 'claude.ai', category: 'Technical' },
    { app: 'Cursor', url: '', category: 'Technical' },
    { app: 'Visual Studio Code', url: '', category: 'Technical' },
  ];

  const insertCat = db.prepare('INSERT OR IGNORE INTO app_categories (app_name, url_pattern, category) VALUES (?, ?, ?)');
  for (const c of categories) {
    insertCat.run(c.app, c.url, c.category);
  }

  // Default denylist
  const denylist = [
    { app: '1Password', url: '', reason: 'Password manager' },
    { app: 'Bitwarden', url: '', reason: 'Password manager' },
    { app: 'Keychain Access', url: '', reason: 'System credentials' },
  ];

  const insertDeny = db.prepare('INSERT OR IGNORE INTO context_denylist (app_name, url_pattern, reason) VALUES (?, ?, ?)');
  for (const d of denylist) {
    insertDeny.run(d.app, d.url, d.reason);
  }
}
```

- [ ] **Step 2: Call seed after database init**

Add `seedDefaultData()` call right after the table creation statements in the database initialization.

- [ ] **Step 3: Verify seed data**

```bash
npm run dev
# In dev tools: await window.electronAPI.awGetAppCategories()
# Expected: 17 entries with Professional, Casual, Technical categories
# In dev tools: await window.electronAPI.awGetDenylist()
# Expected: 3 entries (1Password, Bitwarden, Keychain Access)
```

- [ ] **Step 4: Commit**

```bash
git add src/helpers/database.js main.js
git commit -m "feat: seed default app categories and context denylist"
```

---

## Chunk 2: Context Awareness & Cleanup Pipeline

### Task 6: Implement NativeBridge — App & Context Detection

**Files:**
- Create: `resources/adamwispr-context-helper.swift`
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`
- Modify: `src/services/NativeBridge.ts`

**Architecture note:** Context detection (app name, surrounding text, secure field check) uses a **native Swift helper** compiled as a standalone binary, NOT `osascript`. AppleScript via `System Events` is unreliable for reading text field values and cannot detect secure text fields properly. The Swift helper uses `AXUIElement` APIs directly for fast, accurate results.

Browser URL detection still uses AppleScript since Chrome/Safari expose their URLs through their own AppleScript dictionaries (not Accessibility API).

- [ ] **Step 0: Check permissions and add onboarding**

Before any context features work, Accessibility and Automation permissions are required. Add permission detection:

```javascript
// In ipcHandlers.js:
const { systemPreferences } = require('electron');

ipcMain.handle('aw-check-permissions', () => {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    // Automation permission can't be checked programmatically —
    // it's granted per-app when first AppleScript call is made
  };
});

ipcMain.handle('aw-request-accessibility', () => {
  return systemPreferences.isTrustedAccessibilityClient(true); // Shows system prompt
});
```

Expose in `preload.js`:
```javascript
awCheckPermissions: () => ipcRenderer.invoke('aw-check-permissions'),
awRequestAccessibility: () => ipcRenderer.invoke('aw-request-accessibility'),
```

On first launch or when context settings are opened, check permissions and guide the user if missing. Without Accessibility, context features silently degrade (app name only, no surrounding text).

- [ ] **Step 1: Create Swift context helper**

Create `resources/adamwispr-context-helper.swift`:

```swift
// Standalone Swift binary for macOS context detection
// Communicates via stdout JSON, invoked by main process
// Usage: adamwispr-context-helper [command]
// Commands: get-context, get-field-info

import Cocoa
import ApplicationServices

struct ContextResult: Codable {
    let appName: String
    let windowTitle: String?
    let surroundingText: String? // capped at 500 chars
    let isSecureField: Bool
    let fieldRole: String?
    let fieldSubrole: String?
}

func getContext() -> ContextResult {
    let workspace = NSWorkspace.shared
    guard let frontApp = workspace.frontmostApplication else {
        return ContextResult(appName: "Unknown", windowTitle: nil,
                           surroundingText: nil, isSecureField: false,
                           fieldRole: nil, fieldSubrole: nil)
    }

    let appName = frontApp.localizedName ?? "Unknown"
    let pid = frontApp.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    // Get window title
    var windowTitle: String? = nil
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
       let window = windowRef {
        var titleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success {
            windowTitle = titleRef as? String
        }
    }

    // Get focused element info
    var focusedRef: CFTypeRef?
    var isSecure = false
    var surroundingText: String? = nil
    var fieldRole: String? = nil
    var fieldSubrole: String? = nil

    if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
       let focused = focusedRef as! AXUIElement? {

        // Check role and subrole
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &roleRef) == .success {
            fieldRole = roleRef as? String
        }
        var subroleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString, &subroleRef) == .success {
            fieldSubrole = subroleRef as? String
        }

        // Detect secure text fields (password inputs)
        isSecure = (fieldSubrole == "AXSecureTextField") || (fieldRole == "AXSecureTextField")

        // Only read value if not secure
        if !isSecure {
            var valueRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(focused, kAXValueAttribute as CFString, &valueRef) == .success {
                if let text = valueRef as? String {
                    // Cap at 500 chars, grab text near cursor if possible
                    if text.count <= 500 {
                        surroundingText = text
                    } else {
                        // Try to get selected range to grab nearby text
                        var rangeRef: CFTypeRef?
                        if AXUIElementCopyAttributeValue(focused, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
                           let rangeValue = rangeRef {
                            var range = CFRange()
                            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &range) {
                                let start = max(0, range.location - 250)
                                let end = min(text.count, range.location + 250)
                                let startIdx = text.index(text.startIndex, offsetBy: start)
                                let endIdx = text.index(text.startIndex, offsetBy: end)
                                surroundingText = String(text[startIdx..<endIdx])
                            }
                        }
                        if surroundingText == nil {
                            // Fallback: last 500 chars
                            surroundingText = String(text.suffix(500))
                        }
                    }
                }
            }
        }
    }

    return ContextResult(appName: appName, windowTitle: windowTitle,
                        surroundingText: surroundingText, isSecureField: isSecure,
                        fieldRole: fieldRole, fieldSubrole: fieldSubrole)
}

// Main
let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "get-context"

switch command {
case "get-context":
    let result = getContext()
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
default:
    print("{\"error\": \"unknown command\"}")
}
```

Compile the Swift helper:
```bash
swiftc -O resources/adamwispr-context-helper.swift -o resources/bin/adamwispr-context-helper
```

Add this to the build script so it's compiled during `npm run build`.

**IMPORTANT — Packaging:** Also add the compiled binary to electron-builder's resources configuration so it's included in production builds. In `electron-builder.yml` (or equivalent), add:
```yaml
extraResources:
  - from: "resources/bin/adamwispr-context-helper"
    to: "bin/adamwispr-context-helper"
```
Without this, the binary works in dev but is missing from packaged builds.

- [ ] **Step 2: Add main-process IPC handlers using Swift helper + AppleScript for browser URLs**

In `ipcHandlers.js`:

```javascript
const { exec, execFile } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const path = require('path');

// Path to compiled Swift helper (adjust for dev vs packaged)
function getContextHelperPath() {
  const devPath = path.join(__dirname, '../../resources/bin/adamwispr-context-helper');
  const prodPath = path.join(process.resourcesPath, 'bin/adamwispr-context-helper');
  return require('fs').existsSync(prodPath) ? prodPath : devPath;
}

// Native context detection via Swift helper (fast, reliable)
ipcMain.handle('aw-get-context', async () => {
  try {
    const { stdout } = await execFilePromise(getContextHelperPath(), ['get-context']);
    return JSON.parse(stdout.trim());
  } catch {
    return { appName: 'Unknown', windowTitle: null, surroundingText: null,
             isSecureField: false, fieldRole: null, fieldSubrole: null };
  }
});

// Browser URL detection via AppleScript (Chrome/Safari only)
ipcMain.handle('aw-get-browser-url', async (_, appName) => {
  try {
    let script = '';
    if (appName === 'Google Chrome') {
      script = `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`;
    } else if (appName === 'Safari') {
      script = `osascript -e 'tell application "Safari" to get URL of current tab of front window'`;
    } else {
      return null;
    }
    const { stdout } = await execPromise(script);
    return stdout.trim();
  } catch {
    return null;
  }
});
```

- [ ] **Step 2: Expose in preload.js**

```javascript
awGetContext: () => ipcRenderer.invoke('aw-get-context'),
awGetBrowserUrl: (appName) => ipcRenderer.invoke('aw-get-browser-url', appName),
```

- [ ] **Step 3: Implement NativeBridge methods**

Update `src/services/NativeBridge.ts` — all context comes from a single Swift helper call:

```typescript
interface NativeContext {
  appName: string;
  windowTitle: string | null;
  surroundingText: string | null;
  isSecureField: boolean;
  fieldRole: string | null;
  fieldSubrole: string | null;
}

static async getContext(): Promise<NativeContext> {
  return window.electronAPI.awGetContext();
}

static async getBrowserUrl(appName: string): Promise<string | null> {
  return window.electronAPI.awGetBrowserUrl(appName);
}
```

- [ ] **Step 4: Verify detection works**

```bash
npm run dev
# Focus Chrome with Gmail open
# In dev tools: await window.electronAPI.awGetContext()
# Expected: { appName: "Google Chrome", windowTitle: "Inbox - ...", surroundingText: "...", isSecureField: false, ... }
# In dev tools: await window.electronAPI.awGetBrowserUrl("Google Chrome")
# Expected: "https://mail.google.com/..."
```

- [ ] **Step 5: Commit**

```bash
git add src/services/NativeBridge.ts src/helpers/ipcHandlers.js preload.js
git commit -m "feat: implement NativeBridge app and browser detection"
```

---

### Task 7: Implement ContextService

**Files:**
- Modify: `src/services/ContextService.ts`

- [ ] **Step 1: Implement full ContextService**

```typescript
// src/services/ContextService.ts
import { NativeBridge } from './NativeBridge';

export interface AppContext {
  appName: string;
  url?: string;
  pageTitle?: string;
  surroundingText?: string;
  category: string;
  detectionLevel: 'url' | 'hostname' | 'title' | 'app-only';
  isDenylisted: boolean;
}

// Cache browser context to avoid polling on every dictation
// Keyed by app name so switching between Chrome and Safari doesn't return stale data
let cachedBrowserContext: { appName?: string; url?: string; title?: string; timestamp: number } = { timestamp: 0 };
const BROWSER_CACHE_TTL = 2000; // 2 seconds

const BROWSER_APPS = ['Google Chrome', 'Safari', 'Arc', 'Firefox', 'Microsoft Edge', 'Brave Browser'];

export class ContextService {
  static async getCurrentContext(): Promise<AppContext> {
    // Single native call for app name, window title, surrounding text, secure field check
    const native = await NativeBridge.getContext();
    const appName = native.appName;

    // Check denylist
    const isDenylisted = await this.isDenylisted(appName);
    const isSecure = native.isSecureField;

    if (isDenylisted || isSecure) {
      return {
        appName,
        category: await this.getCategory(appName),
        detectionLevel: 'app-only',
        isDenylisted: true,
      };
    }

    let url: string | undefined;
    let pageTitle: string | undefined;
    let detectionLevel: AppContext['detectionLevel'] = 'app-only';

    // Browser-specific detection with fallback chain
    if (BROWSER_APPS.includes(appName)) {
      const now = Date.now();
      const cacheValid = cachedBrowserContext.appName === appName &&
                         (now - cachedBrowserContext.timestamp) < BROWSER_CACHE_TTL;
      if (cacheValid) {
        url = cachedBrowserContext.url;
        pageTitle = cachedBrowserContext.title;
      } else {
        // Try URL first (AppleScript — Chrome/Safari only)
        url = (await NativeBridge.getBrowserUrl(appName)) ?? undefined;
        // Window title already from native context
        pageTitle = native.windowTitle ?? undefined;

        cachedBrowserContext = { appName, url, title: pageTitle, timestamp: now };
      }

      if (url) {
        detectionLevel = 'url';
        // Check URL against denylist
        if (await this.isUrlDenylisted(url)) {
          return {
            appName, url, pageTitle,
            category: await this.getCategory(appName, url),
            detectionLevel,
            isDenylisted: true,
          };
        }
      } else if (pageTitle) {
        // Try to extract hostname from title (many browsers include it)
        const hostnameMatch = pageTitle.match(/[-\w]+\.\w{2,}/);
        if (hostnameMatch) {
          detectionLevel = 'hostname';
        } else {
          detectionLevel = 'title';
        }
      }

      // Check for incognito/private browsing (specific patterns to avoid false positives)
      if (pageTitle?.endsWith(' - Incognito') || pageTitle?.endsWith(' — Private Browsing') || pageTitle?.startsWith('InPrivate')) {
        return {
          appName, pageTitle,
          category: await this.getCategory(appName),
          detectionLevel,
          isDenylisted: true,
        };
      }
    } else {
      // Non-browser: use window title from native context
      pageTitle = native.windowTitle ?? undefined;
      if (pageTitle) detectionLevel = 'title';
    }

    // Surrounding text already from native context (capped at 500 chars in Swift helper)
    let surroundingText: string | undefined;
    if (!isDenylisted && !isSecure) {
      surroundingText = native.surroundingText ?? undefined;
    }

    const category = await this.getCategory(appName, url);

    return {
      appName, url, pageTitle, surroundingText,
      category, detectionLevel, isDenylisted: false,
    };
  }

  static async isDenylisted(appName: string, url?: string): Promise<boolean> {
    const denylist = await window.electronAPI.awGetDenylist();
    return denylist.some((entry: any) =>
      (entry.app_name && appName.includes(entry.app_name)) ||
      (entry.url_pattern && url?.includes(entry.url_pattern))
    );
  }

  private static async isUrlDenylisted(url: string): Promise<boolean> {
    const denylist = await window.electronAPI.awGetDenylist();
    return denylist.some((entry: any) =>
      entry.url_pattern && url.includes(entry.url_pattern)
    );
  }

  static async getCategory(appName: string, url?: string): Promise<string> {
    const categories = await window.electronAPI.awGetAppCategories();

    // URL match first (more specific)
    if (url) {
      const urlMatch = categories.find((c: any) =>
        c.url_pattern && url.includes(c.url_pattern)
      );
      if (urlMatch) return urlMatch.category;
    }

    // App name match
    const appMatch = categories.find((c: any) =>
      c.app_name && !c.url_pattern && appName.includes(c.app_name)
    );
    if (appMatch) return appMatch.category;

    // Default
    const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();
    return settings.awDefaultCategory || 'Professional';
  }

  /**
   * Invalidate browser context cache (call on app/tab switch)
   */
  static invalidateCache(): void {
    cachedBrowserContext = { timestamp: 0 };
  }
}
```

- [ ] **Step 2: Verify context detection**

```bash
npm run dev
# Open Chrome to Gmail
# In dev tools:
# const { ContextService } = await import('./services/ContextService');
# await ContextService.getCurrentContext()
# Expected: { appName: 'Google Chrome', url: 'https://mail.google.com/...', category: 'Professional', ... }
```

- [ ] **Step 3: Commit**

```bash
git add src/services/ContextService.ts
git commit -m "feat: implement ContextService with browser detection and denylist"
```

---

### Task 8: Implement CleanupService — OpenRouter Integration

**Files:**
- Modify: `src/services/CleanupService.ts`
- Create: `src/config/adamwispr-prompts.ts`

- [ ] **Step 1: Create the default formatting/cleanup prompt**

```typescript
// src/config/adamwispr-prompts.ts

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
  corrections: Array<{ original_word: string; corrected_word: string; count: number }>,
  styleDescriptions: Record<string, string>,
  formattingInstructions: string,
): string {
  const parts: string[] = [];

  // Base instructions
  parts.push(formattingInstructions || DEFAULT_FORMATTING_INSTRUCTIONS);

  // User profile
  if (profile.length > 0) {
    parts.push('\n\n## About the speaker');
    const grouped: Record<string, string[]> = {};
    for (const { key, value } of profile) {
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(value);
    }
    for (const [key, values] of Object.entries(grouped)) {
      parts.push(`- ${key}: ${values.join(', ')}`);
    }
  }

  // Correction dictionary
  if (corrections.length > 0) {
    parts.push('\n\n## Known corrections (always apply these)');
    // Cap at ~50 most frequent corrections to stay under token budget
    const topCorrections = corrections.slice(0, 50);
    for (const { original_word, corrected_word } of topCorrections) {
      parts.push(`- "${original_word}" → "${corrected_word}"`);
    }
  }

  // Style descriptions
  if (Object.keys(styleDescriptions).length > 0) {
    parts.push('\n\n## Style categories');
    for (const [category, description] of Object.entries(styleDescriptions)) {
      parts.push(`- ${category}: ${description}`);
    }
  }

  // Enforce token budget (~2000 tokens ≈ ~8000 chars)
  let prompt = parts.join('\n');
  if (prompt.length > 8000) {
    prompt = prompt.substring(0, 8000) + '\n\n[Profile truncated to fit token budget]';
  }

  return prompt;
}

export function buildUserMessage(
  rawTranscript: string,
  category: string,
  appName: string,
  url?: string,
  pageTitle?: string,
  surroundingText?: string,
): string {
  const parts: string[] = [];

  parts.push(`Style: ${category}`);

  // Include the best context available (fallback chain: URL > title > app name)
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

  return parts.join('\n');
}
```

- [ ] **Step 2: Implement CleanupService**

**IMPORTANT:** The `CleanupService` in the renderer does NOT make API calls directly. It builds the prompt and delegates to the main process via IPC (`awRunCleanup`). The main process holds the API key and makes the actual `fetch()` call. This keeps the API key out of the renderer.

The main-process IPC handler for `aw-run-cleanup` (from Task 3 Step 3b) should be implemented in a new helper file `src/helpers/openRouterClient.js` that contains the actual fetch logic shown below. The renderer-side `CleanupService` constructs the request and calls IPC.

```typescript
// src/services/CleanupService.ts — RENDERER SIDE (no API key, no fetch)
import { buildSystemPrompt, buildUserMessage, DEFAULT_FORMATTING_INSTRUCTIONS } from '../config/adamwispr-prompts';
import type { AppContext } from './ContextService';

export interface CleanupRequest {
  rawTranscript: string;
  context: AppContext;
  corrections: Array<{ original_word: string; corrected_word: string; count: number }>;
  profile: Array<{ key: string; value: string }>;
  styleDescriptions: Record<string, string>;
  formattingInstructions: string;
}

export interface CleanupResult {
  cleanedText: string;
  status: 'success' | 'timeout' | 'error' | 'skipped';
  latencyMs: number;
  errorMessage?: string;
}

const MODEL_CAPABILITIES: Record<string, { supportsCaching: boolean; provider: string }> = {
  'anthropic/claude-haiku-4-5-20251001': { supportsCaching: true, provider: 'anthropic' },
  'anthropic/claude-sonnet-4-6': { supportsCaching: true, provider: 'anthropic' },
  'anthropic/claude-opus-4-6': { supportsCaching: true, provider: 'anthropic' },
  'openai/gpt-4o-mini': { supportsCaching: false, provider: 'openai' },
  'openai/gpt-4.1-mini': { supportsCaching: false, provider: 'openai' },
};

let pendingController: AbortController | null = null;

export class CleanupService {
  static async cleanup(request: CleanupRequest): Promise<CleanupResult> {
    const start = Date.now();

    // Build prompts in the renderer (no API key needed)
    const systemPrompt = buildSystemPrompt(
      request.profile,
      request.corrections,
      request.styleDescriptions,
      request.formattingInstructions,
    );

    const userMessage = buildUserMessage(
      request.rawTranscript,
      request.context.category,
      request.context.appName,
      request.context.isDenylisted ? undefined : request.context.url,
      request.context.isDenylisted ? undefined : request.context.pageTitle,
      request.context.isDenylisted ? undefined : request.context.surroundingText,
    );

    const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();

    if (!settings.awHasOpenRouterApiKey) {
      return {
        cleanedText: request.rawTranscript,
        status: 'error',
        latencyMs: Date.now() - start,
        errorMessage: 'OpenRouter API key not configured',
      };
    }

    try {
      // Delegate to main process via IPC — main process holds the API key
      // and makes the actual fetch() call with timeout and cancellation
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
    } catch (err: any) {
      return {
        cleanedText: request.rawTranscript,
        status: 'error',
        latencyMs: Date.now() - start,
        errorMessage: err.message,
      };
    }
  }

  static supportsCaching(modelId: string): boolean {
    return MODEL_CAPABILITIES[modelId]?.supportsCaching ?? false;
  }

  /**
   * Auto-categorize a new app/URL by asking the AI model.
   */
  static async autoCategorize(
    appName: string,
    url: string | undefined,
    existingCategories: string[],
  ): Promise<string> {
    const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();

    if (!settings.awHasOpenRouterApiKey) return settings.awDefaultCategory || 'Professional';

    try {
      // Delegate to main process via IPC (API key stays in main process)
      const category = await window.electronAPI.awAutoCategorize({
        appName,
        url,
        categories: existingCategories,
        model: settings.awCleanupModel,
      });
      return category || settings.awDefaultCategory || 'Professional';
    } catch {
      return settings.awDefaultCategory || 'Professional';
    }
  }
}
```

- [ ] **Step 2b: Implement main-process OpenRouter client**

Create `src/helpers/openRouterClient.js` in the main process. This file contains the actual `fetch()` calls to OpenRouter with the API key. It's called by the IPC handlers from Task 3 Step 3b.

```javascript
// src/helpers/openRouterClient.js — MAIN PROCESS ONLY
const MODEL_CAPABILITIES = {
  'anthropic/claude-haiku-4-5-20251001': { supportsCaching: true },
  'anthropic/claude-sonnet-4-6': { supportsCaching: true },
  'anthropic/claude-opus-4-6': { supportsCaching: true },
};

let pendingController = null;

async function runCleanup(apiKey, { systemPrompt, userMessage, model, timeoutMs }) {
  // Cancel any pending request
  if (pendingController) { pendingController.abort(); pendingController = null; }

  const controller = new AbortController();
  pendingController = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const capabilities = MODEL_CAPABILITIES[model] || { supportsCaching: false };

  try {
    // Build messages
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    // Add cache_control for Anthropic models
    // IMPORTANT: Verify exact format against https://openrouter.ai/docs/features/prompt-caching
    // before first deploy. The cache_control placement may differ from direct Anthropic API.
    if (capabilities.supportsCaching) {
      messages[0] = {
        role: 'system',
        content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      };
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://adamwispr.local',
        'X-Title': 'AdamWispr',
      },
      body: JSON.stringify({ model, messages, max_tokens: 2000, temperature: 0.1 }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown');
      return { cleanedText: '', status: 'error', errorMessage: `API error ${response.status}: ${errorBody}` };
    }

    const data = await response.json();
    const cleanedText = data.choices?.[0]?.message?.content?.trim();
    return { cleanedText: cleanedText || '', status: cleanedText ? 'success' : 'error', errorMessage: cleanedText ? undefined : 'Empty response' };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { cleanedText: '', status: 'timeout', errorMessage: `Timed out after ${timeoutMs}ms` };
    }
    return { cleanedText: '', status: 'error', errorMessage: err.message };
  } finally {
    pendingController = null;
  }
}

async function autoCategorize(apiKey, { appName, url, categories, model }) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 20, temperature: 0,
        messages: [{ role: 'user', content: `Categorize this app/website into one of these categories: ${categories.join(', ')}\n\nApp: ${appName}${url ? `\nURL: ${url}` : ''}\n\nReply with ONLY the category name.` }],
      }),
    });
    const data = await response.json();
    const cat = data.choices?.[0]?.message?.content?.trim();
    return (cat && categories.includes(cat)) ? cat : null;
  } catch { return null; }
}

module.exports = { runCleanup, autoCategorize };
```

Then update the IPC handlers in `ipcHandlers.js` — **REPLACE the stub handlers from Task 3 Step 3b** (do NOT add a second `ipcMain.handle` for the same channel — Electron throws if you register the same channel twice):
```javascript
const openRouter = require('./openRouterClient');

ipcMain.handle('aw-run-cleanup', async (_, request) => {
  const apiKey = getApiKey();
  if (!apiKey) return { cleanedText: '', status: 'error', errorMessage: 'No API key' };
  return openRouter.runCleanup(apiKey, request);
});

ipcMain.handle('aw-auto-categorize', async (_, request) => {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  return openRouter.autoCategorize(apiKey, request);
});
```

- [ ] **Step 3: Verify cleanup works**

```bash
npm run dev
# In dev tools:
# const { CleanupService } = await import('./services/CleanupService');
# await CleanupService.cleanup({
#   rawTranscript: "um so I wanted to talk about the uh shipbob integration for wicked cushions",
#   context: { appName: 'Google Chrome', category: 'Professional', detectionLevel: 'app-only', isDenylisted: false },
#   corrections: [{ original_word: 'shipbob', corrected_word: 'ShipBob', count: 3 }],
#   profile: [{ key: 'company', value: 'Wicked Cushions' }],
#   styleDescriptions: { Professional: 'Formal tone, full punctuation' },
#   formattingInstructions: '',
# })
# Expected: { cleanedText: "I wanted to talk about the ShipBob integration for Wicked Cushions.", status: 'success', ... }
```

- [ ] **Step 4: Commit**

```bash
git add src/services/CleanupService.ts src/config/adamwispr-prompts.ts
git commit -m "feat: implement CleanupService with OpenRouter, caching, timeout, and auto-categorization"
```

---

### Task 9: Wire Cleanup into Dictation Pipeline

**Files:**
- Modify: transcription completion handler (likely in `src/hooks/` or `src/components/` where paste is triggered)
- This task requires reading the existing code to find the exact hook point

- [ ] **Step 1: Identify the dictation completion hook**

Search for where transcription result is received and paste is triggered. Look in:
- `src/hooks/useAudioRecording.ts` or similar
- `src/components/ControlPanel.tsx` or similar
- `src/helpers/clipboard.js`

The integration point is: after Whisper/Parakeet returns text, before paste. We insert our cleanup call here.

- [ ] **Step 2: Insert cleanup call**

At the identified hook point, wrap the existing paste logic:

```typescript
import { ContextService } from '../services/ContextService';
import { CleanupService } from '../services/CleanupService';
import { useSettingsStore } from '../stores/settingsStore';

// After raw transcript is received from Whisper/Parakeet:
async function processAndPaste(rawTranscript: string, durationSeconds: number) {
  const settings = useSettingsStore.getState();

  // 1. Get context
  const context = await ContextService.getCurrentContext();

  // 2. Get personalization data
  const corrections = await window.electronAPI.awGetCorrections(500);
  const profile = await window.electronAPI.awGetProfile();
  const styleDescriptions = JSON.parse(settings.awStyleDescriptions || '{}');

  // 3. Run cleanup
  const result = await CleanupService.cleanup({
    rawTranscript,
    context,
    corrections,
    profile,
    styleDescriptions,
    formattingInstructions: settings.awFormattingInstructions,
  });

  // 4. Save to dictation history
  await window.electronAPI.awSaveDictationHistory(
    rawTranscript, result.cleanedText, context.appName, context.category, result.status
  );

  // 5. Save stats
  const wordCount = result.cleanedText.split(/\s+/).filter(Boolean).length;
  const wpm = durationSeconds > 0 ? (wordCount / durationSeconds) * 60 : 0;
  await window.electronAPI.awSaveDictationStats(wordCount, durationSeconds, wpm, context.appName);

  // 6. Show notification on non-success
  if (result.status === 'timeout') {
    // Show toast: "Cleanup timed out — raw text pasted"
  } else if (result.status === 'error') {
    // Show toast: result.errorMessage
  }

  // 7. Auto-categorize new apps (background, after paste)
  if (settings.awAutoCategorizeMode === 'auto') {
    const categories = await window.electronAPI.awGetAppCategories();
    const isKnown = categories.some((c: any) =>
      c.app_name === context.appName && (c.url_pattern === null || context.url?.includes(c.url_pattern))
    );
    if (!isKnown) {
      const existingCategoryNames = [...new Set(categories.map((c: any) => c.category))];
      CleanupService.autoCategorize(context.appName, context.url, existingCategoryNames).then(async (cat) => {
        await window.electronAPI.awSaveAppCategory(context.appName, context.url || '', cat, true);
        // Show toast: `Added ${context.appName} → ${cat}. Change in settings.`
      });
    }
  }

  // 8. Return cleaned text for paste
  return result.cleanedText;
}
```

- [ ] **Step 3: Test end-to-end flow**

```bash
npm run dev
# Set OpenRouter API key in settings
# Dictate into Chrome (Gmail)
# Verify: text is cleaned, category detected, history saved, stats recorded
```

- [ ] **Step 4: Commit**

```bash
git add [modified files]
git commit -m "feat: wire cleanup pipeline into dictation flow with context, stats, and auto-categorization"
```

---

## Chunk 3: Personalized Learning

### Task 10: Implement Correction Detection

**Files:**
- Modify: `src/services/LearningService.ts`
- Modify: `src/helpers/textEditMonitor.js` (extend existing monitoring)
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`

Note: Context detection (including surrounding text) uses `NativeBridge.getContext()` from Task 6.

- [ ] **Step 1: Implement correction detection in LearningService**

```typescript
// src/services/LearningService.ts
import { NativeBridge } from './NativeBridge';

interface PasteSnapshot {
  pastedText: string;
  fieldContentBefore: string; // bounded context window
  appContext: string;
  timestamp: number;
}

let currentSnapshot: PasteSnapshot | null = null;
let monitoringTimeout: ReturnType<typeof setTimeout> | null = null;

export class LearningService {
  private static learningInterval: ReturnType<typeof setInterval> | null = null;
  private static correctionsSinceLastLoop = 0;

  static async startCorrectionMonitoring(
    pastedText: string,
    appContext: string,
  ): Promise<void> {
    // Stop any existing monitoring
    this.stopCorrectionMonitoring();

    // Snapshot the field content (bounded context window)
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

    // Set timeout — stop monitoring after 60 seconds of no activity
    monitoringTimeout = setTimeout(() => {
      this.checkForCorrections();
    }, 60000);
  }

  static stopCorrectionMonitoring(): void {
    if (monitoringTimeout) {
      clearTimeout(monitoringTimeout);
      monitoringTimeout = null;
    }
    // If there was a pending snapshot, check for corrections before clearing
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

      // Find the pasted text region in the "after" content
      const pastedWords = snapshot.pastedText.split(/\s+/).filter(Boolean);
      const afterWords = fieldContentAfter.split(/\s+/).filter(Boolean);

      if (pastedWords.length === 0) return;

      // Size heuristic: calculate how much changed
      const beforeLength = snapshot.pastedText.length;
      // Find approximate pasted region in after content
      const diffRatio = Math.abs(fieldContentAfter.length - snapshot.fieldContentBefore.length) / beforeLength;

      // If > 70% changed, it's a redo — ignore
      if (diffRatio > 0.7) return;

      // Simple word-level diff between pasted text and current field content
      // Look for words that existed in pasted text but were changed
      const corrections = this.findWordCorrections(snapshot.pastedText, fieldContentAfter);

      for (const { original, corrected } of corrections) {
        // Skip single-character changes (likely typos unrelated to dictation)
        if (original.length <= 1 || corrected.length <= 1) continue;
        // Skip if words are identical (case change still counts)
        if (original === corrected) continue;

        await window.electronAPI.awSaveCorrection(original, corrected, snapshot.appContext);
        this.correctionsSinceLastLoop++;
      }

      // Check if we should trigger learning loop
      const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();
      if (this.correctionsSinceLastLoop >= settings.awLearningCorrectionThreshold) {
        this.runLearningIteration();
        this.correctionsSinceLastLoop = 0;
      }
    } catch {
      // Silently fail — correction monitoring is best-effort
    }
  }

  private static findWordCorrections(
    original: string,
    modified: string,
  ): Array<{ original: string; corrected: string }> {
    const origWords = original.split(/\s+/).filter(Boolean);
    const modWords = modified.split(/\s+/).filter(Boolean);
    const corrections: Array<{ original: string; corrected: string }> = [];

    // Simple positional comparison (works when changes are small)
    // For each word in original, check if the corresponding position in modified is different
    const minLen = Math.min(origWords.length, modWords.length);
    for (let i = 0; i < minLen; i++) {
      const origClean = origWords[i].replace(/[.,!?;:'"]/g, '').toLowerCase();
      const modClean = modWords[i].replace(/[.,!?;:'"]/g, '').toLowerCase();

      if (origClean !== modClean && origClean.length > 1) {
        corrections.push({
          original: origWords[i].replace(/[.,!?;:'"]/g, ''),
          corrected: modWords[i].replace(/[.,!?;:'"]/g, ''),
        });
      }
    }

    return corrections;
  }

  static startLearningLoop(intervalMinutes: number, correctionThreshold: number): void {
    this.stopLearningLoop();
    this.learningInterval = setInterval(() => {
      this.runLearningIteration();
    }, intervalMinutes * 60 * 1000);
  }

  static stopLearningLoop(): void {
    if (this.learningInterval) {
      clearInterval(this.learningInterval);
      this.learningInterval = null;
    }
  }

  static async runLearningIteration(): Promise<void> {
    try {
      const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();
      const model = settings.awCleanupModel;

      if (!settings.awHasOpenRouterApiKey || !settings.awAutoLearningEnabled) return;

      // Get recent data
      const recentCorrections = await window.electronAPI.awGetRecentCorrections(7);
      const recentHistory = await window.electronAPI.awGetDictationHistory(50);
      const currentProfile = await window.electronAPI.awGetProfile();

      if (recentCorrections.length === 0 && recentHistory.length === 0) return;

      // Ask Haiku to extract profile facts — via main process IPC (API key stays in main)
      const systemPrompt = `You analyze dictation patterns to build a user profile. Extract facts about the user: names they mention, companies, tools, topics they discuss, communication style patterns. Output as JSON array: [{"key": "category", "value": "fact"}]. Categories: company, role, common_term, person, tool, topic, style_preference. Only output new facts not already in the existing profile.`;

      const userMessage = `Existing profile:\n${JSON.stringify(currentProfile.map((p: any) => ({ key: p.key, value: p.value })))}\n\nRecent corrections:\n${JSON.stringify(recentCorrections.map((c: any) => ({ from: c.original_word, to: c.corrected_word, count: c.count })))}\n\nRecent dictation samples:\n${recentHistory.slice(0, 20).map((h: any) => h.cleaned_text || h.raw_transcript).join('\n---\n')}`;

      const result = await window.electronAPI.awRunCleanup({
        systemPrompt,
        userMessage,
        model,
        timeoutMs: 30000, // Learning is not latency-sensitive — 30s timeout
      });

      const content = result.status === 'success' ? result.cleanedText : null;

      if (content) {
        try {
          const facts = JSON.parse(content);
          if (Array.isArray(facts)) {
            for (const { key, value } of facts) {
              if (key && value) {
                await window.electronAPI.awSaveProfileEntry(key, value, 'auto');
              }
            }
          }
        } catch {
          // JSON parse failed — skip this iteration
        }
      }

      // Promote high-count corrections to profile
      for (const correction of recentCorrections) {
        if (correction.count >= 5) {
          await window.electronAPI.awSaveProfileEntry(
            'common_term',
            correction.corrected_word,
            'correction'
          );
        }
      }

      this.correctionsSinceLastLoop = 0;
    } catch {
      // Silently fail — learning is best-effort
    }
  }
}
```

- [ ] **Step 3: Wire correction monitoring into paste flow**

After paste in the dictation pipeline:
```typescript
import { LearningService } from '../services/LearningService';

// After paste completes:
if (settings.awAutoLearningEnabled) {
  LearningService.startCorrectionMonitoring(cleanedText, context.appName);
}
```

On new dictation start:
```typescript
// Before starting new recording:
LearningService.stopCorrectionMonitoring();
```

- [ ] **Step 4: Start learning loop on app launch**

In the renderer process (e.g., `App.tsx` or equivalent root component), add a React effect:
```typescript
import { LearningService } from '../services/LearningService';
import { useSettingsStore } from '../stores/settingsStore';

// In the root component:
useEffect(() => {
  const settings = useSettingsStore.getState();
  if (settings.awAutoLearningEnabled) {
    LearningService.startLearningLoop(
      settings.awLearningFrequencyMinutes,
      settings.awLearningCorrectionThreshold,
    );
  }
  return () => LearningService.stopLearningLoop();
}, []);
```

Note: `LearningService` runs in the renderer process since it needs access to `window.electronAPI` and the Zustand store. The learning loop makes background API calls and database updates via IPC.

- [ ] **Step 5: Test correction detection**

```bash
npm run dev
# Dictate something
# Edit a word in the pasted text
# Wait 60 seconds
# Check: await window.electronAPI.awGetCorrections()
# Expected: correction entry for the word you changed
```

- [ ] **Step 6: Commit**

```bash
git add src/services/LearningService.ts src/services/NativeBridge.ts \
        src/helpers/ipcHandlers.js preload.js
git commit -m "feat: implement correction detection and background learning loop"
```

---

## Chunk 4: Quality of Life Features

### Task 11: Clipboard Preservation

**Files:**
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`
- Modify: `src/services/NativeBridge.ts`
- Modify: dictation pipeline (where paste is called)

- [ ] **Step 1: Add pasteboard IPC handlers**

In `ipcHandlers.js`:

```javascript
const { clipboard, nativeImage } = require('electron');

ipcMain.handle('aw-save-pasteboard', () => {
  const items = [];
  // Read all available types
  const availableTypes = clipboard.availableFormats();

  for (const format of availableTypes) {
    if (format === 'text/plain') {
      items.push({ type: 'text/plain', data: clipboard.readText() });
    } else if (format === 'text/html') {
      items.push({ type: 'text/html', data: clipboard.readHTML() });
    } else if (format === 'text/rtf') {
      items.push({ type: 'text/rtf', data: clipboard.readRTF() });
    } else if (format === 'image/png' || format === 'image/jpeg') {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        items.push({ type: 'image/png', data: img.toPNG().toString('base64') });
      }
    }
    // File URLs — read as text (bookmark format)
    if (format.includes('file')) {
      try {
        const bookmark = clipboard.readBookmark();
        if (bookmark.url) {
          items.push({ type: 'file-url', data: bookmark });
        }
      } catch { /* not a bookmark */ }
    }
  }

  return {
    items,
    // Electron doesn't expose NSPasteboard.changeCount directly.
    // Use full text content as a fingerprint to detect clipboard changes.
    textFingerprint: clipboard.readText() ?? '',
    formatFingerprint: clipboard.availableFormats().join(','),
  };
});

ipcMain.handle('aw-take-post-paste-fingerprint', () => {
  // Call this IMMEDIATELY after paste. The paste itself changes the clipboard,
  // so we need a post-paste fingerprint to compare against later.
  return {
    textFingerprint: clipboard.readText() ?? '',
    formatFingerprint: clipboard.availableFormats().join(','),
  };
});

ipcMain.handle('aw-restore-pasteboard', (_, savedState, postPasteFingerprint) => {
  // Compare current clipboard against the POST-PASTE fingerprint (not the pre-paste one).
  // If they differ, the user copied something new during the window — don't overwrite.
  const currentText = clipboard.readText() ?? '';
  const currentFormats = clipboard.availableFormats().join(',');
  if (currentText !== postPasteFingerprint.textFingerprint ||
      currentFormats !== postPasteFingerprint.formatFingerprint) {
    // User copied something new — don't restore
    return false;
  }

  clipboard.clear();

  for (const item of savedState.items) {
    if (item.type === 'text/plain') {
      clipboard.writeText(item.data);
    } else if (item.type === 'text/html') {
      // Write both HTML and text
      clipboard.write({
        html: item.data,
        text: clipboard.readText(), // preserve text if already set
      });
    } else if (item.type === 'text/rtf') {
      clipboard.writeRTF(item.data);
    } else if (item.type === 'image/png') {
      const img = nativeImage.createFromBuffer(Buffer.from(item.data, 'base64'));
      clipboard.writeImage(img);
    } else if (item.type === 'file-url' && item.data?.url) {
      clipboard.writeBookmark(item.data.title || '', item.data.url);
    }
  }

  return true;
});
```

- [ ] **Step 2: Expose in preload.js**

```javascript
awSavePasteboard: () => ipcRenderer.invoke('aw-save-pasteboard'),
awTakePostPasteFingerprint: () => ipcRenderer.invoke('aw-take-post-paste-fingerprint'),
awRestorePasteboard: (state, postPasteFingerprint) => ipcRenderer.invoke('aw-restore-pasteboard', state, postPasteFingerprint),
```

- [ ] **Step 3: Wire into paste flow**

```typescript
// Before paste:
let savedPasteboard = null;
if (settings.awClipboardPreservation) {
  savedPasteboard = await window.electronAPI.awSavePasteboard();
}

// ... paste the dictated text ...

// Immediately after paste: take a post-paste fingerprint
// (The paste itself changes the clipboard, so we need this baseline)
let postPasteFingerprint = null;
if (savedPasteboard) {
  postPasteFingerprint = await window.electronAPI.awTakePostPasteFingerprint();
}

// After 500ms delay: restore original clipboard
if (savedPasteboard && postPasteFingerprint) {
  setTimeout(async () => {
    await window.electronAPI.awRestorePasteboard(savedPasteboard, postPasteFingerprint);
  }, 500);
}
```

- [ ] **Step 4: Test clipboard preservation**

```bash
npm run dev
# Copy some text to clipboard
# Dictate something
# After paste, wait 1 second
# Cmd+V — should paste the original copied text, not the dictation
```

- [ ] **Step 5: Commit**

```bash
git add src/helpers/ipcHandlers.js preload.js [pipeline files]
git commit -m "feat: implement clipboard preservation around dictation paste"
```

---

### Task 12: Text Field Tracking

**Files:**
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`
- Modify: dictation pipeline (hotkey activation + paste)

- [ ] **Step 1: Add field reference IPC handlers**

In `ipcHandlers.js`:

```javascript
const { BrowserWindow } = require('electron');

let capturedFieldApp = null; // Store the app bundle ID or name

ipcMain.handle('aw-capture-field-reference', async () => {
  try {
    const { stdout } = await execPromise(
      `osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'`
    );
    capturedFieldApp = stdout.trim();
    return capturedFieldApp;
  } catch {
    return null;
  }
});

ipcMain.handle('aw-refocus-captured-field', async () => {
  if (!capturedFieldApp) return false;

  try {
    // Activate the captured app
    await execPromise(
      `osascript -e 'tell application id "${capturedFieldApp}" to activate'`
    );
    // Small delay for app to come to front
    await new Promise(resolve => setTimeout(resolve, 150));
    capturedFieldApp = null;
    return true;
  } catch {
    capturedFieldApp = null;
    return false;
  }
});
```

- [ ] **Step 2: Expose in preload.js**

```javascript
awCaptureFieldReference: () => ipcRenderer.invoke('aw-capture-field-reference'),
awRefocusCapturedField: () => ipcRenderer.invoke('aw-refocus-captured-field'),
```

- [ ] **Step 3: Wire into dictation flow**

On hotkey press (recording start):
```typescript
if (settings.awTextFieldTracking) {
  await window.electronAPI.awCaptureFieldReference();
}
```

Before paste:
```typescript
if (settings.awTextFieldTracking) {
  const refocused = await window.electronAPI.awRefocusCapturedField();
  if (!refocused) {
    // Fallback: paste into current field, show notification
    // "Pasted into current field — original field was unavailable"
  }
}
```

**V1 scope: "Return to original app", not field-level tracking.** This captures the app-level reference (bundle ID) and re-activates that app before pasting. It does NOT capture or restore the specific text field within the app. For multi-field apps (e.g., Gmail with compose + search), the paste goes to whichever field the app focuses on re-activation — usually the last-focused field, but not guaranteed. For browsers this is optimistic since rerenders can change focus. Full `AXUIElement` path capture via the Swift helper could be added in v2 if this proves insufficient in practice.

- [ ] **Step 4: Test text field tracking**

```bash
npm run dev
# Click into a text field in any app (e.g., Notes)
# Start dictating
# While dictating, click into a different app (e.g., Finder)
# End dictation
# Verify: the original app (Notes) comes back to front and text is pasted there
# NOTE: This is app-level tracking, not field-level. The specific field within
# the app may vary if the app has multiple text fields.
```

- [ ] **Step 5: Commit**

```bash
git add src/helpers/ipcHandlers.js preload.js [pipeline files]
git commit -m "feat: implement text field tracking with refocus on paste"
```

---

### Task 13: Usage Statistics UI

**Files:**
- Create: `src/components/StatsView.tsx`
- Modify: `src/components/SettingsPage.tsx` (add Stats section/link)
- Modify: `src/locales/en/translation.json` (add i18n keys)

- [ ] **Step 1: Create StatsView component**

```tsx
// src/components/StatsView.tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Stats {
  allTime: { total_dictations: number; total_words: number; avg_wpm: number; total_duration: number };
  today: { dictations: number; words: number };
  thisWeek: { dictations: number; words: number };
  perApp: Array<{ app_context: string; dictations: number; words: number }>;
  streak: number;
}

export function StatsView() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [typingSpeed, setTypingSpeed] = useState(40);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    const data = await window.electronAPI.awGetStats();
    setStats(data);
    const settings = (await import('../stores/settingsStore')).useSettingsStore.getState();
    setTypingSpeed(settings.awTypingSpeedWpm);
  }

  if (!stats) return <div className="p-4">Loading...</div>;

  const timeSavedMinutes = stats.allTime.total_words
    ? Math.round(stats.allTime.total_words / typingSpeed)
    : 0;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-xl font-semibold">Dictation Statistics</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Today" value={`${stats.today.words || 0} words`} sub={`${stats.today.dictations || 0} dictations`} />
        <StatCard label="This Week" value={`${stats.thisWeek.words || 0} words`} sub={`${stats.thisWeek.dictations || 0} dictations`} />
        <StatCard label="All Time" value={`${stats.allTime.total_words || 0} words`} sub={`${stats.allTime.total_dictations || 0} dictations`} />
        <StatCard label="Streak" value={`${stats.streak} days`} sub="" />
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Avg WPM" value={`${Math.round(stats.allTime.avg_wpm || 0)}`} sub="words per minute" />
        <StatCard label="Time Saved" value={`~${timeSavedMinutes} min`} sub={`vs typing at ${typingSpeed} WPM`} />
      </div>

      {/* Per-app breakdown */}
      {stats.perApp.length > 0 && (
        <div>
          <h3 className="text-lg font-medium mb-2">Per App</h3>
          <div className="space-y-2">
            {stats.perApp.map((app) => (
              <div key={app.app_context} className="flex justify-between items-center p-2 bg-secondary/30 rounded">
                <span>{app.app_context || 'Unknown'}</span>
                <span className="text-muted-foreground">{app.words} words ({app.dictations} dictations)</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="p-4 rounded-lg bg-secondary/20 border">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Add Stats section to SettingsPage**

Add 'stats' to the `SettingsSectionType` type and add a sidebar navigation item. Render `<StatsView />` when the stats section is selected.

- [ ] **Step 3: Verify stats UI**

```bash
npm run dev
# Navigate to Settings > Stats
# Expected: Stats dashboard showing zeros (no dictations yet)
# Dictate a few things
# Refresh stats page — should show word counts, WPM, etc.
```

- [ ] **Step 4: Commit**

```bash
git add src/components/StatsView.tsx src/components/SettingsPage.tsx \
        src/locales/en/translation.json
git commit -m "feat: add usage statistics dashboard"
```

---

## Chunk 5: Hotkey Improvements & Settings UI

### Task 14: Dual-Mode Hotkey (Tap + Hold)

**Files:**
- Modify: `src/helpers/hotkeyManager.js`
- Modify: `src/stores/settingsStore.ts` (already added hold threshold setting)

- [ ] **Step 1: Modify hotkey handler for dual-mode**

In `hotkeyManager.js`, replace the existing activation mode logic:

```javascript
// Dual-mode: both tap-to-toggle and hold-to-talk on same key
let keyDownTimestamp = 0;
let isHolding = false;
const HOLD_THRESHOLD = 300; // ms, configurable via settings

function onHotkeyDown() {
  keyDownTimestamp = Date.now();
  isHolding = false;

  // Start a timer — if key is still held after threshold, enter hold mode
  setTimeout(() => {
    if (keyDownTimestamp > 0) {
      isHolding = true;
      // Start recording if not already
      if (!isRecording) {
        startRecording();
      }
    }
  }, HOLD_THRESHOLD);
}

function onHotkeyUp() {
  const heldDuration = Date.now() - keyDownTimestamp;
  keyDownTimestamp = 0;

  if (isHolding) {
    // Was hold-to-talk — stop recording on release
    isHolding = false;
    if (isRecording) {
      stopRecording();
    }
  } else if (heldDuration < HOLD_THRESHOLD) {
    // Was a tap — toggle recording
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }
}
```

Note: The exact integration depends on how `hotkeyManager.js` currently dispatches events. Read the existing code and adapt this logic to fit.

- [ ] **Step 2: Read hold threshold from settings**

```javascript
// In initialization:
const holdThreshold = settings.awHoldThresholdMs || 300;
```

- [ ] **Step 3: Test dual-mode**

```bash
npm run dev
# Quick tap the hotkey — should toggle recording on/off
# Hold the hotkey — should record while held, stop on release
# Both should work without changing any setting
```

- [ ] **Step 4: Commit**

```bash
git add src/helpers/hotkeyManager.js
git commit -m "feat: implement dual-mode hotkey (tap-to-toggle + hold-to-talk)"
```

---

### Task 14b: Extended Hotkey Support (L/R Modifiers, Single Keys, Permissions)

**Files:**
- Modify: `resources/macos-text-monitor.swift` or create new Swift helper
- Modify: `src/helpers/hotkeyManager.js`
- Modify: `src/components/` (hotkey settings UI)

- [ ] **Step 1: Extend Swift helper for L/R modifier distinction**

OpenWhispr's existing Swift helper (`resources/macos-text-monitor.swift`) uses `CGEvent` taps. Extend or create a new Swift helper that:

```swift
// Key concepts for L/R modifier detection:
// CGEvent.flags contains specific flags:
// - .maskCommand includes both, check kCGEventFlagMaskCommand
// - To distinguish left/right, check the raw keyCode:
//   - Left Command: keyCode 55, Right Command: keyCode 54
//   - Left Option: keyCode 58, Right Option: keyCode 61
//   - Left Shift: keyCode 56, Right Shift: keyCode 60
//   - Left Control: keyCode 59, Right Control: keyCode 62
// Use CGEventTapCreate with kCGEventKeyDown/kCGEventKeyUp to capture these
// Output events to stdout as JSON: {"key": "right-command", "event": "down"}
```

The Swift helper communicates with Electron via stdout (same pattern as existing `macos-text-monitor`). The `hotkeyManager.js` spawns this binary and parses its output.

- [ ] **Step 2: Add "press your desired key" capture UI**

In the hotkey settings section, add a capture mode:
```typescript
// When user clicks "Set Hotkey":
// 1. Show overlay: "Press the key you want to use..."
// 2. Listen for key events via the Swift helper
// 3. Display the captured key name
// 4. Save to settings on confirm
```

- [ ] **Step 3: Add permission detection and onboarding**

On first launch or when hotkey settings are opened:
```typescript
// Check accessibility permission
// Use the permission IPC from Task 6 Step 0 (already registered and exposed)
const permissions = await window.electronAPI.awCheckPermissions();
const hasAccessibility = permissions.accessibility;
if (!hasAccessibility) {
  // Show prompt: "AdamWispr needs Accessibility permission for hotkeys"
  // Include button to open System Settings > Privacy > Accessibility
}

// If using modifier-only keys and Input Monitoring is needed:
// Show additional prompt if required
```

IPC handler in `ipcHandlers.js`:
```javascript
const { systemPreferences } = require('electron');

// NOTE: Permission IPC handlers already registered in Task 6 Step 0
// ('aw-check-permissions' and 'aw-request-accessibility')
// Reuse those — do NOT register new handlers with different names.
```

- [ ] **Step 4: Add fallback binding**

If the requested hotkey can't be registered (permission denied, key not available):
```javascript
// In hotkeyManager.js:
// Try to register the user's preferred hotkey
// If it fails, fall back to Ctrl+Space and show notification:
// "Could not register [Right Command] as hotkey. Using Ctrl+Space instead. Grant Accessibility permission in System Settings."
```

- [ ] **Step 5: Commit**

```bash
git add resources/ src/helpers/hotkeyManager.js src/helpers/ipcHandlers.js preload.js
git commit -m "feat: extended hotkey support with L/R modifiers, key capture UI, and permission handling"
```

---

### Task 15: AdamWispr Settings UI

**Files:**
- Create: `src/components/AdamWisprSettings.tsx`
- Modify: `src/components/SettingsPage.tsx`

- [ ] **Step 1: Create AdamWispr settings component**

Create a settings component that covers all AdamWispr-specific settings organized into sections:

**AI section:** OpenRouter API key (password input), model selector dropdown, cleanup timeout slider, caching indicator

**Context section:** App category table (editable), auto-categorize toggle, URL pattern editor, context denylist editor

**Personalization section:** Auto-learning toggle, learning frequency controls, profile viewer (table with delete buttons), correction history viewer, dictation history retention slider

**Formatting section:** Editable text area for formatting instructions (with "Reset to Default" button), style descriptions per category (editable)

**General section:** Clipboard preservation toggle, text field tracking toggle, hold threshold slider

This component should use shadcn/ui components and match OpenWhispr's existing settings design patterns.

- [ ] **Step 2: Add AdamWispr sections to settings sidebar**

Add new sections to SettingsPage navigation:
- "AdamWispr" as a section header
- Sub-items: AI, Context, Personalization, Formatting, Stats

- [ ] **Step 3: Test settings UI**

```bash
npm run dev
# Navigate to Settings
# Verify all AdamWispr sections appear
# Test: enter API key, change model, toggle features
# Verify settings persist after app restart
```

- [ ] **Step 4: Commit**

```bash
git add src/components/AdamWisprSettings.tsx src/components/SettingsPage.tsx
git commit -m "feat: add AdamWispr settings UI for all custom features"
```

---

### Task 16: Data Pruning & Maintenance

**Files:**
- Modify: `main.js` (add pruning on app launch)

- [ ] **Step 1: Add pruning to app startup**

```javascript
// Run on app launch in main process — prune old data
// Read retention setting from localStorage (main process can access this via electron-store
// or by reading the same persistent storage the renderer uses)
const retentionDays = parseInt(localStorage?.getItem?.('awDictationHistoryRetentionDays') || '30', 10);
// NOTE: In main process, use the same persistence mechanism as settingsStore.
// If settings are stored in .env or electron-store, read from there.
// Do NOT import the Zustand store — it only exists in the renderer.

db.pruneOldDictationHistory(retentionDays);

// Prune old corrections (90 days, max 10k)
db.pruneOldCorrections(90, 10000);
```

- [ ] **Step 2: Commit**

```bash
git add main.js
git commit -m "feat: add data pruning on app startup"
```

---

### Task 17: Final Integration Testing & Polish

- [ ] **Step 1: End-to-end test checklist**

Test each feature in order:
1. Dictate into Chrome/Gmail → verify cleanup, professional style
2. Dictate into WhatsApp Web → verify casual style
3. Edit a pasted word → verify correction is captured
4. Check stats page → verify word count, WPM
5. Copy text, dictate, check clipboard → verify original clipboard is restored
6. Start dictating, switch windows, end → verify text goes to original field
7. Tap hotkey → verify toggle mode
8. Hold hotkey → verify hold mode
9. Check settings → verify all controls work
10. Restart app → verify settings and data persist

- [ ] **Step 2: Fix any issues found during testing**

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: AdamWispr v1.0 — all features integrated and tested"
```

---

## Summary

| Chunk | Tasks | What it delivers |
|-------|-------|-----------------|
| 1: Foundation | Tasks 1-5 | Fork, rename, database, settings (with encrypted API key), service stubs, seed data |
| 2: Context & Cleanup | Tasks 6-9 | App detection, browser URL, surrounding text, context awareness, OpenRouter cleanup pipeline with caching |
| 3: Learning | Task 10 | Correction detection, background learning loop, profile building |
| 4: Quality of Life | Tasks 11-13 | Clipboard preservation, text field tracking, usage stats UI |
| 5: Hotkeys & UI | Tasks 14-14b, 15-17 | Dual-mode hotkey, L/R modifiers, key capture UI, permission onboarding, settings UI, data pruning, integration testing |

**Total tasks:** 18
**Estimated implementation sessions:** 5-8 (one chunk per session is a good pace)

## Known Limitations & Future Improvements

- **Text field tracking:** V1 is app-level only (return to original app), not field-level. Could add `AXUIElement` path capture in the Swift helper for v2.
- **Correction detection:** Positional word comparison may miss corrections when words are inserted/deleted (not just changed). Could improve with LCS-based diffing in the native helper using bounded windows anchored to insertion point.
- **Ask-me-first categorization:** Settings has the toggle but the notification/prompt UI for "ask" mode is a TODO — auto mode works at launch.
- **Dictation history retry:** Spec mentions re-processing failed dictations from history — UI for this can be added to StatsView or a separate HistoryView later.
- **Caching indicator:** Spec mentions UI should show when caching is active — add to the AI settings section as a status badge.
- **OpenRouter prompt caching format:** The `cache_control` placement needs verification against OpenRouter's current docs before first deploy. Format may differ from direct Anthropic API. See: https://openrouter.ai/docs/features/prompt-caching
