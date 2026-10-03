// Verify .dbxp：entries,manifest.executable、checksums Exact Overwrite + sha256、Key Code Tags
// Usage: node _verify.mjs [Some..dbxp]   Automatically take arguments when not given dist/ The newest one.
// And take it and the source code. manifest.json Version matching (prevention)「It's an old bag.」This fake green.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { removeTree, runProcess } from "./_testutil.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const srcMani = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const srcVer = srcMani.version;
const f = process.argv[2] || (() => {
  const dir = path.join(ROOT, "dist");
  const cands = fs.readdirSync(dir).filter((n) => n.endsWith(".dbxp"))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!cands.length) { console.error("dist/ Not down. .dbxp"); process.exit(2); }
  return path.join(dir, cands[0].n);
})();
console.log("Verify Package: " + f + "\nSource manifest.version = " + srcVer + "\n");
const buf = fs.readFileSync(f);

function entries(b) {
  const out = [];
  const off = b.length - 22;
  if (b.readUInt32LE(off) !== 0x06054b50) throw new Error("not a zip");
  const count = b.readUInt16LE(off + 10);
  let p = b.readUInt32LE(off + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    out.push({
      name: b.slice(p + 46, p + 46 + nameLen).toString("utf8"),
      method: b.readUInt16LE(p + 10),
      csize: b.readUInt32LE(p + 20),
      usize: b.readUInt32LE(p + 24),
      lho: b.readUInt32LE(p + 42),
      madeBy: b.readUInt16LE(p + 4),        // High bytes = Production System3 = Unix）
      ext: b.readUInt32LE(p + 38),          // External property: high 16 bits = Unix Permissions
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function read(e) {
  const nameLen = buf.readUInt16LE(e.lho + 26);   // Header:26=Length of file name, 28=Extension Length
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.csize);
  return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

const es = entries(buf);
const has = (n) => es.some((e) => e.name === n);
const get = (n) => { const e = es.find((x) => x.name === n); return e ? read(e) : null; };

console.log("=== Package Entry (" + es.length + ") ===");
es.forEach((e) => console.log("  " + e.name + "  (" + e.usize + " B)"));

const mani = JSON.parse(get("manifest.json").toString("utf8"));
const exeRel = mani.entrypoints.backend.executable;
const cks = JSON.parse(get("checksums.json").toString("utf8"));
const inPkg = es.map((e) => e.name).filter((n) => n !== "checksums.json" && n !== "signature.json").sort();
const listed = Object.keys(cks.files).sort();
const mismatch = [];
for (const e of es) {
  if (e.name === "checksums.json") continue;
  const h = crypto.createHash("sha256").update(read(e)).digest("hex");
  if (cks.files[e.name] !== h) mismatch.push(e.name);
}

// Parsing from File Name target（<id>-<version>-<target>.dbxp），Validate accordingly executable . The path and extension.
// Only  windows target has .exe —— Alignment official CLI executable_name()。
const baseName = path.basename(f);
const pkgPrefix = srcMani.id + "-" + srcMani.version + "-";
const pkgTarget = baseName.startsWith(pkgPrefix) && baseName.endsWith(".dbxp")
  ? baseName.slice(pkgPrefix.length, -".dbxp".length) : "";
const exeSuffix = pkgTarget.startsWith("windows") ? ".exe" : "";
const exeExpected = pkgTarget ? `bin/${pkgTarget}/dbx-plugin-mdnotes${exeSuffix}` : "";

/* ---- Start the side of the bag once. JSON-RPC Ask it three. ----
 * This is..."The binary in the bag does have new capabilities."The only reliable proof (see note below):grep String is unreliable.
 * But only right.**Main platform**"Package execution: Cross-compiled darwin/linux The binary won't run.
 * That scenario is marked as skip ——「Cross-compilation only ensures the byte is correct, and each platform still has to run once.」。
 */
const HOST_TARGET = (() => {
  const osName = process.platform === "win32" ? "windows" : process.platform;   // darwin | linux | windows
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osName}-${arch}`;
})();

async function probePackagedSidecar() {
  const out = { ok: false, detail: "", versionOk: false, version: "", probeOk: false, probeDetail: "", aiOk: false, aiDetail: "", aiSetOk: false, aiSetDetail: "", skip: false };
  if (pkgTarget && pkgTarget !== HOST_TARGET) {
    out.skip = true;
    out.detail = `Non-resident platform (package)=${pkgTarget} Here.=${HOST_TARGET}），Cannot execute - needs to smoke on this platform`;
    return out;
  }
  const exeBytes = get(exeRel);
  if (!exeBytes) { out.detail = "It's not in the bag. executable"; return out; }
  // Other Organiser os.tmpdir()：
  // This machine is in the sandbox from the system. TEMP Directly execute new written exe ♪ Will always ♪ EBUSY（CreateProcess I can't get up.
  // binary under item directory (%2)backend/*.exe、_xbuild/*）Implementation is normal -- two. e2e That's how it runs.
  const base = path.join(ROOT, "_verify_tmp", `probe-${process.pid}`);
  const exePath = path.join(base, path.basename(exeRel));
  const dataDir = path.join(base, "data");
  const storeDir = path.join(base, "store");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(exePath, exeBytes);
    if (!exeRel.endsWith(".exe")) { fs.chmodSync(exePath, 0o755); }
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "plugin/initialize", params: { host: { protocolVersions: [1] } } }),
      JSON.stringify({ jsonrpc: "2.0", id: "2", method: "notes/probe", params: { storage_dir: storeDir } }),
      JSON.stringify({ jsonrpc: "2.0", id: "3", method: "ai/config", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: "4", method: "ai/setConfig", params: { persist: false, model: "probe" } }),
    ].join("\n") + "\n";
    // Sidecar**We have to walk. spawn**（See _testutil.mjs：It's in the sandbox. spawnSync Anything. exe Both EBUSY，
    // They'll misjudge."The sidecar will not start."）。The newly written binary may have been killed for a short time, so try again.
    const env = { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir };
    const runProbe = () => runProcess(exePath, [], { env, input, timeoutMs: 60000 });
    let r = await runProbe();
    for (let i = 0; i < 4 && r.error && /EBUSY|EPERM|ETXTBSY|EACCES/.test(String(r.error.code || r.error.message)); i++) {
      await new Promise((res) => setTimeout(res, 500));
      r = await runProbe();
    }
    const replies = new Map();
    String(r.out || "").split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line);
        if (m && m.id != null) { replies.set(String(m.id), m); }
      } catch { /* Not JSON Line Ignore */ }
    });
    const init = replies.get("1");
    if (init && init.result && init.result.plugin) {
      out.ok = true;
      out.version = init.result.plugin.version;
      out.versionOk = out.version === mani.version;
    } else if (init && init.error) {
      out.detail = JSON.stringify(init.error).slice(0, 140);
    } else {
      // Report the error of the process itself: the reason for the failure.EBUSY / Timeout / Rights) and"The sidecar did not respond."It's completely different.
      // Write Only exit=null It's gonna take people to check the sidecar.
      const why = r.error ? ("Process Start/Implementation failed:" + r.error.message) : "No response.";
      out.detail = `${why}（exit=${r.code} signal=${r.signal || "-"} stderr=${String(r.err || "").slice(0, 140)}）`;
    }
    const pb = replies.get("2");
    out.probeOk = !!pb && !pb.error && !!(pb.result && pb.result.ok);
    out.probeDetail = pb
      ? (pb.error ? JSON.stringify(pb.error).slice(0, 100) : "ok dir=" + ((pb.result || {}).dir || ""))
      : "No response";
    const ai = replies.get("3");
    out.aiOk = !!ai && !ai.error && !!(ai.result && typeof ai.result.ready === "boolean");
    out.aiDetail = ai
      ? (ai.error ? JSON.stringify(ai.error).slice(0, 100) : JSON.stringify(ai.result).slice(0, 140))
      : "No response";
    const setCfg = replies.get("4");
    out.aiSetOk = !!setCfg && !setCfg.error && !!(setCfg.result && setCfg.result.model === "probe");
    out.aiSetDetail = setCfg
      ? (setCfg.error ? JSON.stringify(setCfg.error).slice(0, 100) : "model=" + (setCfg.result || {}).model)
      : "No response";
    return out;
  } catch (e) {
    out.detail = String((e && e.message) || e);
    return out;
  } finally {
    // Clean-up: delete the entire detection directory.base Include exe/data/store Three.
    // No need. fs.rmSync：This opportunity has been taken over."Move to trash"，Slow down.
    removeTree(base);
    removeTree(path.dirname(base));   // Clean it up. _verify_tmp
  }
}
const probeExe = await probePackagedSidecar();
const checks = [
  ["manifest.version Consistent with source code", mani.version === srcVer, mani.version + " vs " + srcVer],
  ["manifest.id Consistency with source code「It's old. id The bag.」）", mani.id === srcMani.id, mani.id + " vs " + srcMani.id],
  ["manifest.publisher Consistent with source code", mani.publisher === srcMani.publisher, mani.publisher + " vs " + srcMani.publisher],
  ["in file name target Legal", /^[a-z0-9-]{1,64}$/.test(pkgTarget), pkgTarget || "(Can't figure it out. target)"],
  ["executable Point bin/<target>/<binary>[.exe]（windows I'll bring it. .exe）",
    exeRel === exeExpected, exeRel + (exeExpected ? " vs " + exeExpected : "")],
  ["executable It's real in the bag.", has(exeRel)],
  ["checksums.algorithm = sha256", cks.algorithm === "sha256", cks.algorithm],
  ["checksums Exact overwrite package files", JSON.stringify(inPkg) === JSON.stringify(listed), "Package" + inPkg.length + " / List" + listed.length],
  ["All sha256 Match", mismatch.length === 0, mismatch.join(",")],
  ["none _ Prefix temporary file blending", !es.some((e) => /(^|\/)_/.test(e.name))],
  // Unix Permission: Host ' s installer.rs Only entry.unix_mode() It's time. set_permissions，
  // And... zip crate external_attributes==0（Or not the production system. Unix）Back None
  // → Extracted file is default 0644 → **There's no spot on the side.macOS/Linux Can't get up.**。
  ["Create a system statement to Unix（Otherwise the permission slot is ignored)", es.every((e) => (e.madeBy >> 8) === 3),
    es.map((e) => e.madeBy >> 8).join(",")],
  ["Executable tape 0755 Permission position", (() => {
    const e = es.find((x) => x.name === exeRel);
    return !!e && ((e.ext >> 16) & 0o777) === 0o755;
  })(), (() => { const e = es.find((x) => x.name === exeRel); return e ? "0" + ((e.ext >> 16) & 0o777).toString(8) : "(none)"; })()],
  ["Normal tape 0644 Permission position", es.filter((e) => e.name !== exeRel).every((e) => ((e.ext >> 16) & 0o777) === 0o644)],
];
const st = get("ui/storage.js").toString("utf8");
// Attention: no more."Is there a string in the binary?"When convicted - Go It merges./Split string data in a branch,
// SMS (e. g.) ai/status）There is no guarantee of continuous presence.grep They'll give you a fake. FAIL/PASS。
// To prove it."The sidecar in the bag does have that power."，Use the bottom one. probePackagedSidecar() Really ran once.
const ap = get("ui/app.js").toString("utf8");
const ix = get("ui/index.html").toString("utf8");
const cs = get("ui/styles.css").toString("utf8");
const apCode = ap.replace(/\/\*[\s\S]*?\*\//g, "");   // Go comment and scan.
// Evidence and _buildpkg.js Unanimously:`$("id").` That's it. id It's safe when it's real.
const liveIds = new Set([...ix.replace(/<!--[\s\S]*?-->/g, "").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const dangling = [...new Set([...apCode.matchAll(/\$\("([^"]+)"\)\s*\./g)].map((m) => m[1]))]
  .filter((id) => !liveIds.has(id));
checks.push(
  ["storage.js Here. window.dbxPlugin Yes API", st.includes("window.dbxPlugin")],
  ["storage.js No more. ready value API", !/resolve\(\s*\w+\s*\|\|/.test(st)],
  ["storage.js Use invoke(method, params, {timeoutMs})", /invoke\(method,\s*payload,\s*\{\s*timeoutMs/.test(st)],
  ["storage.js Use request('host.getContext') Bottom", st.includes('request("host.getContext"')],
  ["storage.js Backend with session memory (non-disguised persistence)", st.includes("memoryBackend")],
  ["storage.js Export diagnostic reports and door dog", st.includes("report: report") && st.includes("WATCHDOG_MARKS")],
  ["The top-set diagnostic bar is offline (HTML Not available #diag-bar）", !liveIds.has("diag-bar")],
  ["app.js Switches SHOW_DIAG_BAR=false", /var\s+SHOW_DIAG_BAR\s*=\s*false/.test(apCode)],
  ["app.js Switches SHOW_DIAG_LOG_IN_MODAL=false（Can not open message",
    /var\s+SHOW_DIAG_LOG_IN_MODAL\s*=\s*false/.test(apCode)],
  ["Keep the diagnostic code so that it can be released in the future.",
    ap.includes("verdictText") && ix.includes('id="diag-bar"') && ap.includes("SHOW_DIAG_LOG_IN_MODAL)")],
  ["styles.css Retain diagnostic bar style (reuse)", cs.includes(".diag-bar") && cs.includes(".diag-log")],
  ["Import function is offline (HTML Not available #btn-import-md / #file-input）",
    !liveIds.has("btn-import-md") && !liveIds.has("file-input")],
  ["app.js Switches ENABLE_IMPORT=false", /var\s+ENABLE_IMPORT\s*=\s*false/.test(apCode)],
  ["Import code to keep, so that one line can be released", ap.includes("function handleImport(") && ap.includes("function pickImportFiles(")],
  ["app.js No duplicate function declaration (the latter will cover the former silently)",
    (() => {
      const seen = {};
      apCode.split(/\r?\n/).forEach((l) => {
        const m = /^  function (\w+)\s*\(/.exec(l);
        if (m) { seen[m[1]] = (seen[m[1]] || 0) + 1; }
      });
      return Object.keys(seen).filter((k) => seen[k] > 1).length === 0;
    })()],
  ["Remove visible on frontend deletedIds（Not anymore.「It's not in the snapshot.」Deduce deletion)", ap.includes("deletedIds")],
  ["app.js Secure. click()/on()（Missing elements no longer sit together)", apCode.includes("function on(id, evName, handler, optional)")],
  ["app.js No missing elements directly retrieved properties", dangling.length === 0, dangling.join(",")],
  ["app.js Capture page level unprocessed anomalies", apCode.includes("unhandledrejection") && apCode.includes('window.addEventListener("error"')],
  ["app.js Not anymore. dbxPlugin.ready It's stuck.", !/dbxPlugin\.ready\.then\(boot\)/.test(apCode)],
  ["app.js Keep storage diagnostic panel code (switch off)", ap.includes("m-diag")],
  ["app.js Not sustained seed Example", ap.includes("res.firstRun && S.status().persistent")],
  ["storage.js UI_VERSION with manifest Unanimously",
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1] === srcVer,
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1]],

  /* ---- AI Accessv0.8.1：Use self-formulation only + persistent right sidebar, not dependent on host-inside AI） ---- */
  ["Do not depend on host-inside AI（manifest Undeclared host.ai）",
    Array.isArray(mani.permissions) && !mani.permissions.includes("host.ai"), JSON.stringify(mani.permissions)],
  ["engines.dbx Not AI Lift up.",
    !!(mani.engines && !/>=\s*0\.6\.20/.test(String(mani.engines.dbx))), JSON.stringify(mani.engines)],
  [".dbx-store.json permissions match manifest (localized display name may differ)",
    (() => {
      try {
        const pub = JSON.parse(fs.readFileSync(path.join(ROOT, ".dbx-store.json"), "utf8"));
        return JSON.stringify(pub.permissions) === JSON.stringify(mani.permissions);
      } catch { return false; }
    })(),
    (() => {
      try { const pub = JSON.parse(fs.readFileSync(path.join(ROOT, ".dbx-store.json"), "utf8")); return pub.name + " / " + JSON.stringify(pub.permissions); } catch { return "(I can't read.)"; }
    })()],
  ["AI Configure Fields Full ai_api_key secret )",
    (() => {
      const cp = (mani.contributions || []).find((c) => c.type === "connection-provider");
      const f = (cp && cp.fields) || [];
      const by = (k) => f.find((x) => x.key === k);
      return !!by("ai_enabled") && !!by("ai_base_url") && !!by("ai_model") &&
        !!by("ai_api_key") && by("ai_api_key").binding === "secret";
    })()],
  ["Yeah.「Test AI Connection」Form Action",
    (() => {
      const cp = (mani.contributions || []).find((c) => c.type === "connection-provider");
      return !!((cp && cp.actions) || []).find((a) => a.id === "test-ai");
    })()],
  ["AI Assistant is persistent right sidebar (#ai-panel，Not the window!",
    ix.includes('id="ai-panel"') && ix.includes("data-ai=") && ap.includes("setAIPanelOpen")],
  ["Default「Chat」Mode, create mode to display the object and task (#aip-create-only）",
    ix.includes('id="aip-view-chat"') && ix.includes('id="aip-view-create"') && ix.includes('id="aip-create-only"') &&
    ap.includes("aiIsChat") && ap.includes("setAIMode") && ap.includes("renderAIMode")],
  ["Only chat results「Copy」，The result is only four writing back.",
    ap.includes("AI_OPS_CHAT") && ap.includes("AI_OPS_CREATE") && ap.includes('kind: chat ? "chat" : "create"')],
  ["AI Configure free-standing bullet frames (no embedded form in chat area)",
    ix.includes('id="ai-cfg-modal"') && !ix.replace(/<!--[\s\S]*?-->/g, "").includes('id="aip-cfg"') &&
    st.includes('"ai/setConfig"') && st.includes('"ai/config"') && st.includes('"ai/resetConfig"') &&
    ap.includes("openAIConfigModal") && ap.includes("submitAIConfig") && ap.includes("clearLocalAIConfig")],
  ["Blink button line insinuate (the main button will not be rolled out of view when content is long)",
    /\.modal-card\s+\.modal-actions\s*\{[^}]*position:\s*sticky/.test(cs)],
  ["The result supports four operations (insertion to cursor) / Replace selection / Append to end / Copy)",
    ap.includes('{ op: "insert"') && ap.includes('{ op: "replace"') &&
    ap.includes('{ op: "append"') && ap.includes('{ op: "copy"')],
  ["Analyse object toggle / Clearable (not old value crucified when opened)",
    ix.includes('id="aip-mode-auto"') && ix.includes('id="aip-mode-selection"') &&
    ix.includes('id="aip-mode-note"') && ix.includes('id="aip-mode-none"') &&
    ap.includes("setAITargetMode") && ap.includes("aiTargetUsable") && ap.includes("bindAITargetWatch")],
  ["Basebar fixed, scrollable in the first half (buttons are not crowded out of view)",
    ix.includes('id="aip-scroll"') && cs.includes(".aip-scroll") &&
    /\.aip-compose\s*\{[^}]*flex:\s*none/.test(cs) && /#app\s*\{[^}]*grid-template-rows/.test(cs)],
  ["When no object is analysed「Ask / Continue writing」Still available (pure dialogue) / Free to generate)",
    ap.includes("noContext") && ap.includes("aiCanRun") && ap.includes("aiInputText") &&
    ap.includes('noContext: true')],
  ["Three columns to drag to adjust width + Preference for sustainability)",
    ix.includes('id="gutter-side"') && ix.includes('id="gutter-ai"') &&
    ap.includes("bindGutter") && ap.includes("setPointerCapture") &&
    st.includes('"ui/setPrefs"') && st.includes('"ui/getPrefs"')],
  ["AI Call side vehicle (frontend unconnected model)", st.includes('"ai/chat"') && st.includes('"ai/config"')],
  ["The frontend no longer calls the host-inside AI（openConversation / hostAISupported Removed)",
    !ap.includes("hostAISupported") && !ap.includes("openConversation") && !st.includes("openConversation")],
  ["Frontend/There's no hard code in the bag. API Key Form", !/sk-[A-Za-z0-9_-]{16,}/.test(ap + st)],

  /* ---- Binary in package「I ran once.」（Machine platform only; cross-platform package not possible, marked as SKIP） ---- */
  ["The side of the bag can be activated and finished. plugin/initialize", probeExe.ok, probeExe.detail, probeExe.skip ? "skip" : ""],
  ["The car inside the bag. manifest Unanimously", probeExe.versionOk, probeExe.version, probeExe.skip ? "skip" : ""],
  ["Car support inside the bag notes/probe（Writing channel available)", probeExe.probeOk, probeExe.probeDetail, probeExe.skip ? "skip" : ""],
  ["Car support inside the bag ai/config（AI It's really in the bag.", probeExe.aiOk, probeExe.aiDetail, probeExe.skip ? "skip" : ""],
  ["Car support inside the bag ai/setConfig（Panel configuration is really available)", probeExe.aiSetOk, probeExe.aiSetDetail, probeExe.skip ? "skip" : ""],
);

console.log("=== Verify ===");
let fails = 0;
let skips = 0;
for (const [name, ok, extra, mode] of checks) {
  if (mode === "skip") {
    skips++;
    console.log("  SKIP  " + name + (extra ? "  |  " + extra : ""));
    continue;
  }
  if (!ok) fails++;
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  |  " + extra : ""));
}
console.log("\nRESULT: " + (fails ? "FAIL(" + fails + ")" : "PASS") +
  (skips ? "（Other " + skips + " (As a result of skipping off the current platform)" : ""));
process.exit(fails ? 1 : 0);
