/*
 * End-to-end verification: real SDK Bridge. + Real storage.js + Real Go Sidecar
 * ---------------------------------------------------------------------------
 * The last few rounds didn't catch him. bug：End-to-end test directly to the side. JSON-RPC，It's bypassed. JS Bridge.
 * It's a script. SDK It's coming out. vm Run inside, then model the host.
 * dispatch（host.getContext / backend.invoke / 2MiB Load limit)
 * ui/storage.js，Take the whole link:ready -> context -> notes/ping -> notes/load -> notes/save。
 *
 * Usage: node _e2e_bridge.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTree } from "./_testutil.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST_SRC = process.env.DBX_HOST_SRC || "";
const EXE = process.env.DBX_SIDECAR || path.join(ROOT, "_xbuild/dbx-plugin-mdnotes-linux-amd64");
const TMP = path.join(ROOT, "_e2e_tmp");
const STORAGE_DIR = path.join(TMP, "storage");
const DATA_DIR = path.join(TMP, "data");
const SAVED_DIR = path.join(TMP, "saved");   // Simulation「User Saves a directory selected in the dialogue box in original」
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;

removeTree(TMP);   // See _testutil.mjs：Sandbox. rmSync Take over to the trash. The directory is overtime.
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SAVED_DIR, { recursive: true });

/** Cross realm Bytes: Plugin in vm realm Rich. ArrayBuffer，host Side instanceof I can't. */
function toU8(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v.byteLength === "number" && typeof v.slice === "function") return new Uint8Array(v);
  return null;
}

/** Very simple zip Central directory readable (only for the assertion of the entry in the package, and not for the content) */
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

/* ---------- 1) Take the official from the host code. SDK Source Thread ---------- */
function extractSdkSource() {
  const src = fs.readFileSync(HOST_SRC, "utf8");
  const fnAt = src.indexOf("export function pluginSdkSource");
  const start = src.indexOf("return `", fnAt) + "return `".length;
  const end = src.indexOf("})();`;", start) + "})();".length;
  if (fnAt < 0 || start < fnAt || end <= start) throw new Error("Unable to locate pluginSdkSource Template");
  let code = src.slice(start, end);
  const subs = { PLUGIN_MESSAGE_SOURCE: "dbx-plugin", HOST_MESSAGE_SOURCE: "dbx-host", BRIDGE_VERSION: "1", serializedInitialTheme: "null" };
  code = code.replace(/\$\{(\w+)\}/g, (m, name) => {
    if (!(name in subs)) throw new Error("Unknown plugin " + name);
    return subs[name];
  });
  return code;
}

/* ---------- 2) Real sidecar (JSONL JSON-RPC） ---------- */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const child = spawn(EXE, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: DATA_DIR }, stdio: ["pipe", "pipe", "pipe"] });
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
function sidecar(method, params) {
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

/* ---------- 3) Plugin Side vm Environment ---------- */
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Blob,
  URL,
  TextEncoder,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  origin: "null",           // Sandbox iframe opaque origin
};
context.window = context;
context.globalThis = context;

const docListeners = [];
context.document = {
  listeners: docListeners,
  visibilityState: "visible",
  documentElement: { style: { setProperty() {} }, dataset: {}, setAttribute() {}, getAttribute() { return null; } },
  addEventListener(type, fn) { docListeners.push({ type, fn }); },
  removeEventListener() {},
  dispatchEvent(ev) { docListeners.filter((l) => l.type === ev.type).forEach((l) => l.fn(ev)); return true; },
};

const winListeners = [];
context.addEventListener = (type, fn) => winListeners.push({ type, fn });
context.removeEventListener = () => {};
function emitToPlugin(msg) {
  const ev = { source: context.parent, data: msg };
  winListeners.filter((l) => l.type === "message").forEach((l) => l.fn(ev));
}

vm.createContext(context);

/* ---------- 4) Host side dispatch（Photo pluginHostBridge.ts Semantic) ---------- */
const workbenchContext = { connectionId: "e2e-conn-1", connectionName: "MD Notes" }; // I didn't mean to. storage_dir
context.parent = {
  postMessage(msg) {
    if (msg.type === "ready") {
      setTimeout(() => emitToPlugin({
        source: "dbx-host", version: 1, type: "init",
        pluginId: manifest.id, contributionId: "com.lwai.mdnotes.main",
        locale: "zh-CN", permissions: manifest.permissions, capabilities: {}, context: workbenchContext,
      }), 0);
      return;
    }
    if (msg.type !== "request") return;
    dispatch(msg).then(
      (result) => emitToPlugin({ source: "dbx-host", version: 1, type: "response", id: msg.id, result: result ?? null }),
      (err) => emitToPlugin({ source: "dbx-host", version: 1, type: "response", id: msg.id, error: err instanceof Error ? err.message : String(err) }),
    );
  },
};

async function dispatch(req) {
  const bytes = Buffer.byteLength(JSON.stringify(req.params ?? null));
  if (bytes > BRIDGE_PAYLOAD_LIMIT) throw new Error("Plugin bridge request is too large"); // Host Same Limit
  const method = req.method;
  if (method === "host.getContext") return workbenchContext;
  if (method === "host.saveFile") {
    // Photo pluginHostBridge.ts host.saveFile Branch: Byte priority from transfer，Second dataBase64
    const input = req.params || {};
    let data = toU8(req.data);
    if (!data && typeof input.dataBase64 === "string") data = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
    if (!data) throw new Error("host.saveFile requires transferred binary data or dataBase64");
    if (data.byteLength > 512 * 1024 * 1024) throw new Error("Plugin save payload exceeds 512 MiB");
    // This means...「Host Bombing Original Dialogue box, user selection directory confirmed」——Direct fileName Fall in. SAVED_DIR
    const target = path.join(SAVED_DIR, String(input.fileName || "unnamed.bin"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data));
    return { path: target };
  }
  if (method === "backend.invoke") {
    const input = req.params || {};
    if (typeof input.method !== "string") throw new Error("backend.invoke params must include method");
    return await sidecar(input.method, input.params ?? null);
  }
  throw new Error(`Unsupported plugin host method '${method}'`);
}

/* ---------- 5) Load Official SDK + Real storage.js ---------- */
vm.runInContext(extractSdkSource(), context, { filename: "dbx-plugin-sdk.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/storage.js"), "utf8"), context, { filename: "storage.js" });

/* ---------- 6) Run! ---------- */
const pass = [];
const fail = [];
function check(name, cond, extra) {
  (cond ? pass : fail).push(name + (extra ? "  |  " + extra : ""));
}

(async () => {
  const init = await sidecar("plugin/initialize", { host: { protocolVersions: [1] } });
  check("Side ID and manifest Unanimously",
    init.plugin.id === manifest.id && init.plugin.version === manifest.version,
    `${init.plugin.id}@${init.plugin.version} vs ${manifest.id}@${manifest.version}`);

  // Backbar: Versions must be from the running-time reading package manifest，It can't be a compilation-time constant.
  const ping = await sidecar("notes/ping", {});
  check("Sidecar ping Text of the paper and manifest Consistency (constant drift)",
    ping.version === manifest.version, `${ping.version} vs ${manifest.version}`);

  // Host connection process:connection/connect And... storage_dir（Can't get it on the frontend.
  const conn = await sidecar("connection/connect", {
    connection: { id: "e2e-conn-1", name: "MD Notes", config: { storage_dir: STORAGE_DIR } },
    connectionId: "e2e-conn-1",
  });
  check("connection/connect Get Storage Directory", conn.configured === true && conn.storagePath === STORAGE_DIR,
    "path=" + conn.storagePath);

  const S = context.MDNotes.storage;
  check("storage.js Loaded and exposed MDNotes.storage", !!S && typeof S.init === "function");

  // Counterfeit cases (return bars):ready The value is [text data], it does not invoke。
  // Put ready The result is API Yes, it was."The notes will never be saved."The root cause.
  const readyValue = await context.window.dbxPlugin.ready;
  check("ready values are context data, not included invoke（of the Congo)",
    readyValue && typeof readyValue.invoke === "undefined",
    "readyValue keys=" + Object.keys(readyValue).join(","));
  check("Real API yes window.dbxPlugin In itself",
    typeof context.window.dbxPlugin.invoke === "function" && typeof context.window.dbxPlugin.request === "function");

  const res = await S.init();
  const st = S.status();
  check("init Do not drop anomalies and return to complete structure", !!res && typeof res === "object", "keys=" + Object.keys(res).join(","));
  check("Backend = sidecar", st.backend === "sidecar", "backend=" + st.backend);
  check("Persistence", st.persistent === true);
  check("ok=true No errors", st.ok === true && !st.lastError, "lastError=" + st.lastError);
  check("The sidecar shakes hands.", st.sidecarAvailable === true, "sidecarError=" + st.sidecarError);
  check("Read actual storage directory (from side vehicle)", st.storageDir === STORAGE_DIR, "storageDir=" + st.storageDir);
  check("dirConfigured=true", st.dirConfigured === true);
  check("connectionId From Sync context", st.connectionId === "e2e-conn-1", "connectionId=" + st.connectionId);

  // Write a real note.
  const snapshot = {
    version: 2,
    nodes: [
      { id: "f1", type: "folder", name: "Work", parentId: null, content: "", createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" },
      { id: "n1", type: "note", name: "Refactoring Verification", parentId: "f1", content: "# Refactoring Verification\n\nThe storage pipeline works.\n", createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" },
    ],
    activeId: "n1", expanded: { f1: true }, view: "split",
  };
  const ok = await S.save(snapshot, false);
  check("save Return succeeded", ok === true, "ok=" + ok + " lastError=" + S.status().lastError);

  const file = path.join(STORAGE_DIR, "Work/Refactoring Verification.md");
  const meta = path.join(STORAGE_DIR, ".mdnotes/meta.json");
  check("Real .md File set", fs.existsSync(file), file);
  check("meta.json Crashed", fs.existsSync(meta), meta);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    check("The notes are correct.", text.includes("The storage pipeline works"), JSON.stringify(text.slice(0, 40)));
  }

  // Read back
  const again = await S.reload();
  check("reload Read Back to 2 Nodes",
    !!(again.data && again.data.nodes && again.data.nodes.length === 2),
    "nodes=" + (again.data && again.data.nodes ? again.data.nodes.length : "null"));

  /* ---------- Export / Backup: Must go to the host「Save As」，Let User Select Directory ---------- */
  check("storage.js Recognize host saveFile Capacity", S.hasHostSave() === true);

  const ex = await S.invoke("notes/exportNote", { id: "n1" });
  check("Export Default Bytes Back, Do Not Write Yourself",
    typeof ex.dataBase64 === "string" && ex.path === undefined, "fileName=" + ex.fileName);
  const exr = await S.saveFile(ex.fileName, "text/markdown", ex.dataBase64);
  check("Exporting host to succeed", exr.ok === true, exr.error);
  const exPath = path.join(SAVED_DIR, "Refactoring Verification.md");
  check("Export .md It landed.「User Selected Directory」", fs.existsSync(exPath), exPath);
  if (fs.existsSync(exPath)) {
    check("Export content is correct", fs.readFileSync(exPath, "utf8").includes("The storage pipeline works"));
  }

  const bk = await S.invoke("notes/backup", {});
  check("Backup Backup Backup Bytes + Configure",
    typeof bk.dataBase64 === "string" && bk.path === undefined && !!bk.storageDir && bk.count === 1,
    `count=${bk.count} folders=${bk.folders} bytes=${bk.bytes}`);
  const bkr = await S.saveFile(bk.fileName, "application/zip", bk.dataBase64);
  check("Save Backup Host as Success", bkr.ok === true, bkr.error);
  const zipPath = path.join(SAVED_DIR, bk.fileName);
  check("Backup zip It landed.「User Selected Directory」", fs.existsSync(zipPath), zipPath);

  // There must be a backup package.「Configure」and「Directory Tree Index」，Otherwise it's just a bunch of orphan files.
  const names = zipEntries(fs.readFileSync(zipPath));
  check("Backup contains configuration mdnotes-backup.json", names.includes("mdnotes-backup.json"), names.join(", "));
  check("Backup contains directory tree index .mdnotes/meta.json", names.includes(".mdnotes/meta.json"));
  check("Backup contains text", names.some((n) => n.endsWith("Refactoring Verification.md")));
  check("Backup entry name with positive slash Windows Backslash)", !names.some((n) => n.includes("\\")));

  /* ---------- Restore: pour back the backup. ---------- */
  const b64 = fs.readFileSync(zipPath).toString("base64");
  const dir = await S.invoke("notes/restore", { dataBase64: b64, dryRun: true });
  check("Restore dryRun Return package content",
    dir.dryRun === true && dir.notes === 1 && dir.folders === 1,
    `notes=${dir.notes} folders=${dir.folders} ver=${dir.backup && dir.backup.version}`);
  check("dryRun Do not change disk", fs.existsSync(file));

  // Let's break the scene first, then restore it, and verify that we can really get back to the status quo ante.
  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.nodes[1].name = "Corrupted Name";
  await S.save(broken, false);
  const brokenPath = path.join(STORAGE_DIR, "Work/Corrupted Name.md");
  check("Site destroyed (renamed effective)", fs.existsSync(brokenPath), brokenPath);

  const rst = await S.invoke("notes/restore", { dataBase64: b64 });
  check("Recovery Success", rst.ok === true);
  check("The original file name came back after recovery.", fs.existsSync(file), file);
  check("Before we recovered, we left a backlash.",
    !!rst.safetyPath && fs.existsSync(rst.safetyPath), rst.safetyPath || "(none)");

  const after = await S.reload();
  check("Read Back to 2 Nodes",
    !!(after.data && after.data.nodes && after.data.nodes.length === 2),
    "nodes=" + (after.data && after.data.nodes ? after.data.nodes.length : "null"));
  if (after.data && after.data.nodes) {
    const n1 = after.data.nodes.find((n) => n.id === "n1");
    check("Recover the note and text Original",
      !!n1 && n1.name === "Refactoring Verification" && String(n1.content || "").includes("The storage pipeline works"),
      n1 ? n1.name : "(not found n1)");
  }

  /* ---------- Data security: deletion must be visible, unknown ≠ Delete2026-09-21 (Accidental return) ----------
   * Accident: As soon as the same memory directory is created again, the example that was then opened is saved (opening the desk to save),
   * The old snapshot in his hand was put into a state of authority -- the newly created notes of the other side were actually removed from the disk and the altered body was rolled back.
   */
  const findIn = (root, name) => {
    if (!fs.existsSync(root)) return "";
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const fp = path.join(root, e.name);
      if (e.isDirectory()) { const hit = findIn(fp, name); if (hit) return hit; }
      else if (e.name === name) return fp;
    }
    return "";
  };

  const base = await S.reload();
  const baseSnap = {
    version: 2,
    nodes: base.data.nodes.map((n) => Object.assign({}, n)),
    activeId: base.data.activeId, expanded: base.data.expanded || {}, view: "split",
  };

  // Simulation「Another connection.」Add a note to the same directory, and then this example will be saved with an old snapshot.
  const otherRel = "Written by Another Connection.md";
  await sidecar("notes/save", {
    storage_dir: STORAGE_DIR,
    data: {
      version: 2,
      nodes: baseSnap.nodes.concat([{
        id: "other", type: "note", name: "Written by Another Connection", parentId: null,
        content: "Do not delete me", createdAt: "x", updatedAt: "x",
      }]),
      activeId: "n1", expanded: {}, view: "split",
    },
  });
  const otherFile = path.join(STORAGE_DIR, otherRel);
  check("Another example written in a note dropped", fs.existsSync(otherFile), otherFile);

  await S.save(baseSnap, false);
  check("The notes for this instance remain on disk after the old snapshot is saved (unknown) ≠ Delete",
    fs.existsSync(otherFile), otherFile);
  const merged = await S.reload();
  check("The notes for this instance are still in the index after the old snapshot is saved.",
    !!(merged.data && merged.data.nodes && merged.data.nodes.some((n) => n.id === "other")),
    "nodes=" + (merged.data && merged.data.nodes ? merged.data.nodes.length : "null"));

  // Note body file cannot be read → Must mark contentMissing，And never return an empty string.
  fs.rmSync(otherFile);
  const miss = await S.reload();
  const missNode = miss.data && miss.data.nodes ? miss.data.nodes.find((n) => n.id === "other") : null;
  check("Mark when text cannot be read contentMissing", !!missNode && missNode.contentMissing === true,
    JSON.stringify(missNode));
  check("Do not return when text cannot be read content Fields (empty strings will be written back over)",
    !!missNode && missNode.content === undefined, JSON.stringify(missNode && missNode.content));

  await S.save({
    version: 2,
    nodes: (miss.data.nodes || []).map((n) => Object.assign({}, n)),
    activeId: miss.data.activeId, expanded: miss.data.expanded || {}, view: "split",
  }, false);
  check("「No text.」Save does not create empty files", !fs.existsSync(otherFile), otherFile);

  // Visible Delete: Only deletedIds The name is deleted and entered into the trash (recoverable), not destroyed
  const del = await S.reload();
  const delSnap = {
    version: 2,
    nodes: (del.data.nodes || []).map((n) => Object.assign({}, n)).filter((n) => n.id !== "n1"),
    deletedIds: ["n1"],
    activeId: null, expanded: del.data.expanded || {}, view: "split",
  };
  await S.save(delSnap, false);
  check("This file no longer exists after visible deletion", !fs.existsSync(file), file);
  const trashed = findIn(path.join(STORAGE_DIR, ".mdnotes", "trash"), "Refactoring Verification.md");
  check("Clear deleted body is entered into the trash (recoverable)", !!trashed, trashed || "(Can not get folder: %s: %s)");
  if (trashed) {
    check("The body of the trash is intact.", fs.readFileSync(trashed, "utf8").includes("The storage pipeline works"));
  }

  /* ---------- AI：Direct model connection of sidecar"Key does not send frontend"with"Error Readable"） ----------
   * The frontend does not have a network in the sandbox, and the model calls all on the sidecar; the key only passes through the host life cycle to the backend.
   * This is a real sidecar. + A fake model. HTTP Service, run the whole link.
   */
  const httpMod = await import("node:http");
  let aiLastAuth = "", aiLastPath = "", aiLastBody = "";
  const modelSrv = httpMod.createServer((req, res) => {
    aiLastAuth = req.headers["authorization"] || "";
    aiLastPath = req.url || "";
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      aiLastBody = b;
      res.setHeader("content-type", "application/json");
      if (aiLastPath.indexOf("/401/") >= 0) {
        res.statusCode = 401;
        res.end('{"error":{"message":"invalid api key sk-e2e-secret-123456"}}');
        return;
      }
      res.end(JSON.stringify({
        model: "fake-1",
        choices: [{ message: { content: "## Key points\n- First item" } }],
        usage: { prompt_tokens: 5, completion_tokens: 9 },
      }));
    });
  });
  await new Promise((r) => modelSrv.listen(0, "127.0.0.1", r));
  const aiPort = modelSrv.address().port;

  async function connectAI(baseUrl) {
    return sidecar("connection/connect", {
      connection: {
        id: "e2e-ai", name: "MD Notes",
        external_config: {
          storage_dir: STORAGE_DIR, ai_enabled: true, ai_provider: "openai",
          ai_base_url: baseUrl, ai_model: "fake-1", ai_max_chars: 500,
        },
        connection_secrets: { ai_api_key: "sk-e2e-secret-123456" },
      },
      connectionId: "e2e-ai",
    });
  }

  await connectAI(`http://127.0.0.1:${aiPort}/v1`);
  const aiSt = await S.aiConfig();
  check("ai/config：Configured and ready", !!aiSt && aiSt.ready === true && aiSt.model === "fake-1" && aiSt.hasKey === true,
    JSON.stringify(aiSt));
  check("ai/config：Do not return keyware", !!aiSt && JSON.stringify(aiSt).indexOf("sk-e2e-secret") < 0, JSON.stringify(aiSt));
  check("ai/config：Show key from connection configuration", !!aiSt && aiSt.keyFrom === "connection", JSON.stringify(aiSt && aiSt.keyFrom));
  check("ai/config：Not covered by this machineoverridden empty)", !!aiSt && (aiSt.overridden || []).length === 0,
    JSON.stringify(aiSt && aiSt.overridden));

  const aiChat = await S.aiChat("analyze", "This is the note body");
  check("ai/chat：Get the structured results.",
    !!aiChat && String(aiChat.content).indexOf("Key points") >= 0, JSON.stringify(aiChat).slice(0, 140));
  check("ai/chat：Hit. OpenAI Compatible Paths /v1/chat/completions", aiLastPath === "/v1/chat/completions", aiLastPath);
  check("ai/chat：Sidecar included. Authorization", aiLastAuth === "Bearer sk-e2e-secret-123456", aiLastAuth);
  check("ai/chat：There's a note in the tip.", aiLastBody.indexOf("This is the note body") >= 0, aiLastBody.slice(0, 120));
  check("Key does not appear in front context", JSON.stringify(workbenchContext).indexOf("sk-e2e") < 0);

  // The text should be cut off.ai_max_chars=500）
  const longChat = await S.aiChat("analyze", "Word".repeat(1200));
  check("The super-long text was cut off in return.", !!longChat && longChat.truncated === true && longChat.sentChars === 500,
    JSON.stringify({ t: longChat && longChat.truncated, n: longChat && longChat.sentChars }));

  // Error path: Must be readable in Chinese without leaking a key
  await connectAI(`http://127.0.0.1:${aiPort}/401/v1`);
  let aiErr = "";
  try { await S.aiChat("analyze", "note body"); } catch (e) { aiErr = String((e && e.message) || e); }
  check("Could not close temporary folder: %s", aiErr.indexOf("Authentication failed") >= 0, aiErr);
  check("Error message does not leak key", aiErr.indexOf("sk-e2e-secret") < 0, aiErr);

  /* ---- Run-time Configuration in Panelai/setConfig / ai/test / ai/resetConfig） ---- */
  await connectAI(`http://127.0.0.1:${aiPort}/v1`);
  const saved = await S.aiSetConfig({ model: "panel-model", persist: true });
  check("ai/setConfig：Model overwhelmed by its own configuration", !!saved && saved.model === "panel-model", JSON.stringify(saved && saved.model));
  check("ai/setConfig：Unchanged fields still come from connections (baseUrl）",
    !!saved && String(saved.baseUrl || "").indexOf("/v1") > 0, String(saved && saved.baseUrl));
  check("ai/setConfig：overridden Mark Fields Overrided",
    !!saved && (saved.overridden || []).indexOf("model") >= 0, JSON.stringify(saved && saved.overridden));

  const prefsEmpty = await S.getPrefs();
  check("ui/getPrefs：Read preferences", !!prefsEmpty && typeof prefsEmpty === "object",
    JSON.stringify(prefsEmpty));

  const tested = await S.aiTest({ baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: "fake-1" });
  check("ai/test：Unsaved parameters can also be successfully tested", !!tested && tested.success === true, JSON.stringify(tested).slice(0, 160));
  const afterTest = await S.aiConfig();
  check("ai/test：Do not change effective configuration", !!afterTest && afterTest.model === "panel-model", String(afterTest && afterTest.model));

  const reset = await S.aiResetConfig();
  check("ai/resetConfig：Go back to connect configuration.", !!reset && reset.model === "fake-1", String(reset && reset.model));

  const prefsSaved = await S.setPrefs({ sidebarWidth: 320, aiWidth: 460, aiPanelOpen: true });
  check("ui/setPrefs：Writing successfully", !!prefsSaved && !!prefsSaved.prefs, JSON.stringify(prefsSaved));
  const prefsBack = await S.getPrefs();
  check("ui/getPrefs：The width can read back.", !!prefsBack && prefsBack.sidebarWidth === 320 && prefsBack.aiWidth === 460,
    JSON.stringify(prefsBack));
  const clamped = await S.setPrefs({ aiWidth: 99999 });
  check("ui/setPrefs：The hyperwide width is contained.", !!clamped && clamped.prefs.aiWidth === 720,
    JSON.stringify(clamped && clamped.prefs));

  modelSrv.close();

  console.log("\n===== Pass. " + pass.length + " Item =====");
  pass.forEach((p) => console.log("  PASS  " + p));
  if (fail.length) {
    console.log("\n===== Failed " + fail.length + " Item =====");
    fail.forEach((f) => console.log("  FAIL  " + f));
  }
  console.log("\n----- storage Diagnosis Log -----");
  S.status().diag.forEach((l) => console.log("  " + l));
  console.log("\n----- Disk artifacts -----");
  const walk = (d, pre = "") => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const fp = path.join(d, e.name);
    console.log("  " + pre + e.name + (e.isDirectory() ? "/" : "  (" + fs.statSync(fp).size + " B)"));
    if (e.isDirectory()) walk(fp, pre + "  ");
  });
  walk(STORAGE_DIR);

  child.kill();
  console.log("\nRESULT: " + (fail.length ? "FAIL" : "PASS"));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error("harness error:", e);
  child.kill();
  process.exit(2);
});
