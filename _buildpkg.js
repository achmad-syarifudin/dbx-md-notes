// Construct directly from source code .dbxp（zip）。
//
// It has to be repeated. `dbx-plugin package` Three hard rules, or the host will refuse directly at the installation stage.
// （Host Source crates/dbx-plugin-runtime/src/plugins/installer.rs with manifest.rs）：
//
//   1) manifest.entrypoints.backend.executable It is important to point to the [real existence] document in the package.
//      The official packer will rewrite it. bin/<target>/<binary>[.exe]（target Like windows-x64，
//      **Only  windows We'll take the target. .exe** —— Official CLI executable_name() That's it.
//      Do not automate host resolution ".exe"，I wouldn't do it. target Directory replacement -- name not right
//      "Plugin backend executable does not exist" → The whole package. incompatible。
//   2) Must Contain checksums.json（algorithm Must be. "sha256"），and files
//      【Accuracy equals exclusion from package checksums.json / signature.json Every file outside.
//      One less and one more. "Plugin checksums do not cover the package exactly"。
//   3) signature.json Saveable, but only open at plugin center「Allow installation of unsigned development packages」After installation.
//
// In these three. 1 and 2 Any unsatisfied item is a direct failure of installation, as shown by「There's nothing left of it when it's finished.」。
//
// Usage:
//   node _buildpkg.js                            # Default windows-x64（Use backend/ )
//   node _buildpkg.js --target linux-x64         # Use _xbuild/ Cross-compilation under
//   node _buildpkg.js --target darwin-arm64 --exe <path>
//
// On multiplatforms: official CLI（dbx-plugin package）**Reject**Yes「Non-current host」target Pack up.
// （"Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform"），
// The official recommendation is CI Up by the platform matrix. But the side of this plugin is...**Pure Go、none cgo**，
// Direct cross-compilation _release.mjs），Locally, therefore, can also produce legal packages for other platforms.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const root = __dirname + path.sep;
const binary = "dbx-plugin-mdnotes";       // with dbx-plugin.toml [backend].binary Unanimously

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}
const target = argValue("--target") || "windows-x64";   // current_target(): {os}-{arch}
if (!/^[a-z0-9-]{1,64}$/.test(target)) {
  console.error(`\n[FATAL] target With illegal characters:${target}（Only lowercase letters are allowed/Numbers/-，With the official validate_artifact_target (unanimously)\n`);
  process.exit(1);
}

// Objective → Go GOOS/GOARCH。windows-x64 Use backend/ The one that was built by this body, the rest was cross-produced.
const GO_TRIPLES = {
  "windows-x64": ["windows", "amd64"],
  "windows-arm64": ["windows", "arm64"],
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
function resolveExe() {
  const explicit = argValue("--exe");
  if (explicit) { return explicit; }
  if (target === "windows-x64") { return root + `backend/${binary}.exe`; }
  const t = GO_TRIPLES[target];
  if (!t) {
    console.error(`\n[FATAL] Unknown target：${target}。Known:${Object.keys(GO_TRIPLES).join(", ")}\n`);
    process.exit(1);
  }
  return root + `_xbuild/${binary}-${t[0]}-${t[1]}${t[0] === "windows" ? ".exe" : ""}`;
}

const mani = JSON.parse(fs.readFileSync(root + "manifest.json", "utf8"));
const ver = mani.version || "0.0.0";
// Only  windows target has .exe（Alignment official executable_name()）
const exeRel = `bin/${target}/${binary}${target.startsWith("windows") ? ".exe" : ""}`;
const exePath = resolveExe();
const out = root + `dist/${mani.id}-${ver}-${target}.dbxp`;

if (!fs.existsSync(exePath)) {
  console.error(`\n[FATAL] not found target=${target} Sidecar binary:${exePath}`);
  console.error(`        Build first:CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -C backend -o ../_xbuild/${binary}-<os>-<arch> .`);
  console.error(`        （Or run. node _release.mjs Total platform for one output)\n`);
  process.exit(1);
}

// ---- 1) Rewrite manifest，Jean executable Consistent with the true path in the package ----
mani.entrypoints = mani.entrypoints || {};
mani.entrypoints.backend = Object.assign({}, mani.entrypoints.backend, { executable: exeRel });
const manifestBytes = Buffer.from(JSON.stringify(mani, null, 2) + "\n", "utf8");

// ---- 1.5) Frontend self-check: these two bug ♪ Once upon a time「Whole UI Quiet death. The notes will never be saved.」----
const htmlRaw = fs.readFileSync(root + "ui/index.html", "utf8");
const htmlLive = htmlRaw.replace(/<!--[\s\S]*?-->/g, "");          // The truth after removing the note. DOM
const liveIds = new Set([...htmlLive.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const appSrc = fs.readFileSync(root + "ui/app.js", "utf8");
const storeSrc = fs.readFileSync(root + "ui/storage.js", "utf8");
// Remove the comment before scanning: the historical error code is quoted in the note (e.g. `$("x").onclick = ...`），You can't be serious.
const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// (a) app.js Come in. `$("x").` I don't know.x It must be real; otherwise = Granted to null = TypeError，
//     And it's often located bindEvents/boot At the beginning, the entire interface will end.
const unsafe = [...appCode.matchAll(/\$\("([^"]+)"\)\s*\./g)].map(m => m[1]);
const badRefs = [...new Set(unsafe.filter(id => !liveIds.has(id)))];
if (badRefs.length) {
  console.error("\n[FATAL] app.js It doesn't exist. DOM Element performs attribute access (which leads to a break in start-up):");
  const srcLines = appSrc.split("\n");
  for (const id of badRefs) {
    const at = srcLines.map((l, i) => l.includes(`$("${id}")`) ? i + 1 : 0).filter(Boolean);
    console.error(`   - #${id}  (app.js Okay. ${at.join(", ") || "?"})`);
  }
  console.error("   Rehabilitation: change to safe binding click(id, fn) / on(id, ev, fn)，Or put the elements from HTML Put it out in the note.\n");
  process.exit(1);
}

// (b) Chile UI Node must be index.html It's real.
const CRITICAL = ["main", "store-status", "store-text", "tree", "editor", "title",
  "ai-panel", "aip-scroll", "aip-log", "aip-go", "aip-target", "aip-mode-none",
  "aip-view-chat", "aip-view-create", "ai-cfg-modal", "aic-save", "gutter-side", "gutter-ai"];
const missingCritical = CRITICAL.filter(id => !liveIds.has(id));
if (missingCritical.length) {
  console.error("\n[FATAL] index.html Missing key elements:" + missingCritical.join(", ") + "\n");
  process.exit(1);
}

// (b2) The same function states that the later stated will cover the front quietly, and the function name crashes without any hint.//      2026-09-21 Accident:confirmModal Defined twice (a string, a array),
//      The latter takes over the former. → removeNode Pass the string in. `lines.join is not a function` Throw the wrong one.
//      Assemble「Point deletes are not responding.」。
const fnLines = {};
appCode.split(/\r?\n/).forEach((l, i) => {
  const m = /^  function (\w+)\s*\(/.exec(l);
  if (m) { (fnLines[m[1]] = fnLines[m[1]] || []).push(i + 1); }
});
const dupFns = Object.keys(fnLines).filter(k => fnLines[k].length > 1);
if (dupFns.length) {
  console.error("\n[FATAL] app.js There is a duplicate function statement (the latter will cover the former and must be renamed):");
  dupFns.forEach(k => console.error(`   - ${k}  (Okay. ${fnLines[k].join(", ")})`));
  console.error("");
  process.exit(1);
}

// (d) The switch for the top diagnostic bar must be HTML Align: Switches true We have to have the elements.false If not,
//     Otherwise...「Switches on, but elements are commented on.」= renderDiag Silence. return，We'll have to wait and see.
const showDiagBar = /var\s+SHOW_DIAG_BAR\s*=\s*(true|false)/.exec(appCode);
if (!showDiagBar) {
  console.error("\n[FATAL] app.js Missing SHOW_DIAG_BAR Switches (the state of the top bar cannot be self-proven).\n");
  process.exit(1);
}
const diagBarLive = liveIds.has("diag-bar");
if (showDiagBar[1] === "true" && !diagBarLive) {
  console.error("\n[FATAL] SHOW_DIAG_BAR=true But... index.html Lee. #diag-bar Still noted: Please let go together.\n");
  process.exit(1);
}
if (showDiagBar[1] === "false" && diagBarLive) {
  console.error("\n[FATAL] SHOW_DIAG_BAR=false But... index.html Lee. #diag-bar It's still there: it shouldn't be on the line.\n");
  process.exit(1);
}

// (d2) Function Switches ENABLE_IMPORT must match HTML Unanimously: Turning off the switch should be taken off with the entrance.
//      Or else it will.「The button's on and off.」——It's more confusing than no button.
const enableImport = /var\s+ENABLE_IMPORT\s*=\s*(true|false)/.exec(appCode);
if (!enableImport) {
  console.error("\n[FATAL] app.js Missing ENABLE_IMPORT Switches (the enabler of the import function cannot self-identify).\n");
  process.exit(1);
}
const importBtnLive = liveIds.has("btn-import-md");
const importInputLive = liveIds.has("file-input");
if (enableImport[1] === "false" && (importBtnLive || importInputLive)) {
  console.error("\n[FATAL] ENABLE_IMPORT=false But... index.html Lee. #btn-import-md or #file-input It still exists: please comment.\n");
  process.exit(1);
}
if (enableImport[1] === "true" && !(importBtnLive && importInputLive)) {
  console.error("\n[FATAL] ENABLE_IMPORT=true But... index.html Lee. #btn-import-md / #file-input Note: Please release.\n");
  process.exit(1);
}

// (d3) Permission: This plugin is intended to [do not rely on] host-inside AI。
//      host.ai Only ≥0.6.20 And the host is present, permissions It's static -- it says it'll make the old host.
//      Directly rejected the package during the installation phase, for one「Do not return model reply」It is not worth it to block the user from the door.
//      It is solidified into a gate to prevent it from coming back.
if ((mani.permissions || []).indexOf("host.ai") >= 0) {
  console.error("\n[FATAL] manifest host.ai：This plugin only uses its own third-party model and should not rely on host-inside AI。");
  console.error("        It lifts the lowest host. 0.6.20，And the old host will reject the whole package directly during the installation phase.\n");
  process.exit(1);
}
// (d4) .dbx-store.json permissions must match manifest Unanimously,
//      Or the store paper. "Marketplace package permissions do not match catalog permissions"。
try {
  const pub = JSON.parse(fs.readFileSync(root + ".dbx-store.json", "utf8"));
  if (JSON.stringify(pub.permissions) !== JSON.stringify(mani.permissions)) {
    console.error("\n[FATAL] .dbx-store.json permissions with manifest Inconsistencies (the store will reject the package):");
    console.error("        manifest   : " + JSON.stringify(mani.permissions));
    console.error("        .dbx-store : " + JSON.stringify(pub.permissions) + "\n");
    process.exit(1);
  }
} catch (e) {
  console.warn("\n[WARN] I can't read. .dbx-store.json（Skip permission consistency check:" + e.message + "\n");
}

// (c) Frontend UI Version number must be manifest Unanimously, avoid.「It's new. It's old.」
const uiVer = (storeSrc.match(/var UI_VERSION = "([^"]+)"/) || [])[1];

if (uiVer !== ver) {
  console.error(`\n[FATAL] ui/storage.js UI_VERSION=${uiVer} with manifest.version=${ver} Inconsistencies.\n`);
  process.exit(1);
}
console.log("  By self-examination:DOM References 0 Sphere / Key elements ready. / UI_VERSION=" + uiVer);

// (e) Reminding us not to send a placeholder identity before the release. example You're gonna hit someone else's plug. id）
if (!mani.publisher || mani.publisher === "example" || /^com\.example\./.test(mani.id)) {
  console.warn("\n[WARN] manifest id / publisher Still has a place value." + mani.id + " / " + mani.publisher +
    "）：Please change to your own before the official release.\n");
}

// ---- 2) Collect package files ( Skipping) _ Prefix temporary files and hidden files)----
const files = [
  ["manifest.json", manifestBytes],
  [exeRel, fs.readFileSync(exePath)],
];
for (const dir of ["assets", "ui"]) {
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp, rel + "/" + e.name);
      else files.push([rel + "/" + e.name, fs.readFileSync(fp)]);
    }
  })(root + dir, dir);
}

// ---- 3) checksums.json It must be accurately covered to remove itself from signature.json All external files ----
const checksums = { algorithm: "sha256", files: {} };
for (const [name, data] of files) {
  checksums.files[name] = crypto.createHash("sha256").update(data).digest("hex");
}
files.push(["checksums.json", Buffer.from(JSON.stringify(checksums, null, 2) + "\n", "utf8")]);

// ---- 4) Write zip（deflate）----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const local = [];
const central = [];
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name, "utf8");
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const off = Buffer.concat(local).length;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8);              // deflate
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, comp);

  // ---- Unix Permission position (%1)macOS/Linux It has to be right, or the sidecar will not start.----
  // Host Installer(s)installer.rs）Unix Implementation:
  //     if let Some(mode) = entry.unix_mode() { set_permissions(from_mode(mode & 0o777)) }
  // And... zip crate unix_mode() `external_attributes == 0` returns directly on time None
  //   → Host skips permissions → Extracted file is default 0o644 → **The sidecar is not operational.**。
  // The official packer. bin/<target>/ Below 0o755、Other 0o644；Do it here.
  // Mode Bit Exists external_attributes High 16 bits, with high byte declaration System::Unix（3）It'll be read.
  const isExe = name === exeRel;
  const unixMode = isExe ? 0o100755 : 0o100644;   // S_IFREG | Permissions (with) zip crate I'm sure it's consistent.
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE((3 << 8) | 20, 4);  // version made by：High bytes 3 = Unix
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  // Note:JS `<<` yes 32 It's a bit of an operation.0o100644<<16 It's gonna spill out into negative numbers -- it has to be multiplied.
  ch.writeUInt32LE((unixMode * 0x10000) >>> 0, 38);
  ch.writeUInt32LE(off, 42);
  central.push(Buffer.concat([ch, nameBuf]));
}

const body = Buffer.concat(local);
const cd = Buffer.concat(central);
const eo = Buffer.alloc(22);
eo.writeUInt32LE(0x06054b50, 0);
eo.writeUInt16LE(files.length, 8);
eo.writeUInt16LE(files.length, 10);
eo.writeUInt32LE(cd.length, 12);
eo.writeUInt32LE(body.length, 16);

fs.mkdirSync(root + "dist", { recursive: true });
const pkg = Buffer.concat([body, cd, eo]);
fs.writeFileSync(out, pkg);

// By the official name. artifact.json
fs.writeFileSync(out.replace(/\.dbxp$/, ".artifact.json"), JSON.stringify({
  target,
  url: path.basename(out),
  sha256: crypto.createHash("sha256").update(pkg).digest("hex"),
  size: pkg.length,
}, null, 2) + "\n");

console.log("built " + out);
console.log("  target=" + target + "  size=" + pkg.length + "  entries=" + files.length);
console.log("  executable=" + exeRel + "  version=" + ver);
