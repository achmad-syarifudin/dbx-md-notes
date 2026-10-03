# AI.MD NotesMarkdown Notes）

> DBX Plugin . Connection type Markdown Note desk

Make your notes. DBX One of them.**Connection Type**：New「AI.MD Notes」Connection → Open a stand-alone table (left directory tree) + Right Editor/A real-time preview.
The note drops as**Real under Storage Directory `.md` Documentation**，So in DBX I can edit it. DBX It can be opened with any editor. grep、Git。

---

## Functions

| Capacity | Annotations |
| --- | --- |
| Directory Tree | Folder = real subdirectories;support**Drag Move**（A whole subtree, renaming, right-click menu |
| Edit and Preview | Edit/Preview/column three views;no dependent Markdown Rendering (titles, lists, tables, references, tasklists, line codes...) |
| SQL Highlight | ` ```sql ` The code block is high-profile, it fits. DBX Database scene |
| Link to watch | 「New note for table」Connect Current/Add new notes to the table context and automatically generate field table skeletons |
| Search | Title + Full text search |
| Import/Export | Export One Part `.md`、Export Folder As zip —— It's the host.「Save As」，**You pick the directories and file names.** |
| Backup/Restore | One-key backup all (zip，Includes configuration and directory tree index) from backup**Restore original**Level and Title |
| **AI Assistant** | **persistent right sidebar**：Default**Chat**Mode (pure dialogue); to**Create**Mode allows you to assign an object to the analysis and to take notes**Analysis, refinement, continuation, questions and answers**，Result supports insertion/Replace/Append/copying;model parameters go independent configuration frames (see [AI Assistant](#ai-Assistant)） |
| Resizeable | Contents / Note area / AI Between districts.**Drag Separator**Widening, double-buttoned bits; width recorder (see [AI Assistant](#ai-Assistant)） |
| Delete Security | Delete access to the trash instead of destruction; multiple connections to share the same directory without covering each other (see[Data security](#Data security)） |
| File System | Project the notes. `mdnotes://` Virtual file system. DBX General File Manager Browser/Edit |
| Theme | Follow host's dark theme |

**Shortcut**：`Ctrl/Cmd+S` Save... `Ctrl/Cmd+N` New Note... `Ctrl/Cmd+I` Open AI Assistant Bar ()AI Column Focus)`Ctrl/Cmd+Enter` Carry out current tasks `/` Focus search. `Esc` Close the dialog.

---

## AI Assistant

AI The assistant is...**Right Bar Persistence Panel**，Two models:

| Mode | Purpose | What's on the interface? |
| --- | --- | --- |
| **Chat**（Default) | Pure conversation: Only words you write.**No notes.** | An input box + 「Send」，Only the results.「Copy」 |
| **Create** | Processing notes: analysis / Polish / Continue writing / Question. I can write back my notes. | 「Analysis target」+ Task tab with four writebacks for each result |

> Default is chat mode, open and talk -- there's no need to pick anything first.
> Yeah. AI Handle notes, or put results in notes, point above「Create」。
> From the right-key menu `AI Analyze / AI Polish / AI Continue writing / Question AI` **Automatically cut to creation mode**, and select the corresponding task.

Model Call**All model calls originate in the Go plugin backend.**，The request and the key do not go through the frontend of the plugin and do not write to the notes directory.

### Configure (both ways, anywhere)

**Mode I: Match in connection (initial value)** —— Edit「AI.MD Notes」Connection → Check **Enable AI Functions** → Fill out:

| Fields | Example | Annotations |
| --- | --- | --- |
| AI Service provider | `OpenAI Compatibility` | Most of the national models are compatible with the self-built gateway. OpenAI Agreements |
| API Address | `https://api.deepseek.com/v1` | Service root address, excluding `/chat/completions`；Ollama Use `http://127.0.0.1:11434/v1` |
| Model Name | `deepseek-chat` | Fill in by service document, if `gpt-4o-mini`、`qwen2.5:7b` |
| API Key | `sk-…` | Existence DBX The key is in storage.**Send plugin backend only**；Ollama Local models leave empty |
| Custom Set / Timeout / Upper limit | — | All options (in frames)「Advanced Options」Lee: Default set,60 Second time out, one time in. 12000 Character |

Fill out points **「Test AI Connection」**：It uses the parameters in the current form.**You don't have to save it first.**）Sending a minimum request to appear directly in the form.
「Connection success:deepseek-chat（openai）· Time-consuming 812 ms」or「DiscrepanciesHTTP 401）：API Key Invalid」。

**Mode 2: In AI Change in column (quick, no need to go back to connect)** —— Points AI Top right corner of the column **⚙**，Finish the popup configuration.「Save」It's a long term.
Points「Test connection」You can try and save first. The dialog action bar stays fixed at the bottom and the content will never appear."Save button not found"。Three-tier priority:

```
AI Saved in column (inline)  >  Configuration in Connection  >  Internal Default
```

So:**You don't have to do anything with someone connected.**；Whoever changed it in the column will be marked.「This configuration already covers the connection configuration」，
Points **「Clear local settings」** I'll get back to you.「Based on connection configuration」。

> **How do you save the key?**：This configuration is written in the plugin private data directory `ai-config.json`（Not in the notes directory.
> Key**Default valid only for this session**；Just check. **「Remember key on this machine」** This document will not be included until later.Unix Permissions Up `0600`）。
> The shared computer does not suggest ticking - better to leave the key in the connection (go) DBX . The key is stored.

### Use

- Entry: Toolbar **「AI Assistant」**（or `Ctrl/Cmd+I`）；From the right-key menu `AI Analyze / AI Polish / AI Continue writing / Question AI` It cuts directly to the creation mode and selects the task.
- **Chat mode (default)**：Write what you want to say. → Points「Send」。Please.**Without any note body**，The answer is for viewing or copying.
- **Four jobs in creative mode**：**Analyze**（Key points/To-do/I'm sorry.**Polish**（Keep the point with Markdown Structure,**Continue writing**（I'll finish it.**Ask**（A question about the current note.

**Analyzing object (in creative mode only)** —— A line of buttons above the panel.「If you open it, you die.」：

| button | Behaviour |
| --- | --- |
| `Auto-follow`（Default) | In the editor**Select if selected**，Or I'll take the whole note. |
| `Selection` | Fixed the currently selected paragraph only (no hint to select) |
| `Entire note` | Fixed Full Text of Current Notes |
| `Clear` | **Do Not Use Note Body**：Just your questions./Request |

- Object area will be displayed **Object Type + Note name + Number of words**，And I'll give you one.**Content Preview**（Front 160 What's going on?
- Select, change, change notes.**Refresh in real time**objects;marks when a single cap is exceeded「It's automatically cut when it's sent.」。
- Status line (lower right corner) also writes「Ready . The selection will be sent (123 Word)」，The two sides do not speak separately.

**No text (creational mode)**：`Analyze`/`Polish` The text is still needed (state line will explain and recommend conversion)「Ask」）；
`Ask`/`Continue writing` Still available -- the former is pure dialogue, the latter is created as you write. Please just cut back.「Chat」Mode, less.

- Result Operations (Focus Operation)**Create mode**Each of the following results has a set:
  - `Insert at cursor` —— The cursor is inserted,**Do not delete any existing body**（If there is an electoral district, it will be confirmed first, because the price is the replacement).
  - `Replace selection` —— **Play the confirmation box first.**（Show range, row changes and previews of replacement)
  - `Append to end`
  - `Copy`
- The result of chat mode is only `Copy`（Nothing."Where to write back?"That's it.
- The result comes from another note, which is confirmed once more before writing; it is written back, and it goes down.
- Panel width, coding status in plugin data directories ()`prefs.json`），**Double-click Separator**Reverts the default width.
- Panel**Bottom input/Send area fixed**，The first half of the area rolls itself -- the windows are short, the content is long, the buttons are not squeezed away.

### Privacy and security

- **Key No Backend**：Take the host to lower end of the life cycle channel (or in-house configuration), which is not available at the frontend of the plugin; if you do not log, the error message will be desensitized Done. `***`。
- **Default Minimum**：Sends only the selected contents or the current notes; you can select the paragraphs to process in the editor before sending them.
- **Networking description**：Request sent directly to you from the back of the plugin. API Address(s) `host.network` Permission, and no sandbox. CORS It's too late.
  Please fill in the service address you trusted - the text of the note will leave the machine.
- Disconnect / Timeout / The default gives a Chinese-readable hint and is recorded in the storage diagnostic log.

### Why not? DBX Internal AI

Hosted by `host.ai` Permission`dbxPlugin.ai.openConversation`），But it...**It's just a conversation with a data snapshot.
Do not return model responses, do not expose model configuration** —— I can't.「AI And then I wrote back.」This core thing.
And the statement of authority is...**Static**The declaration. `host.ai` It'll lift the lowest host. 0.6.20、And make an earlier version in**The whole package was directly rejected during the installation phase**。
It's useless to keep all old users out of the door for a non-utilized entry, so this plugin**I don't want to depend on it.**（Packing of scripts with gates to prevent future additions).

---

## Installation (Use .dbxp）

> **DBX ≥ 0.5.68**。Plugin Statement Only `host.filesystem` A mandate.AI AI uses user-configured models through direct sidecar requests,
> Not dependent on the new host. `host.ai` —— So the old host can also fit and upgrade.

1. Open DBX → Settings → Plugin;
2. Install `dist/com.lwai.mdnotes-<Version>-windows-x64.dbxp`；
   If a hint for signature-related errors is made, first on the plugin page**「Allow installation of unsigned development packages」**（Local development channels;
3. New Connection → Connection Type Selection **AI.MD Notes**；
4. Fill **Note Storage Directory**（Absolute path with read-and-write permission, selected by the right-hand folder button)→ Test connection;
5. Opens the connection and enters the desk. The status bar (bottom right corner) should be displayed「Saved to storage directory:...」，Click it to see storage status details.

---

## Data security

Storage design for plugin by「**A directory may be opened with multiple connections**」Let's do this. Three hard rules:

- **Remove Only Visibility Command**。Save with「Just what you obviously deleted.」Semantics: Notes not found in snapshots will be**Keep as it is.**，
  It's not because「This connection never opened.」Cleared out. So the same memory directory can be safely connected to more than one./Multiple windows are used at the same time without covering or deleting each other.
- **Remove to trash**。Remove Notes/The text of the folder will not disappear but will be moved to `<Storage Directory>/.mdnotes/trash/<timestamp>/`，It can be recovered manually.
  In extreme cases (the document is occupied, etc.) it is preferable to leave the orphan document without irreversible deletion.
- **If you can't read, you can't write it back.**。If you can't read the body of a note (renamed externally)/Move/The interface will take it.**Freeze into read-only**And hint,
  Never write back empty content over the body of the disk.

---

## Storage Model

```
<Note Storage Directory>/
├── Welcome. MD Notes.md        # Every note. = A real one. .md（Filename = Title)
├── Work/                      # Each Folder = A real subdirectories.
│   └── Refactoring Verification.md
└── .mdnotes/                  # Metadata for plugins (not participating in list tree display)
    ├── meta.json              # Structure index:id / Title / parent relationship / Path / timestamp + UI Status (without text)
    ├── trash/<timestamp>/         # Deleted body (recoverable)
    └── .write-probe           # Writeable probe
```

- **The text will always be `.md` Reference**；`meta.json` Just remember the structure. First Name+Directory reconstruction.
- It's all right.「Temporary documents + `rename`」atom replacement;temporary filename belts `pid` avoids multiple cases overlaying with serial numbers.
- When saving by content SHA-256 Cache judgement「Has it really changed?」，Only rewrite changed notes.

### Why isn't it in the index?

Single `notes.json` There is a high risk of reading, writing and damage when the amount of data is large; each note is independent, externally editable and capable of being broken into a true document diff、It can be consumed by other tools.

---

## Build

**Node 22+** with **Go 1.20+**（Official Go SDK Already vendor In `backend/dbxsdk`，**Build without a network**）。

### Recommended: Use the warehouse to bring its own script (inline self-check) + Exact checksums）

```bash
# 1) Compile side vehicle
GOROOT=<go Root> <go> build -C backend -o dbx-plugin-mdnotes.exe .

# 2) Packing (e.g. run static self-inspection, then generate) .dbxp Same name artifact.json）
node _buildpkg.js
# → dist/com.lwai.mdnotes-0.7.1-windows-x64.dbxp
```

`_buildpkg.js` Yes: yes `manifest.entrypoints.backend.executable` Rewrite as the true path in the package
（`bin/<target>/dbx-plugin-mdnotes[.exe]`，**Only  windows target has `.exe`**）、Generate**Overwrite each file accurately**`checksums.json`、
Skip `_` Prefix file and write to the entry in the package Move! **Unix Permission position**。

> **Why do you have to write permissions?**：The host installer is in macOS/Linux I'll press it. zip Purpose unix mode Transfer `set_permissions`；
> And... zip Read Library In `external_attributes == 0`（or「Production system」Nope. Unix）Time**Back None**，Host will skip permissions--
> The sidecar that was pulled out was... `0644`、**There's no place to enforce it.**。The official packer. `bin/<target>/` Below `0755`、Other `0644`，
> This warehouse is packed with scripts.`_verify.mjs` The corresponding assertion has also been added.

> Or go to the official. CLI（`npm install -g @dbx-app/plugin-cli` Back `dbx-plugin dev` / `dbx-plugin package`），
> Their behavior is equivalent. Attention. `dbx-plugin.toml` `[package].include` **Don't.**configuration `bin/` —— Binary is injected by a packer.

### Full platform with one output `release-candidates.json`）

Official CLI **Pack only the current host platform**，configuration `--target` They'll be rejected.
（`Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform`）；
The official document's multi-platform approach is CI Open the platform matrix, build each and merge it. `release-candidates.json`。

The side of this plugin is...**Pure Go、none cgo**，It can be compiled directly and cross-compiled, so a local command can come out in full:

```bash
node _release.mjs                       # Default windows-x64 + darwin-arm64 + linux-x64
node _release.mjs windows-x64 linux-x64 # Or you can just make a specific platform.
```

It does four things in turn: cross-compile sidecar.`CGO_ENABLED=0 GOOS/GOARCH=...`，It's coming. `_xbuild/`）→ Packing by Platform
→ Check-in-approach`_verify.mjs`）→ Summary:

```
dist/<id>-<version>-<target>.dbxp            Unsigned candidate package (upload to Release / CDN / Object Storage)
dist/<id>-<version>-<target>.artifact.json   The bag. target / url / sha256 / size
dist/release-candidates.json                 plugin MetaInfo + All platforms artifacts（dbx-store Synchronise)
```

> **`release-candidates.json` Lee. `sha256` Bind exact bytes**：It has to be regenerated when the code has been rebuilt.
> & Upload**Same one.** `.dbxp`。Assets after official issuance are not allowed to be covered and any byte changes are subject to an incremental review of the version numbers.

> **Do Not Manual Settings `GOROOT` Pointing to the wrong directory**。Go 1.21+ Positioning; if upgraded Go The old directories are still there and the environment variables are not changed.
> It's coming. `package encoding/json is not in std` This whole line is wrong - see[The barrier.](#The barrier.)。

---

## Contents structure

```
dbx-md-notes/
├── manifest.json          # id / publisher / version、entrypoints、Connect type fields, localize
├── dbx-plugin.toml        # [backend] language/directory/binary + [package] include
├── assets/plugin.svg
├── ui/                    # Frontend iframe There's no disk./Network Permissions)
│   ├── index.html
│   ├── styles.css
│   ├── app.js             # Directory tree (trawling pointer), editor/Preview, search, watch contact, export/Backup/Restore
│   ├── markdown.js        # Markdown Render (no dependence)
│   ├── sql-highlight.js   # SQL Syntax Highlight
│   └── storage.js         # Storage layer: the only persistence path = Sidecar; never silently degraded
├── backend/
│   ├── go.mod             # module github.com/lwai/mdnotes（Zero external dependence)
│   ├── main.go            # Side vehicles: notes for reading and writing, indexing, export/Backup/Recovery,mdnotes:// File System
│   ├── main_test.go       # Single measure: Rename/Movement, backup back-to-back, route crossing denial, data secure return
│   └── dbxsdk/            # Official Go SDK As it is. vendor（See dbxsdk/VENDOR.md）
├── dist/                  # Pack the product. *.dbxp / *.artifact.json / release-candidates.json（No Version Control)
├── _xbuild/               # Cross-compiled darwin/linux Side vehicle (no version control)
└── _*.{js,mjs,py}         # Validate and Publish Tool Chains`_` Prefix, not package)
```

### Why? vendor Official SDK

`github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk` **Not published Go Module Proxy**（`go get` Report `unknown revision`），
And... `go.mod` Statement `go 1.22`，The introduction of independence will make the low-end tool chain impossible to build.
That's why the official `sdk.go` **Bytes**Copy As `backend/dbxsdk` Package, compiled with this module: just Go 1.20+，Offline to build.

SDK I'm in charge of three simple things:`plugin/initialize` Must return. `{protocolVersion, capabilities, plugin:{id,version}}`
（**id/version must match manifest It's exactly the same, or the host throws away the sidecar.**）、Every request goroutine、8MB Line buffer.

---

## Authentication tool chain

After changing the front-end or packing the relevant code,**Run these floors in order.**：

```bash
NODE=<node Executable>

"$NODE" _e2e_bridge.mjs   # 1) Bridge: Official SDK Source Thread in vm Run! + Simulate host dispatch + Real storage.js + Real sidecar.
"$NODE" _e2e_ui.mjs       # 2) UI Level: Real index.html In. jsdom + Real side vehicles (needs) jsdom）
"$NODE" _e2e_layout.mjs   # 3) Layout level: Real Chrome Render, measure「Buttons in areas not visible to users」（Yes Chrome + puppeteer-core）
$PYTHON _domcheck.py      # 4) Static:DOM References to suspension, duplicate function statements, missing key elements
"$NODE" _buildpkg.js && "$NODE" _verify.mjs   # 5) Packing (inline self-checking)+ Product Structure / sha256 / Permissions Validation
```

We're going to have a full platform. `release-candidates.json`，Just run. `_release.mjs`（It's going to call up first. 5 Step.

What can be caught on every level:

- **`_e2e_bridge.mjs`** —— The synonyms of the bridge are wrong, the sidecar's handshake failed, and it's exported./Backup/Back and forth.**Data security syntax**（Unknown≠To delete, explicitly delete into the trash and leave the body unwritten.
- **`_e2e_ui.mjs`** —— **The only thing I can catch.「Interface Launched and Dead」First floor**：A missing element can disable all buttons. Also overwhelm drag-down discs, delete must And... `deletedIds`。
- **`_e2e_layout.mjs`** —— **The only thing I can catch.「Element exists but the user cannot see」First floor**（jsdom No layout engine.`getBoundingClientRect` All of them. 0）。
  Accidents measured:AI Column Configuration 1 Expand, Bottom Input + The sending button is pushed out of the window - the element is in,JS I'm not wrong. I can't catch the first two floors.
  Now it's got multiple vision heights. / Multiple panels down geometry and run.「You can talk without an analyzer.」Real click process.
  Not in the environment. Chrome / `puppeteer-core` Auto SKIP。
- **`_domcheck.py`** —— `$("id").Properties` Direct take value (elemental loss throws) TypeError The whole page, the same layer of duplicate function statements (the latter silently covers the former), and the availability of key elements.
- **`_buildpkg.js` / `_verify.mjs`** —— Pack the first few gates. + Package structure,`checksums.json` Exact coverage,sha256 All matches, key code tags,**Run the binary in the bag once.**Sent a probe. RPC。

> **Only the backend can't detect the bridge. bug，It's just a bridge.「The interface didn't even start.」，jsdom I don't know.「The layout has squeezed out the elements.」。**
> Dependency:`jsdom` with `puppeteer-core` Loaded in an isolated work area (IWP)`DBX_NODE_WS` Point to him. `package.json`），Chrome/Edge Installed with systems.
> Three scripts share `_testutil.mjs`（Delete the temporary directory, the encapsulation of the starter process.

---

## Sidecar RPC

| Methodology | Annotations |
| --- | --- |
| `plugin/initialize` | By SDK Processing, protocol version and ID verification completed |
| `connection/test` | Verify memory directory to write, return path to be written |
| `connection/connect` / `disconnect` | Connecting life cycle;`connect` It'll be absorbed from the connection configuration. `storage_dir` |
| `notes/ping` | Front-end handshake detection; paper version**In Run-time Read Package manifest**（We don't have to compile a constant, we don't have to float. |
| `notes/probe` | Non-destructive writeability detection (written only) `.mdnotes/.write-probe`） |
| `notes/load` | Back `{data, path, dir, pending}`。**`data` It's the shell. The notes. `data.nodes`**；Nodes have when text cannot be read `contentMissing:true` and**does not contain** `content` |
| `notes/save` | Write body (unchanged by) SHA-256 Skip+ Atomic Replace Index.**Delete only `deletedIds` Visible nodes**，Keep the remaining nodes which are not in the snapshot as they are; delete into the trash |
| `notes/exportNote` | Export a single section. Default Return `{fileName, dataBase64}`（The host.「Save As」）；`toDisk:true` Just write in the memory directory |
| `notes/backup` | Backup As zip（note body + `mdnotes-backup.json` + `.mdnotes/meta.json`）。Default Bytes Return |
| `notes/restore` | From Backup zip Restore`dryRun` Only in return. Reject path-crossing and non-notes plugin backup; automatic storage before recovery `pre-restore-*.zip` Photo |
| `notes/setDir` / `notes/path` | Manually Assign / Query Storage Directory |
| `ai/config` | in force AI Configure & Source**Without Keys**，Only  `hasKey` / `keyFrom` / `overridden` / `missing`） |
| `ai/setConfig` | By AI Bar Update Configuration (`persist:false` Only memory changes. Key default, tick「Remember key」Just write it. `ai-config.json` |
| `ai/resetConfig` | Clear this machineAI Bar) Saves the configuration, go back「Based on connection configuration」 |
| `ai/test` | Sending a minimum request with given parameters (or current configuration)**Do not change effective configuration** |
| `ai/chat` | `{task, text, instruction}` → `{content, model, usage, truncated, sentChars, latencyMs}`；It's a sidecar calls the model directly. |
| `ui/getPrefs` / `ui/setPrefs` | Interface preferences (panel width and AI Bar opening) `<Plugin Data Directory>/prefs.json`；White List + Numeric clamp |
| `connection/action` | Connects a form to customize actions. Only for now. `test-ai`（Use**Unsaved Form Values**(A minimum request) |
| `filesystem/list\|read\|write\|createDirectory\|delete\|rename` | Project the notes tree. `mdnotes://` Virtual File System |
| `contextMenu/com.lwai.mdnotes.newNoteForTable` | Context on Log to `pending`，For「New note for table」Access |

> The sidecar will.**Recursive Scan**In the box. `storage_dir / storageDir / storage_path / notes_dir …`，
> Do not rely on the host to plug the configuration into a fixed field path.

**AI Configure the two layers and the order in which the values are taken**（`backend/ai.go`）：

```
aiConn  ← connection/connect|action Bring it in. ai_* with connection_secrets.ai_api_key（Easy to lose, every time. connect Clear ahead)
aiLocal ← AI Column「Save」Writing (extended to <Plugin Data Directory>/ai-config.json）
Valid value = Default value → aiConn Field overwrite → aiLocal Field by Field Overwrite Non Empty Value
```

`ui/setPrefs` They are called twice (one after reading, one before merging), so the numeric resolution must be recognized at the same time.
`float64`（JSON Other Organiser `int`（Reunified) - Only `float64` The second key will be thrown off the bad value, silently.

---

## The barrier.

Status Bar → Light it up.「Storage status」，The following lines shall be used:

| phenomena | Reasons and treatment |
| --- | --- |
| Side-car process:**Not provided invoke Bridge.** | The frontend is not running DBX Host (e.g. by direct browser) `ui/index.html`）。Anticipatory behaviour. |
| Side-car process:**Method not found: notes/ping** | `invoke` succeeded, but the sidecar didn't recognize it. → Mostly. `manifest.json` `entrypoints.backend.executable` inconsistent with the actual binary name, or `dbx-plugin.toml` Missing `[backend]` As a result, the backend was never compiled. |
| Actual storage directory:**（Not available)** | The host does not transfer the connection configuration to the front-end context. The sidecar will still be there. `connection/connect` It's a loads the configured directory.**Without prejudice to saving**，Only  UI Show it not out. |
| Save Failed + Permission class error | Store directory is not written/Doesn't exist. Change the directory that the current user is entitled to write to. |
| Notes displayed as**Read and hint only「Note body file cannot be read」** | The `.md` Renamed externally/Move/Occupancy. Restore the document itself is sufficient; the plugin will not cover it with empty content. |
| **AI Not fully configured (deficit: ...)** | AI At the top of the column, you'll list the missing points. ⚙ Expands the configuration area to fill in; you can also return to the connection settings to fill in. |
| **DiscrepanciesHTTP 401）** | The key is wrong or does not have permission for the model. Use Configuration「Test connection」Direct check (does not have to save first). |
| **No interface found (HTTP 404）** | API The address usually needs a version of the path, for example `https://api.deepseek.com/v1`（Plugin will be added automatically `/chat/completions`）。 |
| **AI Request timeout** | Slow model.「Single timeout」Redeployment 120–300 sec. |
| **Changed the connection. AI Configure but not effective** | AI bar. Point Configuration「Clear local settings」can return to the connection configuration. |
| **「Send」Buttons are gray.** | The status line directly indicates which type: configuration not filled (「Still missing:...」，Points ⚙ Configure, chat mode does not write, or creation mode requires text and objects are empty. |
| **No modeling arguments found** | AI Top right corner of the column **⚙**，The configuration is a stand-alone box (no chat area). |
| **button/I can't see the input frame.** | The floor bar of the panel is fixed, with the first half rolling by itself; the button line of the dialog frame is inhaled. If it's still unusual, AI Bars drag wide or close configuration frames, and please provide feedback (with specific layout back check) `_e2e_layout.mjs` To cover such issues). |
| **It's not what I thought it was.** | Chat mode**without note content**；The creation mode looks at the summary and preview of the object area.`Auto-follow` It changes with the editor. `Entire note` / `Selection`，Points `Clear` It's not even a word. |
| **AI Can not open message / It didn't work.** | Minimum width for each column (table of contents) 180px、AI 280px）with ceiling 720px；Double-click the split bar to double-click. |
| Trying to get the deleted notes back. | Look. `<Storage Directory>/.mdnotes/trash/<timestamp>/`。 |
| Go Report `package encoding/json is not in std` | `GOROOT` It points to the old one. Go Contents. Clear it. `GOROOT` or points to the current installation. |

---

## Known Borders

- **Request DBX ≥ 0.5.68**。Plugin Statement Only `host.filesystem`；**I don't rely on it.** `host.ai`（For a reason.
  [Why not? DBX Internal AI](#Why not?-dbx-Internal-ai)），So the upgrade plugin doesn't need to be upgraded first. DBX。
- UI Full running in the sandbox.**No Disk and Network Permissions**：All writes go through the sidecar./Backup must be made by the host.「Save As」。
- AI Request by**Sidecar**Send (no frontend) not required `host.network` Permission, and no sandbox. CORS Limit.
- Connect Parameters `storage_dir`）Yeah. **2 MiB Upper limit**；More than agreed to restore from backup 1.5 MB zip You will be rejected and you will be prompted to decompress manually.
- Use of the same directory for multiple connections and simultaneous editing**Post Overwrite**（last-write-wins），Do not do real-time consolidation.
- **AI It's a one-way conversation.**：Only sent each time「Your message.」or「Analysis target + Your extra requirements.」，Do not pour the last round back to the model.
- **Chat mode without text**；Only current notes are covered by the analysis object of the creation mode (select a paragraph) / Whole / Nothing.
- **「Ask」「Continue writing」It can also be used alone when there is no text in creative mode.**（Pure conversation / Free generation) but「Analyze」「Polish」There must be text.
- **AI Column mode does not last**：Every time open back to default「Chat」；Panel width and openness is recorded in `prefs.json`。
- **Panel width and open state, and「Analysis target」It's always the source./Session Status**：Width and Open on `prefs.json`（It's not like it's a good idea.
  Object source exists in memory (reopening desktop to default「Auto-follow」）。
- When multiple connections share the same memory directory,**AI Configure to be independent by connecting**（Connect key only in the memory of each side of the car process;
  AI Saved in Column「Current Configuration」**All shared.**Yeah.
