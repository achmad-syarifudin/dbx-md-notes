/*
 * UI-level end-to-end verification: Real index.html + Real app.js + Real storage.js + Real Go Sidecar
 * ============================================================================
 * Why do you need this floor:
 *   2026-09-21 The accident was... index.html Lee. #btn-copy-sql It's been dropped, and... app.js
 *   bindEvents Write still `$("btn-copy-sql").onclick = ...` → TypeError → bindEvents In the beginning
 *   Interrupt → boot() He didn't run. → Buttons are dead, and they'll never stop. unknown、Notes never drop.
 *   Backend e2e（_e2e_bridge.mjs）The bridge. e2e Both.**All green.**Because they're not loaded.
 *   app.js。So we have to add another layer.「Really? index.html Run!」The test.
 *
 * This script used jsdom Load Real index.html（Company <script src> We'll do it together. beforeParse Lee.
 * Infusion with a host bridge Semantic False dbxPlugin（ready / context / invoke / request /
 * onContext），invoke Go real. Go sidecar. JSON-RPC。The assertion focuses on:
 *   - boot Whether the walk is over or whether the button is real (no)「The binder was jumped silently.」）
 *   - Whether the backend is really holding hands, is it in the log? [FAIL]（Log from S.status().diag）
 *   - The top-of-the-top diagnostic strip is offline.
 *   - Is the notes true? .md To Disk
 *
 * Usage: node _e2e_ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { removeTree } from "./_testutil.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(ROOT, "_e2e_ui.mjs"));
const { JSDOM } = require(process.env.DBX_JSDOM || "jsdom");
const EXE = process.env.DBX_SIDECAR || path.join(ROOT, "_xbuild/dbx-plugin-mdnotes-linux-amd64");
const TMP = path.join(ROOT, "_e2e_ui_tmp");
const STORAGE_DIR = path.join(TMP, "storage");
const DATA_DIR = path.join(TMP, "data");
const SAVED_DIR = path.join(TMP, "saved");   // Simulation「User Saves a directory selected in the dialogue box in original」
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;
const CONN_ID = "e2e-ui-conn-1";

removeTree(TMP);   // See _testutil.mjs：Sandbox. rmSync Take over to the trash. The directory is overtime.
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SAVED_DIR, { recursive: true });

/** Recursively find a filename, return absolute path */
function findPath(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const fp = path.join(root, e.name);
    if (e.isDirectory()) {
      const hit = findPath(fp, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return fp;
    }
  }
  return "";
}

/** Very simple zip Central Directory Read (only for an asserted entry) */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Nope. zip：not found EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("Synchronising folder @" + off);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push(buf.slice(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

/* ---------------- Real sidecar. ---------------- */
const child = spawn(EXE, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: DATA_DIR },
  stdio: ["pipe", "pipe", "pipe"],
});
let seq = 0;
const waiting = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const entry = waiting.get(String(msg.id));
    if (!entry) continue;
    waiting.delete(String(msg.id));
    if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  }
});
child.stderr.on("data", (c) => process.stderr.write("[sidecar] " + c));
/** notes/save Water in the water (assets)「Delete a visible statement. deletedIds」The semantics of these agreements) */
const saveCallsLog = [];
function sidecar(method, params) {
  const id = String(++seq);
  if (method === "notes/save") { saveCallsLog.push(params || {}); }
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

/* ---------------- Fake host bridge connection (with official SDK Semantic Convergence) ---------------- */
const workbenchContext = { connectionId: CONN_ID, connectionName: "MD Notes" }; // I didn't mean to. storage_dir
const hostLog = [];

async function hostDispatch(method, params) {
  const bytes = Buffer.byteLength(JSON.stringify(params ?? null));
  if (bytes > BRIDGE_PAYLOAD_LIMIT) throw new Error("Plugin bridge request is too large");
  hostLog.push(method);
  if (method === "host.getContext") return workbenchContext;
  if (method === "backend.invoke") {
    const input = params || {};
    if (typeof input.method !== "string") throw new Error("backend.invoke params must include method");
    return await sidecar(input.method, input.params ?? null);
  }
  throw new Error(`Unsupported plugin host method '${method}'`);
}

function installBridge(window) {
  const ctxListeners = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  // Simulation of homeowners「Save As」：Write bytes to SAVED_DIR（= User selected directory, return {path}
  const saveCalls = [];
  function hostSaveFile(options, data) {
    if (data === null || data === undefined) return null; // Host when user cancels resolve null
    let u8;
    try { u8 = new Uint8Array(data); } catch { throw new Error("host.saveFile requires binary data"); }
    const name = String((options && options.fileName) || "unnamed.bin");
    const target = path.join(SAVED_DIR, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(u8));
    saveCalls.push({
      fileName: name,
      contentType: (options && options.contentType) || "",
      bytes: u8.byteLength,
      path: target,
    });
    return Promise.resolve({ path: target });
  }

  const api = {
    ready,
    // Real SDK：ready , and context It's simultaneous readable.
    get context() { return workbenchContext; },
    get locale() { return "zh-CN"; },
    get theme() { return "light"; },
    get capabilities() { return {}; },
    invoke(method, params, opts) {
      const limit = (opts && opts.timeoutMs) || 30000;
      return Promise.race([
        hostDispatch("backend.invoke", { method, params }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(method + " Timeout")), limit)),
      ]);
    },
    request(method, params) { return hostDispatch(method, params); },
    saveFile: hostSaveFile,
    notify() {},
    onContext(fn) { ctxListeners.push(fn); },
    onInit(fn) { ctxListeners.push(fn); },
  };
  window.dbxPlugin = api;
  // Simulate host walk-in init：ready resolve Data from pure context invoke）
  setTimeout(() => { resolveReady(workbenchContext); }, 0);

  // jsdom Missing Browser API Bottom
  window.Element.prototype.scrollIntoView = function () {};
  window.document.execCommand = () => false;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.__hostLog = hostLog;
  window.__saveCalls = saveCalls;
  window.__testErrors = [];
  window.addEventListener("error", (e) => window.__testErrors.push(String(e.message || e)));
}

/* ---------------- Run! ---------------- */
const dom = await JSDOM.fromFile(path.join(ROOT, "ui/index.html"), {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse: installBridge,
});
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (cond()) return true; } catch { /* ignore */ }
    await sleep(50);
  }
  console.error(`[timeout] Wait「${what}」Over ${ms}ms`);
  return false;
}

const pass = [];
const fail = [];
function check(name, cond, extra) {
  (cond ? pass : fail).push(name + (extra ? "  |  " + extra : ""));
}
// The top-set diagnostic bar is offline (SHOW_DIAG_BAR=false），Logs only exist in storage:S.status().diag
const diagText = () => {
  const s = window.MDNotes && window.MDNotes.storage;
  if (!s) return "";
  const st = s.status();
  return (st.diag && st.diag.length) ? st.diag.join("\n") : "";
};
const diagLines = () => diagText().split("\n").filter(Boolean);

/* First, get the sidecar back to normal. */
await sidecar("plugin/initialize", { host: { protocolVersions: [1] } });
const conn = await sidecar("connection/connect", {
  connection: { id: CONN_ID, name: "MD Notes", config: { storage_dir: STORAGE_DIR } },
  connectionId: CONN_ID,
});

/* Wait. UI Get up. */
await waitFor(() => window.MDNotes && window.MDNotes.storage, 6000, "storage.js Load");
await waitFor(() => {
  const s = window.MDNotes && window.MDNotes.storage;
  if (!s) return false;
  const st = s.status();
  return st.backend !== "unknown" || diagText().includes("[FAIL]");
}, 20000, "Storage Initialization gives final conclusions");
await sleep(600); // Wait. persist(false) / seed Crash

const S = window.MDNotes.storage;
const st = S.status();

/* ---------- 1) Start the link. ---------- */
check("storage.js Exposure MDNotes.storage", !!S && typeof S.init === "function");
check("boot Triggered", diagText().includes("Frontend boot Start"));
check("UI Initialization completed (not abnormally interrupted)", diagText().includes("[ OK ] Frontend UI Ready"), "");
check("Storage init Called and ran.",
  /Sidecar call notes\/ping[\s\S]*\[ OK \]/.test(diagText()) || diagText().includes("Sidecar handshake notes/ping"),
  "");
check("No start-up period. [FAIL]",
  diagLines().filter((l) => l.includes("[FAIL]")).length === 0,
  diagLines().filter((l) => l.includes("[FAIL]")).join(" ;; ") || "none");

/* ---------- 2) Return fence: missing elements no longer sit together ---------- */
const bindLines = diagLines().filter((l) => /Tie \w+ → #/.test(l));
check("Missing elements write only one (optional) log without interrupting other bindings",
  bindLines.length === 1 && bindLines[0].includes("#btn-copy-sql") && bindLines[0].includes("[ .. ]"),
  bindLines.join(" ;; ") || "（No log binding)");
check("Interface JS No uncapture error",
  window.__testErrors.length === 0, window.__testErrors.join(" ;; "));

/* ---------- 3) The top-set diagnostic bar is downlined (upline form) and the status bar capsule is still in place ---------- */
check("Header diagnostic bar not on page (offlined)", !$("diag-bar") && !$("diag-log"));
check("#main The first sub-point is the toolbar (no longer occupied by diagnostic bars)",
  ($("main").firstElementChild || {}).className === "toolbar",
  "Actual: " + ($("main").firstElementChild || {}).className);
check("Status Bar capsule is still in place and the title is correct",
  !!$("store-status") && $("store-text").textContent.includes("Saved to storage directory"),
  $("store-text").textContent);

/* ---------- 4) storage Status ---------- */
check("Backend = sidecar", st.backend === "sidecar", "backend=" + st.backend);
check("Persistence + ok", st.persistent === true && st.ok === true, "lastError=" + st.lastError);
check("The sidecar shakes hands.", st.sidecarAvailable === true, "sidecarError=" + st.sidecarError);
check("It's from the sidecar.", st.storageDir === STORAGE_DIR, "storageDir=" + st.storageDir);
check("dirConfigured=true", st.dirConfigured === true);

/* ---------- 5) It's over. ---------- */
const meta = path.join(STORAGE_DIR, ".mdnotes/meta.json");
check("meta.json Crashed", fs.existsSync(meta), meta);
const mdFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith(".md")) mdFiles.push(path.relative(STORAGE_DIR, fp));
  }
})(STORAGE_DIR);
check("Example Notes as True .md Crash", mdFiles.length >= 2, mdFiles.join(" | ") || "（None)");

/* ---------- 6) Buttons are really good. ---------- */
const treeBefore = $("tree").textContent;
$("btn-new-note").click();
await sleep(800); // Wait. debounce Crash
check("「New note」Button Effect", $("tree").textContent.includes("Untitled Note")
  && $("tree").textContent !== treeBefore,
  $("tree").textContent.slice(0, 60));
const newFile = mdFiles.some((f) => f.includes("Untitled Note"))
  || fs.existsSync(path.join(STORAGE_DIR, "Untitled Note.md"));
check("The new notes have been dropped.", newFile, mdFiles.join(" | "));
check("save The post-diagnosis log has new records.",
  diagText().includes("Sidecar call notes/save"), diagLines().slice(-3).join(" ;; "));

$("btn-table-note").click();
check("「New note for table」The dialog opens.", $("table-modal").hidden === false);
$("tn-cancel").click();
check("The dialog closes.", $("table-modal").hidden === true);

/* ---------- 7) The stat capsule will be activated. ---------- */
$("store-status").click();
await sleep(50);
check("Dot-bar capsules open.「Storage status」Blast the window.",
  $("modal").hidden === false && $("modal").textContent.includes("Storage status"),
  $("modal").textContent.slice(0, 60));
check("Default [n] display step-by-step diagnostic log in dialogs (upline closing)",
  !$("modal").textContent.includes("Storage diagnostic log"));
$("modal").querySelectorAll("button").length
  && [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Close").click();
check("Status dialog closes.", $("modal").hidden === true);

/* ---------- 8) Diagnosis is still in place. ---------- */
check("Diagnostic reports can still be generated (including environmental snapshots for exclusion)",
  S.report().includes("--- Environment ---") && S.report().includes("typeof window.dbxPlugin"),
  "");
check("Diagnosis logs remain intact in storage (but not on screen)",
  diagText().includes("Frontend boot Start") && diagText().includes("Sidecar handshake notes/ping"),
  diagLines().slice(-2).join(" ;; "));
check("Historical diagnostic portal not leaked to page (none) diag-toggle/Copy diagnostic button)",
  !$("diag-toggle") && !$("diag-copy") && !$("diag-detail"));

/* ---------- 9) Do not repeat storage position at the bottom of the sidebar (storage status window is the only exit) ---------- */
check("Do not show storage paths at the bottom of the sidebar (.foot-loc Removed)",
  !$("side-foot").querySelector(".foot-loc")
    && !$("side-foot").textContent.includes(STORAGE_DIR),
  JSON.stringify($("side-foot").textContent));
check("Keep the statistical information at the bottom of the sidebar (not the whole piece deleted)",
  /Notes/.test($("side-foot").textContent) && !!$("side-foot").querySelector(".foot-stat"),
  $("side-foot").textContent);

/* ---------- 10) Catalog tree drag. ---------- */
// GEN:rowEl It's left over. draggable="true" → Elemental drag → Browser grabs gestures, hairs pointercancel
// Cuts the pointer and drags and displays a prohibited cursor. First. DOM Level one. Let's do it again.「Drag Notes into Folder」。
const fire = (el, type, props) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props || {});
  el.dispatchEvent(ev);
  return ev;
};

const initialNodes = [...doc.querySelectorAll("#tree .node")];
check("Node in the directory tree (precondition)", initialNodes.length > 0, "Nodes=" + initialNodes.length);
check("No more list of tree nodes draggable（Or the original drag will choke off the finger.",
  initialNodes.every((el) => !el.hasAttribute("draggable")),
  initialNodes.map((el) => el.getAttribute("draggable")).join(",") || "（None, correct)");
check("All the tree nodes. data-id（Pull it down to the drop point)",
  initialNodes.every((el) => !!el.getAttribute("data-id")));
{
  const cssText = fs.readFileSync(path.join(ROOT, "ui/styles.css"), "utf8");
  check(".drag-ghost Yeah. pointer-events:none（Or the hit test will hit the ghost himself.",
    /\.drag-ghost\s*\{[^}]*pointer-events:\s*none/.test(cssText));
  check(".node Yeah. touch-action:none（To prevent the pointers from being taken away by the rollers.",
    /\.node\s*\{[^}]*touch-action:\s*none/.test(cssText));
}

// jsdom No layout.elementFromPoint not available;replaced with「Coordinates → Test specified elements」。
// It's our own tractor, not the browser's hit test.
let hitEl = null;
doc.elementFromPoint = () => hitEl;

// Create a folder to drag target
const FOLDER_NAME = "Drag Target Folder";
$("btn-new-folder").click();
await sleep(50);
const folderInput = $("modal") && $("modal").querySelector("input");
check("「New folder」The dialog opens.", !!folderInput);
if (folderInput) {
  folderInput.value = FOLDER_NAME;
  [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Create").click();
  await sleep(700);
}
const folderRow = [...doc.querySelectorAll("#tree .node")].find(
  (el) => el.getAttribute("data-type") === "folder" && el.textContent.includes(FOLDER_NAME));
check("Folder appears in directory tree", !!folderRow,
  [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | "));

// Target note: No. 6 The festival was just built in the root directory.「Untitled Note」
const dragRow = [...doc.querySelectorAll("#tree .node")].find(
  (el) => el.getAttribute("data-type") === "note" && el.textContent.includes("Untitled Note"));
check("The notes to drag are in the directory tree.", !!dragRow);

if (folderRow && dragRow) {
  hitEl = dragRow;
  fire(dragRow, "pointerdown", { button: 0, clientX: 10, clientY: 10 });
  // Only 2px：Still within the click threshold, should not enter drag (or click cannot be selected)
  fire(doc, "pointermove", { clientX: 12, clientY: 12 });
  check("Do not enter drag when the threshold is not exceeded (click to select)",
    !doc.body.classList.contains("dragging-active"));

  hitEl = folderRow;
  fire(doc, "pointermove", { clientX: 60, clientY: 60 });
  const ghost = doc.querySelector(".drag-ghost");
  check("After crossing the threshold enters a drag state (generation of a drag ghost + Capture cursor)",
    doc.body.classList.contains("dragging-active") && !!ghost,
    "dragging-active=" + doc.body.classList.contains("dragging-active") + " ghost=" + !!ghost);
  check("Highlight placement when hovering on a folder", folderRow.classList.contains("drop-target"));
  const pv = ghost ? window.getComputedStyle(ghost).pointerEvents : "";
  check("It's an accident to drag a ghost without a finger.", pv === "none" || pv === "", "pointer-events=" + JSON.stringify(pv));

  fire(doc, "pointerup", { clientX: 60, clientY: 60 });
  await sleep(900); // Wait. debounce Crash
  check("When you're done with this, you're done with this.",
    !doc.body.classList.contains("dragging-active")
      && !doc.querySelector(".drag-ghost")
      && !doc.querySelector(".node.drop-target"));

  const movedPath = findPath(STORAGE_DIR, "Untitled Note.md");
  check("The notes were actually moved to the target folder.",
    !!movedPath && path.basename(path.dirname(movedPath)) === FOLDER_NAME,
    movedPath || "（Not found");
}

/* ---------- 11) Export / Backup the host「Save As」（Selected Directory) ---------- */
const saveCalls = window.__saveCalls;
check("storage.js Recognize host saveFile Capacity", S.hasHostSave() === true);
check("The toolbar has「Restore Backup...」button", !!$("btn-restore-zip"));
check("Restore zip File Selector Exists", !!$("backup-input"));

// Export: Select a note first
const anyNote = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
anyNote.click();
await sleep(50);
$("btn-export-md").click();
await sleep(600);
const exCall = saveCalls.find((c) => c.contentType === "text/markdown");
check("「Export .md」Save the host as (band) text/markdown Type)", !!exCall,
  saveCalls.map((c) => c.fileName + ":" + c.contentType).join(" | ") || "（No call)");
check("Export .md It landed.「User Selected Directory」",
  !!exCall && fs.existsSync(exCall.path) && exCall.path.startsWith(SAVED_DIR),
  exCall ? exCall.path : "（None)");

// Backup
$("btn-backup-zip").click();
await sleep(900);
const bkCall = saveCalls.find((c) => c.contentType === "application/zip");
check("「Backup zip」Save the host as (band) application/zip Type)", !!bkCall, bkCall ? bkCall.fileName : "（No call)");
check("Backup zip It landed.「User Selected Directory」",
  !!bkCall && fs.existsSync(bkCall.path) && bkCall.path.startsWith(SAVED_DIR),
  bkCall ? bkCall.path : "（None)");
if (bkCall && fs.existsSync(bkCall.path)) {
  const names = zipEntries(fs.readFileSync(bkCall.path));
  check("Backup contains configuration mdnotes-backup.json", names.includes("mdnotes-backup.json"), names.join(", "));
  check("Backup contains directory tree index .mdnotes/meta.json", names.includes(".mdnotes/meta.json"));
  check("Backup entry name with slash", !names.some((n) => n.includes("\\")));
  check("After the backup was successful, the dialog showed.「configuration」And how to recover",
    $("modal").hidden === false && /configuration|Restore/.test($("modal").textContent),
    $("modal").textContent.slice(0, 80));
  [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Close").click();
}

/* ---------- 12) Restore from Backup (complete) UI Process with confirmation box) ---------- */
if (bkCall && fs.existsSync(bkCall.path)) {
  const zipBuf = fs.readFileSync(bkCall.path);

  // Let's break the scene first: change the title. → File on disk changed name
  const victim = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
  victim.click();
  await sleep(50);
  const goodName = $("title").value;
  $("title").value = "Corrupted Name";
  fire($("title"), "input");
  fire($("title"), "blur");
  await sleep(900);
  check("The site was destroyed.", !!findPath(STORAGE_DIR, "Corrupted Name.md"),
    findPath(STORAGE_DIR, "Corrupted Name.md") || "（No change");

  // Move! UI：To hide. file input Plug a real one. File，Trigger change
  const zipFile = new window.File([new Uint8Array(zipBuf)], path.basename(bkCall.path), { type: "application/zip" });
  const input = $("backup-input");
  Object.defineProperty(input, "files", { value: [zipFile], configurable: true });
  fire(input, "change");
  await waitFor(() => $("modal").hidden === false && $("modal").textContent.includes("Confirm restore"), 8000, "Restore confirmation box");
  check("Pop-up confirmation box after selection for backup (including package information)",
    $("modal").hidden === false && $("modal").textContent.includes("Confirm restore")
      && $("modal").textContent.includes("Notes"),
    $("modal").textContent.slice(0, 120) || "（No windows!");

  const startBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Start restore");
  check("Check box「Start restore」button", !!startBtn);
  if (startBtn) {
    startBtn.click();
    await waitFor(() => $("modal").hidden === false && $("modal").textContent.includes("Restore complete"), 10000, "Restore complete");
    check("Recovery of completion and return of results",
      $("modal").textContent.includes("Restore complete"), $("modal").textContent.slice(0, 120));
    check("The original file name on the disk came back when it was restored.", !!findPath(STORAGE_DIR, goodName + ".md"),
      goodName + ".md -> " + (findPath(STORAGE_DIR, goodName + ".md") || "（I didn't come back."));
    check("Also restore the title in the directory tree after recovery",
      [...doc.querySelectorAll("#tree .node")].some((el) => el.textContent.includes(goodName)),
      "Expectations " + JSON.stringify(goodName)
        + " · Tree=[" + [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | ") + "]"
        + " · DiskmetaNodes=" + (() => {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, ".mdnotes/meta.json"), "utf8"));
            return m.nodes.map((n) => n.type + ":" + n.name).join(" | ");
          } catch (e) { return "(I can't read. meta: " + e.message + ")"; }
        })()
        + " · Disk File=" + (function w(d, pre = "") {
          return fs.readdirSync(d, { withFileTypes: true }).map((e) =>
            e.isDirectory() ? w(path.join(d, e.name), pre + e.name + "/") : pre + e.name).join(" | ");
        })(STORAGE_DIR));
    check("Before we recover, we leave a backlash.pre-restore-*.zip）",      fs.readdirSync(STORAGE_DIR).some((f) => f.startsWith("pre-restore-")),
      fs.readdirSync(STORAGE_DIR).join(", "));
    [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Close").click();
  }
}

/* ---------- 13) Delete must be visible deletedIds（Backend only visible deletion, no more「It's not in the snapshot.」） ---------- */
{
  const countMd = () => (function w(d) {
    return fs.readdirSync(d, { withFileTypes: true }).reduce((sum, e) => {
      if (e.isDirectory()) { return e.name === ".mdnotes" ? sum : sum + w(path.join(d, e.name)); }
      return sum + (e.name.endsWith(".md") ? 1 : 0);
    }, 0);
  })(STORAGE_DIR);

  const before = countMd();
  const beforeSaves = saveCallsLog.length;

  const victim = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
  check("Deleting Example: Deleting Notes in Directory Tree", !!victim);
  if (victim) {
    victim.click();
    await sleep(30);
    $("btn-delete").click();
    await waitFor(() => $("modal").hidden === false && /Confirm deletion/.test($("modal").textContent), 4000, "Delete confirmation box");
    const okBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Delete");
    check("Delete confirmation box「Delete」button", !!okBtn, $("modal").textContent.slice(0, 60));
    if (okBtn) {
      okBtn.click();
      await sleep(600);
      const saved = saveCallsLog.slice(beforeSaves).reverse()
        .find((p) => p.data && Array.isArray(p.data.deletedIds) && p.data.deletedIds.length > 0);
      check("Delete Node id Put it in. deletedIds（Or the backend won't be deleted.", !!saved,
        "Last save deletedIds=" + JSON.stringify((saveCallsLog[saveCallsLog.length - 1] || {}).data
          && (saveCallsLog[saveCallsLog.length - 1].data || {}).deletedIds));
      check("Removed from Disk .md One missing.", countMd() === before - 1, before + " -> " + countMd());

      const trashRoot = path.join(STORAGE_DIR, ".mdnotes", "trash");
      const trashCount = fs.existsSync(trashRoot)
        ? (function w(d) {
          return fs.readdirSync(d, { withFileTypes: true }).reduce((sum, e) =>
            e.isDirectory() ? sum + w(path.join(d, e.name)) : sum + (e.name.endsWith(".md") ? 1 : 0), 0);
        })(trashRoot)
        : 0;
      check("Deletion of body into the trash (recoverable, not destroyed)", trashCount >= 1, "trash Lee. .md Number=" + trashCount);
    }
  }
}

/* ---------- 14) AI Assistant: persistent right sidebar (not a dialog) Default chat mode Configure the dialog 3 drag ---------- */
{
  const cssNum = (name) => parseInt($("app").style.getPropertyValue(name), 10) || 0;
  const dragGutter = async (el, dx) => {
    fire(el, "pointerdown", { button: 0, clientX: 500, clientY: 300 });
    fire(doc, "pointermove", { clientX: 500 + dx, clientY: 300 });
    fire(doc, "pointerup", { clientX: 500 + dx, clientY: 300 });
    await sleep(80);   // The one who lets it go. promise Finish.
  };

  check("The toolbar has「AI Assistant」button", !!$("btn-ai"));
  check("AI Bar initially close", $("ai-panel").hidden === true && $("app").getAttribute("data-ai") === "off",
    "data-ai=" + $("app").getAttribute("data-ai"));
  check("Both partitions.|Notes. Notes.|AI）", !!$("gutter-side") && !!$("gutter-ai"));
  check("Default width is written CSS Variables", cssNum("--side-w") > 0 && cssNum("--ai-w") > 0,
    cssNum("--side-w") + " / " + cssNum("--ai-w"));

  // I have to choose one.「Content」Note: Empty notes will be stopped correctly"There's nothing on this note."）
  const aiNote = [...doc.querySelectorAll("#tree .node")].find((el) =>
    el.getAttribute("data-type") === "note" && /Welcome.|DBX Use your heart.|Refactoring Verification/.test(el.textContent));
  check("AI Example: Note with contents in directory tree", !!aiNote,
    [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | "));

  if ($("btn-ai") && aiNote) {
    aiNote.click();
    await sleep(40);
    $("btn-ai").click();
    await waitFor(() => $("ai-panel").hidden === false, 6000, "AI Column");

    check("Points「AI Assistant」It's the persistent right sidebar, not the dialog.",
      $("ai-panel").hidden === false && $("app").getAttribute("data-ai") === "on" && $("modal").hidden === true,
      "data-ai=" + $("app").getAttribute("data-ai") + " · modal.hidden=" + $("modal").hidden);

    // --- Default is chat mode: no parsing object, no task tab ---
    check("Default is「Chat」Mode", $("aip-view-chat").classList.contains("active") &&
      !$("aip-view-create").classList.contains("active"),
      "chat=" + $("aip-view-chat").className + " create=" + $("aip-view-create").className);
    check("No parsing objects and tasks shown in chat mode#aip-create-only Put it away.",
      $("aip-create-only").hidden === true);
    check("The button file for chat mode is「Send」", $("aip-go").textContent === "Send", $("aip-go").textContent);
    check("Empty message for chat mode「Create」", /Create/.test($("aip-log").textContent), $("aip-log").textContent.slice(0, 80));

    // --- Configure pop-up frames, no more chat areas ---
    await sleep(500);   // Wait. ai/config Come back.
    check("Not configured AI：Auto-eject configuration box (to save users from guessing why they didn't move)", $("ai-cfg-modal").hidden === false);
    check("There are no embedded configuration forms in the chat area (modified to a dialog)",
      !doc.querySelector("#aip-scroll #aip-cfg") && !doc.getElementById("aip-baseurl"));
    check("Configure bullet field ready ( Addresses) / Model / Key / Remember key / Personnel / Timeout / ceiling)",
      ["aic-enabled", "aic-provider", "aic-baseurl", "aic-modelinput", "aic-key",
        "aic-remember", "aic-sysprompt", "aic-timeout", "aic-maxchars"].every((id) => !!$(id)),
      ["aic-enabled", "aic-provider", "aic-baseurl", "aic-modelinput", "aic-key",
        "aic-remember", "aic-sysprompt", "aic-timeout", "aic-maxchars"].filter((id) => !$(id)).join(",") || "Full");
    check("Configure bullet frames to save / Test connection / Clear local settings",
      !!$("aic-save") && !!$("aic-test") && !!$("aic-clear"));
    check("Unconfigured Status Line Orientation to ⚙ Configure", /⚙/.test($("aip-status").textContent), $("aip-status").textContent);
    $("aic-cancel").click();
    await sleep(60);
    check("「Cancel」Can turn off the configuration.", $("ai-cfg-modal").hidden === true);
    $("aip-cfg-toggle").click();
    await sleep(60);
    check("Point Top Right ⚙ Can also open configuration frames", $("ai-cfg-modal").hidden === false);
    $("aic-cancel").click();
    await sleep(60);

    // --- To create mode: Analyse object + Task label only appears ---
    $("aip-view-create").click();
    await sleep(80);
    check("Cut「Create」Then there's an object and a task.",
      $("aip-create-only").hidden === false && !$("aip-view-create").classList.contains("active") === false);
    check("Create mode has task switching (analysis)/Polish/Continue writing/Questions)",
      ["Analyze", "Polish", "Continue writing", "Ask"].every((t) =>
        [...$("aip-tabs").querySelectorAll("button")].some((b) => b.textContent === t)),
      [...$("aip-tabs").querySelectorAll("button")].map((b) => b.textContent).join(" | "));

    // --- Analytic object: Must be interchangeable, clearable and show what to send ---
    check("Parsing object range display objects and words",
      /《.+》/.test($("aip-target").textContent) && /Word/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));
    check("Object area with a preview of content (can see what to post)",
      !!$("aip-target").querySelector(".aip-target-preview"));
    check("All four objects are sourced (automatically followed) / Selection / Entire note / Clear)",
      ["aip-mode-auto", "aip-mode-selection", "aip-mode-note", "aip-mode-none"].every((id) => !!$(id)));
    check("Create mode default「Auto-follow」", $("aip-mode-auto").classList.contains("active"));

    $("aip-mode-note").click();
    await sleep(60);
    check("Cut「Entire note」Subsequent object summary changes (changeable)",
      $("aip-mode-note").classList.contains("active") && /Entire note/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    $("aip-mode-none").click();
    await sleep(60);
    check("「Clear」Then the object is emptied and clearly does not send the text of the note",
      $("aip-mode-none").classList.contains("active") && /Cleared/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    $("aip-mode-auto").click();
    await sleep(60);
    check("Cut back.「Auto-follow」Restore later object",
      $("aip-mode-auto").classList.contains("active") && /Word/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    // --- Cut back chat mode: close the creation area as a whole ---
    $("aip-view-chat").click();
    await sleep(80);
    check("Cut back.「Chat」Post-analyze object and task as a whole", $("aip-create-only").hidden === true);

    // --- Three-bar drag. ---
    const aiBefore = cssNum("--ai-w");
    await dragGutter($("gutter-ai"), -60);        // AI Bar on Right → Drag left = Widening
    const aiAfter = cssNum("--ai-w");
    check("Drag AI The partition will change the width.", aiAfter === aiBefore + 60, aiBefore + " -> " + aiAfter);

    const sideBefore = cssNum("--side-w");
    await dragGutter($("gutter-side"), 40);
    const sideAfter = cssNum("--side-w");
    check("Drag the directory partition to change the width", sideAfter === sideBefore + 40, sideBefore + " -> " + sideAfter);
    check("Draging to change the directory area, unconnected. Change AI Column", cssNum("--ai-w") === aiAfter);

    await dragGutter($("gutter-ai"), 2000);
    check("It's too wide to the bottom. AI We're not here.", cssNum("--ai-w") === 280, String(cssNum("--ai-w")));

    fire($("gutter-ai"), "dblclick", {});
    await sleep(80);
    check("Double-click Separator To Default Width", cssNum("--ai-w") === 400, String(cssNum("--ai-w")));

    check("Width is down to Plugin Data Directory (not entry)",
      fs.existsSync(path.join(DATA_DIR, "prefs.json")) &&
      !fs.existsSync(path.join(STORAGE_DIR, "prefs.json")),
      "data/prefs.json=" + fs.existsSync(path.join(DATA_DIR, "prefs.json")));
    const prefsWritten = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prefs.json"), "utf8")); } catch { return {}; }
    })();
    check("Two widths and panel switches in your heart.",
      typeof prefsWritten.sidebarWidth === "number" && typeof prefsWritten.aiWidth === "number" &&
      prefsWritten.aiPanelOpen === true, JSON.stringify(prefsWritten));

    // --- Put it away. ---
    $("aip-close").click();
    await sleep(80);
    check("Points ✕ Put it away. AI Columns (bars 0）",
      $("ai-panel").hidden === true && $("app").getAttribute("data-ai") === "off",
      "data-ai=" + $("app").getAttribute("data-ai"));

    $("btn-ai").click();
    await sleep(120);
    const prefsReopen = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prefs.json"), "utf8")); } catch { return {}; }
    })();
    check("Panel open is remembered", prefsReopen.aiPanelOpen === true, JSON.stringify(prefsReopen));
    check("After reopening,「Chat」Mode (default mode is not durable and meets expectations)",
      $("aip-view-chat").classList.contains("active") && $("aip-create-only").hidden === true);
  }
}

/* ---------- 15) True link: fake model → Real side. → Panel → Editor → Disk ---------- */
// This section follows a complete link: a fake model service is used, attached to the sidecar, and verified separately.
//   (a) Creative mode: the result is four write-back operations, which are able to enter the editor and drop the disk;
//   Chat mode: Request not to take notes, only entry「Copy」。
{
  const MARK = "AI_WRITE_BACK_MARK";
  const modelSrv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: "fake-e2e",
        choices: [{ message: { content: MARK } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => modelSrv.listen(0, "127.0.0.1", r));
  const port = modelSrv.address().port;

  await sidecar("connection/connect", {
    connection: {
      id: CONN_ID, name: "AI.MD Notes",
      config: { storage_dir: STORAGE_DIR },
      external_config: {
        ai_enabled: true, ai_provider: "openai",
        ai_base_url: `http://127.0.0.1:${port}/v1`, ai_model: "fake-e2e",
      },
      connection_secrets: { ai_api_key: "sk-e2e-secret-123456" },
    },
    connectionId: CONN_ID,
  });

  // Put it away and open it. = Force reset configuration (the panel is only refreshed when open and visible)
  if (!$("ai-panel").hidden) { $("btn-ai").click(); await sleep(80); }
  $("btn-ai").click();
  await sleep(600);
  check("Configure Header Display Model after Ready First Name", /fake-e2e/.test($("aip-model").textContent), $("aip-model").textContent);
  check("No auto-bullet configuration frame when configured (no need to disturb when matched)", $("ai-cfg-modal").hidden === true);

  // ---- Chat mode: without the text of the note ----
  check("Default Chat Mode", $("aip-create-only").hidden === true);
  check("Can not send message: %s %s", $("aip-go").disabled === true);
  $("aip-input").value = "Hello, please introduce yourself in one sentence.";
  fire($("aip-input"), "input", {});
  await sleep(200);
  check("After writing down,「Send」Available", $("aip-go").disabled === false, $("aip-status").textContent);
  $("aip-go").click();
  await waitFor(() => $("aip-log").textContent.indexOf(MARK) >= 0, 10000, "Chat Results");
  {
    const entries = [...$("aip-log").querySelectorAll(".aip-entry")];
    const last = entries[entries.length - 1];
    const btns = [...last.querySelectorAll("button")].map((b) => b.textContent);
    check("Chat Entry Header As「Chat / without note content」",
      /Chat/.test(last.textContent) && /without note content/.test(last.textContent),
      last.textContent.slice(0, 60));
    check("Only the chat results「Copy」，No return button (relay for creation)",
      btns.length === 1 && btns[0] === "Copy", btns.join(" | "));
  }

  // ---- Creative mode: 4 write back operations ----
  $("aip-view-create").click();
  await sleep(120);
  check("The object and task appear after the creation mode", $("aip-create-only").hidden === false);
  await waitFor(() => $("aip-go").disabled === false, 6000, "Create mode to send");

  const editor = $("editor");
  const before = String(editor.value || "");
  const entriesBefore = $("aip-log").querySelectorAll(".aip-entry").length;
  $("aip-go").click();
  // Note: Can't just wait. MARK —— It's already in the last chat.waitFor They will return immediately.pop() I got an old entry.
  await waitFor(() => {
    const es = [...$("aip-log").querySelectorAll(".aip-entry")];
    const last = es[es.length - 1];
    return es.length > entriesBefore && !!last &&
      last.querySelectorAll("button").length > 0 && last.textContent.indexOf(MARK) >= 0;
  }, 10000, "Result of creation");
  const entryBtns = [...$("aip-log").querySelectorAll(".aip-entry")].pop().querySelectorAll("button");
  const opTexts = [...entryBtns].map((b) => b.textContent);
  check("Create results with four operation buttons",
    ["Insert at cursor", "Replace selection", "Append to end", "Copy"].every((t) => opTexts.includes(t)), opTexts.join(" | "));

  const copyBtn = [...entryBtns].find((b) => b.textContent === "Copy");
  if (copyBtn) {
    copyBtn.click();
    await sleep(80);
    check("「Copy」Do Not Modify Body", String(editor.value || "") === before);
  }

  const appendBtn = [...entryBtns].find((b) => b.textContent === "Append to end");
  if (appendBtn) {
    appendBtn.click();
    await sleep(400);
    const after = String(editor.value || "");
    check("「Append to end」Write results into the editor",
      after.indexOf(MARK) >= 0 && after.length > before.length && after.indexOf(before) === 0,
      JSON.stringify(after.slice(-30)));

    const hit = (function walk(dir) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const r = walk(p);
          if (r) { return r; }
        } else if (e.name.endsWith(".md")) {
          try { if (fs.readFileSync(p, "utf8").indexOf(MARK) >= 0) { return p; } } catch { /* ignore */ }
        }
      }
      return "";
    })(STORAGE_DIR);
    check("Drop the disk as soon as you write it back.", !!hit, hit ? path.relative(STORAGE_DIR, hit) : "not found");

    editor.selectionStart = editor.selectionEnd = 0;
    const insertBtn = [...entryBtns].find((b) => b.textContent === "Insert at cursor");
    if (insertBtn) {
      insertBtn.click();
      await sleep(300);
      check("「Insert at cursor」Plug in to cursor (start)",
        String(editor.value || "").indexOf(MARK) === 0,
        JSON.stringify(String(editor.value || "").slice(0, 24)));
    }

    editor.selectionStart = editor.selectionEnd = 0;
    const replaceBtn = [...entryBtns].find((b) => b.textContent === "Replace selection");
    if (replaceBtn) {
      replaceBtn.click();
      await sleep(120);
      check("When No Selection「Replace selection」Blocked and hinted (no correction)",
        /No content selected/.test($("toast").textContent) && $("modal").hidden === true,
        "toast=" + $("toast").textContent);

      const src = String(editor.value || "");
      editor.selectionStart = 0;
      editor.selectionEnd = 5;
      replaceBtn.click();
      await waitFor(() => $("modal").hidden === false, 3000, "Replace confirmation box");
      check("Play confirmation box (shows what will be replaced) when there are constituencies",
        /Confirm to replace selected elements/.test($("modal").textContent), $("modal").textContent.slice(0, 120));
      const okBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "Replace");
      check("It's in the confirmation box.「Replace」button", !!okBtn);
      if (okBtn) {
        okBtn.click();
        await sleep(400);
        const replaced = String(editor.value || "");
        // The constituency is... [0,5)，The result should be precisely replaced. 5 Character (premises the desired value with a back-to-back spell, no includes Guess.
        check("Replacement after confirmation (constituency replaced by result)",
          replaced === MARK + src.slice(5),
          JSON.stringify(replaced.slice(0, 30)) + " vs " + JSON.stringify((MARK + src.slice(5)).slice(0, 30)));
      }
    }
  }
  modelSrv.close();
}

/* ---------- Summary ---------- */
console.log("\n===== Pass. " + pass.length + " Item =====");
pass.forEach((p) => console.log("  PASS  " + p));
if (fail.length) {
  console.log("\n===== Failed " + fail.length + " Item =====");
  fail.forEach((f) => console.log("  FAIL  " + f));
}
console.log("\n----- Page status (diagnostic bars are offline, log taken from storage) -----");
console.log("  status : " + $("store-text").textContent);
console.log("  backend: " + st.backend + " · dir=" + st.storageDir + " · lastError=" + (st.lastError || "none"));
diagLines().forEach((l) => console.log("  " + l));
console.log("\n----- Disk artifacts -----");
(function walk(d, pre = "") {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    console.log("  " + pre + e.name + (e.isDirectory() ? "/" : "  (" + fs.statSync(fp).size + " B)"));
    if (e.isDirectory()) walk(fp, pre + "  ");
  }
})(STORAGE_DIR);

window.close();
child.kill();
console.log("\nRESULT: " + (fail.length ? "FAIL" : "PASS"));
process.exit(fail.length ? 1 : 0);
