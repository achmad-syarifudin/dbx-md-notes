// One output**All platforms**Other Organiser + `release-candidates.json`。
//
// Background (official documents and CLI Source empirical:
//   - `dbx-plugin package` Press Only**Current host**Platform packs; visible transmission --target Pointing to another platform will be rejected:
//     "Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform"
//     → The official multiplatform approach is CI Open the platform matrix, build each other and merge it. release-candidates.json。
//   - The side of this plugin is... **Pure Go、none cgo**，So you can cross-compile directly.CGO_ENABLED=0），
//     Windows It's good enough to produce. darwin-arm64 / linux-x64 The legal package.
//     ⚠️ The cross-compilation is...**Byte Correct**，Not equal to**Checked on target.** —— The real smoke still needs to run on every platform.
//
// Usage:
//   node _release.mjs                                  # windows-x64 + darwin-arm64 + linux-x64
//   node _release.mjs windows-x64 linux-x64            # Do only specified platforms
//
// Product:
//   dist/<id>-<version>-<target>.dbxp
//   dist/<id>-<version>-<target>.artifact.json
//   dist/release-candidates.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./_testutil.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BINARY = "dbx-plugin-mdnotes";
const GO = process.env.DBX_GO || "go";
const GOROOT = process.env.DBX_GOROOT;
const NODE = process.execPath;

// target → Go Triple Group of the Tool Chain (official) current_target() Name of:darwin/linux/windows + arm64/x64）
const TRIPLES = {
  "windows-x64": ["windows", "amd64"],
  "windows-arm64": ["windows", "arm64"],
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
const DEFAULT_TARGETS = ["windows-x64", "darwin-arm64", "linux-x64"];
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = (targets.length ? targets : DEFAULT_TARGETS).slice().sort();

for (const t of list) {
  if (!TRIPLES[t]) {
    console.error(`[FATAL] Unknown target：${t}。Known:${Object.keys(TRIPLES).join(", ")}`);
    process.exit(1);
  }
}

const mani = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const ver = mani.version;

// Use**Step** spawn（See _testutil.mjs）：It's in the sandbox. spawnSync Anything. exe All straight. EBUSY。
async function run(cmd, args, opts = {}) {
  const r = await runProcess(cmd, args, { cwd: ROOT, env: opts.env || process.env, timeoutMs: 600000 });
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  if (r.error) {
    console.error(`[FATAL] Unable to execute command${r.error.message}）：${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
  if (r.code !== 0) {
    console.error(`[FATAL] Command failed (%1)exit ${r.code}${r.signal ? " signal=" + r.signal : ""}）：${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
  return r.out || "";
}

console.log(`=== Build ${list.length} Platforms:${list.join(", ")} ===\n`);

// ---- 1) Cross-compile side vehicle ----
for (const t of list) {
  const [goos, goarch] = TRIPLES[t];
  // Note:`go build -C backend` It'll cut first. backend/，So... -o Relative. backend/ Yeah.
  const outArg = `../_xbuild/${BINARY}-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
  const shown = outArg.replace(/^\.\.\//, "");
  process.stdout.write(`[build] ${t.padEnd(13)} GOOS=${goos} GOARCH=${goarch} -> ${shown}\n`);
  await run(GO, ["build", "-C", "backend", "-o", outArg, "."], {
    env: { ...process.env, ...(GOROOT ? { GOROOT } : {}), CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
}

// ---- 2) Packing by Platform ----
console.log("");
for (const t of list) {
  const [goos, goarch] = TRIPLES[t];
  const exe = path.join(ROOT, "_xbuild", `${BINARY}-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`);
  await run(NODE, [path.join(ROOT, "_buildpkg.js"), "--target", t, "--exe", exe]);
}

// ---- 3) Individual verification (package structure) / checksums / executable Path and Extension) ----
console.log("");
const pkgOf = (t) => path.join(ROOT, "dist", `${mani.id}-${ver}-${t}.dbxp`);
for (const t of list) {
  console.log(`--- verify ${t} ---`);
  await run(NODE, [path.join(ROOT, "_verify.mjs"), pkgOf(t)]);
}

// ---- 4) Summary release-candidates.json ----
// Structure Alignment DBX Store Official publication process:plugin MetaInfo + artifacts（Every platform. target/url/sha256/size）。
// url Use**Filename**（With the official artifact.json Unanimously; candidate base GitHub Release / CDN Go, go.
// By dbx-store Synchronise Workflow Read this document to generate candidates PR。
const artifacts = [];
for (const t of list) {
  const ap = path.join(ROOT, "dist", `${mani.id}-${ver}-${t}.artifact.json`);
  if (!fs.existsSync(ap)) {
    console.error(`[FATAL] Missing ${path.basename(ap)}`);
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(ap, "utf8"));
  artifacts.push({ target: a.target, url: a.url, sha256: a.sha256, size: a.size });
}
artifacts.sort((x, y) => x.target.localeCompare(y.target));

const payload = {
  plugin: {
    id: mani.id,
    name: mani.name,
    description: mani.description,
    publisher: mani.publisher,
    version: mani.version,
    permissions: mani.permissions || [],
  },
  artifacts,
};
const rcPath = path.join(ROOT, "dist", "release-candidates.json");
fs.writeFileSync(rcPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log("\n=== release-candidates.json ===");
console.log(JSON.stringify(payload, null, 2));
console.log(`\nSynchronising folder ${rcPath}`);
console.log(`Total ${artifacts.length} Platform products:${artifacts.map((a) => a.target + "(" + a.size + "B)").join("  ")}`);
