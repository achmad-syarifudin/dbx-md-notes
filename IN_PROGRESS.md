# DBX MD Notes - English UI Migration Progress

## Status
Branch: `english-ui`  
Base repository: https://github.com/achmad-syarifudin/dbx-md-notes  
Goal: Full English UI for MD Notes plugin while keeping complete feature compatibility, valid manifest, and buildable `.dbxp` packages.

---

## 1. What Was Done

### A. Investigation of Localization Support
- Examined official DBX manifest schema (`manifest.schema.json`) and plugin host bridge (`pluginHostBridge.ts`).
- **Findings:**
  - DBX manifest supports `localizations` (`<locale>: { name, description, contributions: { ... } }`), which DBX uses for marketplace and connection provider forms.
  - DBX runtime exposes `dbxPlugin.locale` via its bridge SDK, but provides **no runtime UI translation catalog/engine** for iframe contents.
  - Introducing a complete dynamic i18n layer inside iframe HTML/JS would add excess complexity and risk regressions without official host primitives.
- **Decision:**
  - Standardized the core plugin UI strictly in clean, natural English.
  - Retained Chinese manifest metadata in `manifest.json` under `localizations["zh-CN"]` so Chinese DBX environments still see localized metadata where supported.

---

### B. Translated Source Files

1. **`manifest.json`**
   - Root name, description, connection fields (labels, descriptions, placeholders), option names, actions translated to English.
   - Preserved original Chinese metadata under `localizations["zh-CN"]`.
   - Preserved internal protocol IDs (`com.lwai.mdnotes.*`), `mdnotes://` scheme, config binding keys, version, permissions.

2. **`ui/index.html`**
   - Document title, navigation bars, buttons, empty state card, editor placeholders, status badges, AI panel views, target pickers, modals (new table note, AI settings), form labels, and options converted to English.
   - Changed `<html lang="zh-CN">` to `<html lang="en">`.

3. **`ui/app.js`**
   - User-facing strings translated:
     - Table design note generator template (`# Table design notes: ...`, column headers, sections).
     - Initial seed notes (`Welcome to AI.MD Notes`, `DBX tips`).
     - Tree context menu items, modals (prompt, confirm, move), toasts, and counters.
     - AI assistant mode tabs, tasks (`Analyze`, `Polish`, `Continue`, `Ask`), target summaries, preview tooltips, action buttons (`Insert at cursor`, `Replace selection`, `Append to end`, `Copy`).
     - AI configuration modal notices, test feedback, and reset warnings.
     - Status bar descriptions and boot diagnostic logs.
   - Backward compatibility preserved:
     - Regex for table note linking supports both English (`Table design: ...`) and existing Chinese notes (`表设计：...`).
     - Preserved `localeCompare` sort compatibility.

4. **`ui/storage.js`**
   - Diagnostic step names, error formatting, connection status texts, payload size checks, and `report()` headings/labels translated to English.
   - Preserved low-level storage protocol keys, RPC names, and disk formats (`.mdnotes/meta.json`, `prefs.json`, atomic writes).

5. **`backend/main.go`**
   - User-facing connection check messages, interface preference errors, backup validation/restore error messages, and table-link context messages translated to English.
   - Internal RPC handlers, route keys, and atomic file logic untouched.

6. **`backend/ai.go`**
   - Default persona system prompt translated to English.
   - Prompt templates for `analyze`, `polish`, `continue`, and `ask` translated to natural English.
   - User-facing error messages, HTTP status translations, and connection ping responses translated to English.
   - Preserved internal provider keys, JSON payloads, and token limits.

7. **`backend/ai_test.go`**
   - Assertions updated to match translated English prompt instructions and error strings (`Authentication failed`, `Could not parse`, `entire note`, `Ask`, etc.).
   - Multi-byte test inputs and note fixtures preserved.

8. **Build and Verification Scripts**
   - Updated `_buildpkg.js`, `_release.mjs`, and `_verify.mjs` to eliminate hardcoded Windows drive paths (`D:/...`) and support Linux/macOS cross-compilation.
   - Created `_testutil.mjs` helper for clean process spawning and tree removal across platforms.

---

## 2. Verified Checks
- `_domcheck.py` passed:
  - 0 dangling element attribute accesses.
  - 0 duplicate function declarations.
  - All critical UI elements present in `index.html`.

---

## 3. Next Steps (To Resume on Any Machine)

1. **Run Backend Unit Tests:**
   ```bash
   go test -v ./backend
   ```
2. **Build Sidecar Binaries & Package `.dbxp`:**
   ```bash
   node _release.mjs
   ```
   Or build local platform package:
   ```bash
   CGO_ENABLED=0 go build -C backend -o ../_xbuild/dbx-plugin-mdnotes-linux-amd64 .
   node _buildpkg.js --target linux-x64 --exe _xbuild/dbx-plugin-mdnotes-linux-amd64
   node _verify.mjs dist/com.lwai.mdnotes-0.8.4-linux-x64.dbxp
   ```
3. **Verify Package:**
   - Confirm generated `.dbxp` under `dist/`.
   - Inspect checksums and manifest executable paths.
