/*
 * Storage v3（Reconstruct) - Strictly Press DBX Official plugin SDK ♪ The bridge is semantic
 * ==========================================================================
 *
 * Official SDK（Host Source apps/desktop/src/lib/plugins/pluginHostBridge.ts Lee.
 * pluginSdkSource()）Defined window.dbxPlugin Shape:
 *
 *   window.dbxPlugin = {
 *     ready,                    // Promise<Context on Workboard>  ← resolve It's pure data, no. API！
 *     get context(),            // Synchronize the context of the workspace
 *     get locale(), get theme(), get capabilities(),
 *     invoke(method, params, { timeoutMs }),   // Turn [sidecar] (backend)
 *     request(method, params),                 // Other Organiserhost.getContext / host.saveFile ...）
 *     notify(...), onContext(fn), onInit(fn), ...
 *   }
 *
 * Three hard rules."The notes will never be saved."The root causes:
 *
 *   1. API The object is always window.dbxPlugin In itself.
 *      It can't be written. ready.then(api => ...) And then... api Use when host object for... ready As a result,
 *      Context Data { connectionId, database, schema, values }，It didn't. invoke/request。
 *      Once written,dbxPlugin.invoke Yeah. undefined，The handshake of the sidecar must be thrown wrong and dropped directly back into the memory.
 *      （The official template is: `dbxPlugin.ready.then((context) => {...})` Then call.
 *       `window.dbxPlugin.request(...)`。）
 *
 *   2. Sidecar RPC Just go. `dbxPlugin.invoke(method, params, { timeoutMs })`；
 *      Host's way to go. `dbxPlugin.request(method, params)`。You can't mix them.
 *      Put "host.getContext" Here. invoke() It'll be used as a sidecar. The sidecar doesn't deserve it. handler。
 *
 *   3. Do not touch disk at the frontend. Plugin UI Run in sandboxed iframe（opaque origin）Lee,
 *      localStorage / IndexedDB / showDirectoryPicker / a.download None available.
 *      The only reliable landing route is `invoke() → Go Sidecar → Real .md Documentation`。
 *      So the floor [never silently degraded]: clear error reporting when side vehicles are not available (state) Column + A diagnostic panel)
 *      Memory backend is used only as session cache, and persistent=false / ok=false，Do not disguise as saved.
 *
 * Where does the repository come from (three layers of insurance, not dependent):
 *   a) Host connection process tune connection/connect Time storage_dir Hand over to the sidecar;
 *   b) The sidecar keeps it going. <DBX_PLUGIN_DATA_DIR>/config.json，Restart your own reading back.
 *   c) If the frontend is read in the context of the workstation storage_dir，Extra invoke("notes/setDir") Go to the bottom.
 *   Can't get frontend storage_dir Without prejudice to the landing — there's already one on the side. I'm not sure.
 *   Frontend storageDir Only for display.
 */
(function () {
  "use strict";

  var MD = window.MDNotes = window.MDNotes || {};

  var DATA_KEY = "com.lwai.mdnotes:data:v2";
  var RPC_TIMEOUT = 30000;
  var READY_TIMEOUT = 8000;   // Wait for the host. init Message
  var CTX_TIMEOUT = 2500;     // host.getContext Bottom
  var PING_TIMEOUT = 6000;    // Sidecar handshake
  var BRIDGE_TIMEOUT = 8000;  // Wait. window.dbxPlugin Injection
  var BRIDGE_PAYLOAD_LIMIT = 1.9 * 1024 * 1024; // Host ceiling 2 MiB，Leave some.
  var SAVE_DEBOUNCE = 400;
  // AI It's a time-out. Models often take dozens of seconds. 30 The second generic timeout will strangle normal requests.
  var AI_TIMEOUT = 180000;

  /* ============ Diagnosis log (page top diagnostic bar) + Status dialogs shared, updated in real time) ============ */

  var UI_VERSION = "0.8.4";   // Pack up the script and verify it with manifest.version Unanimously
  var T0 = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  /** milliseconds loaded from the module (time relative to each log to see where the card is) */
  function since() {
    var t = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    return t - T0;
  }

  var diag = [];
  var diagListeners = [];

  function note(step, ok, detail) {
    diag.push({
      at: Date.now(),
      t: since(),
      ok: (ok === true || ok === false) ? ok : null,   // null = Pure Information
      step: step,
      detail: detail ? String(detail).slice(0, 500) : ""
    });
    if (diag.length > 150) { diag.shift(); }
    for (var i = 0; i < diagListeners.length; i++) {
      try { diagListeners[i](); } catch (e) { /* ignore */ }
    }
  }

  function onDiag(fn) { if (typeof fn === "function") { diagListeners.push(fn); } }

  function diagLines() {
    return diag.map(function (d) {
      var mark = d.ok === true ? "[ OK ]" : (d.ok === false ? "[FAIL]" : "[ .. ]");
      return "+" + (d.t / 1000).toFixed(3) + "s " + mark + " " + d.step
        + (d.detail ? "  ->  " + d.detail : "");
    });
  }

  function errText(e) {
    if (!e) { return "Unknown error"; }
    if (typeof e === "string") { return e; }
    if (e.message) { return String(e.message); }
    if (e.error) { return String(e.error); }
    try { return JSON.stringify(e).slice(0, 300); } catch (e2) { return String(e); }
  }

  /** Environmental snapshot: judgement「Is the bridge there?」First-hand evidence. */
  function envSnapshot() {
    var a = null, keys = [], origin = "?";
    try { a = window.dbxPlugin; } catch (e) { a = null; }
    try { origin = String(window.origin); } catch (e) { origin = "?"; }
    try { keys = a ? Object.keys(a).slice(0, 30) : []; } catch (e) { keys = []; }
    return "origin=" + origin
      + " · sandboxed=" + isSandboxed()
      + " · showDirectoryPicker=" + (typeof window.showDirectoryPicker)
      + " · typeof window.dbxPlugin=" + (a ? typeof a : "undefined")
      + " · invoke=" + (a ? typeof a.invoke : "-")
      + " · request=" + (a ? typeof a.request : "-")
      + " · ready=" + (a && a.ready ? typeof a.ready.then : "-")
      + " · keys=[" + keys.join(",") + "]"
      + " · readyState=" + document.readyState;
  }

  /** Full diagnostic report (one key copy to developer) */
  function report() {
    var st = status;
    var L = [];
    L.push("=== DBX AI.MD Notes · Storage Diagnostic Report ===");
    L.push("Time: " + new Date().toLocaleString("en-US"));
    L.push("UI version: " + UI_VERSION);
    L.push("Page: " + (function () { try { return String(location.href); } catch (e) { return "?"; } })());
    L.push("UA: " + navigator.userAgent);
    L.push("");
    L.push("--- Environment ---");
    L.push(envSnapshot());
    L.push("");
    L.push("--- Status ---");
    L.push("backend=" + st.backend + " · persistent=" + st.persistent + " · ok=" + st.ok
      + " · available=" + st.available);
    L.push("hostAvailable=" + st.hostAvailable + " · sidecarAvailable=" + st.sidecarAvailable);
    L.push("connectionId=" + (st.connectionId || "(empty)"));
    L.push("storageDir=" + (st.storageDir || "(empty)") + " · dirConfigured=" + st.dirConfigured);
    L.push("storagePath=" + (st.storagePath || "(empty)"));
    L.push("sidecarError=" + (st.sidecarError || "(none)"));
    L.push("lastError=" + (st.lastError || "(none)"));
    L.push("payloadBytes=" + st.payloadBytes + " · lastSavedAt="
      + (st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleString("en-US") : "(not yet)"));
    L.push("");
    L.push("--- Diagnostic Log (" + diag.length + " entries, oldest first) ---");
    L.push(diagLines().join("\n") || "(none)");
    return L.join("\n");
  }

  // The module loads one and ensures that「Even UI Not at all.」There's something to see in the diagnosis.
  note("Storage module loaded (waiting for UI to call init)", null, "UI version " + UI_VERSION);

  /* ============================ Status ============================ */

  var listeners = [];
  var status = {
    backend: "unknown",     // sidecar | folder | memory | none
    persistent: false,
    available: false,
    ok: true,
    lastError: "",
    lastSavedAt: 0,
    hostAvailable: false,   // window.dbxPlugin Existence
    sidecarAvailable: false,
    sidecarError: "",       // The exact reason why the sidecar was not available.
    connectionId: "",
    storageDir: "",         // Directory of side vehicles actually in use (from side vehicle returns, authority)
    dirConfigured: false,   // Did the sidecar actually use the user's designation? storage_dir
    storagePath: "",        // meta.json absolute path
    fsSupported: false,
    folderName: "",
    backupOnly: false,      // true = Session Cache Only, No Real Cache
    payloadBytes: 0         // Last save Load Size
  };

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status); } catch (e) { /* ignore */ }
    }
  }
  function setStatus(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { status[k] = patch[k]; }
    }
    emit();
  }

  /* ============================ Small tool ============================ */

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withTimeout(promise, ms, msg) {
    var timer = null;
    var gate = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(msg + " (no response after " + ms + "ms)")); }, ms);
    });
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }
    return Promise.race([Promise.resolve(promise), gate]).then(
      function (v) { clear(); return v; },
      function (e) { clear(); throw e; }
    );
  }

  /** Put promise Harvest { ok, value | error }，Avoiding everywhere. try/catch */
  function settle(promise) {
    return Promise.resolve(promise).then(
      function (v) { return { ok: true, value: v }; },
      function (e) { return { ok: false, error: e }; }
    );
  }

  function nonEmptyStr(v) {
    return (typeof v === "string" && v.trim()) ? v.trim() : "";
  }

  /* ====================== Host Bridge Access ====================== */

  var api = null;          // window.dbxPlugin（API Object)
  var apiReady = false;    // Have you received the host? init

  /** Wait. window.dbxPlugin InjectionSDK Script in <head>，It's normal to synchronize; it's only for insurance. */
  function waitBridge(ms) {
    if (api) { return Promise.resolve(api); }
    var deadline = Date.now() + ms;
    return (function poll() {
      if (window.dbxPlugin && typeof window.dbxPlugin === "object") {
        api = window.dbxPlugin;
        return Promise.resolve(api);
      }
      if (Date.now() >= deadline) { return Promise.resolve(null); }
      return delay(25).then(poll);
    })();
  }

  /** Wait. ready —— Just wait for it. resolve，Never use its value (value is context data, no) API） */
  function waitReady(a) {
    if (apiReady) { return Promise.resolve(true); }
    var ready = (a && a.ready && typeof a.ready.then === "function") ? a.ready : Promise.resolve();
    return settle(withTimeout(ready, READY_TIMEOUT, "Waiting for host dbxPlugin.ready")).then(function (r) {
      apiReady = r.ok;
      note("Host bridge ready (dbxPlugin.ready)", r.ok, r.ok ? "Received host init message" : errText(r.error));
      return r.ok;
    });
  }

  /** Read the context on the desktop: Sync context Priority, host if missing request("host.getContext") Bottom */
  function readContext(a) {
    var sync = null;
    try { sync = a && a.context; } catch (e) { sync = null; }
    if (sync && typeof sync === "object" && Object.keys(sync).length) {
      note("Workspace context (synchronous dbxPlugin.context)", true, describeCtx(sync));
      return Promise.resolve(sync);
    }
    if (a && typeof a.request === "function") {
      return settle(withTimeout(a.request("host.getContext", {}), CTX_TIMEOUT, "Requesting host.getContext"))
        .then(function (r) {
          var ctx = (r.ok && r.value && typeof r.value === "object") ? r.value : {};
          var has = Object.keys(ctx).length > 0;
          note("Workspace context (fallback host.getContext)", r.ok && has,
            r.ok ? describeCtx(ctx) : errText(r.error));
          return ctx;
        });
    }
    note("Workspace context", false, "Host provides neither synchronous context nor request method");
    return Promise.resolve({});
  }

  function describeCtx(ctx) {
    var keys = Object.keys(ctx || {});
    return "Fields [" + keys.slice(0, 8).join(", ") + (keys.length > 8 ? ", …" : "") + "]";
  }

  /** Try to get it from the context. connectionId / storage_dir（It doesn't matter if you don't get it, see the header) */
  var DIR_KEYS = ["storage_dir", "storageDir", "storage_path", "storagePath", "notes_dir", "notesDir"];
  function extractPath(obj, keys, depth) {
    if (!obj || typeof obj !== "object" || depth > 4) { return ""; }
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (nonEmptyStr(v)) { return nonEmptyStr(v); }
    }
    var names = Object.keys(obj);
    for (var j = 0; j < names.length; j++) {
      var child = obj[names[j]];
      if (child && typeof child === "object") {
        var found = extractPath(child, keys, depth + 1);
        if (found) { return found; }
      }
    }
    return "";
  }

  function extractContext(ctx) {
    var connectionId = "";
    var storageDir = "";
    try {
      connectionId = nonEmptyStr(ctx.connectionId)
        || nonEmptyStr(ctx.connection && ctx.connection.id)
        || "";
      var ec = ctx.external_config || (ctx.connection && ctx.connection.external_config);
      if (ec) {
        for (var i = 0; i < DIR_KEYS.length; i++) {
          storageDir = nonEmptyStr(ec[DIR_KEYS[i]]);
          if (storageDir) { break; }
        }
      }
      if (!storageDir) { storageDir = extractPath(ctx, DIR_KEYS, 0); }
    } catch (e) { /* ignore */ }
    return { connectionId: connectionId, storageDir: storageDir };
  }

  /* ====================== Side lanes (single real permanence) ====================== */

  var client = null;  // { api, connectionId, storageDir }

  function rpcRaw(method, params, timeoutMs) {
    if (!client || !client.api || typeof client.api.invoke !== "function") {
      return Promise.reject(new Error("Sidecar channel not ready (host did not provide dbxPlugin.invoke)"));
    }
    var payload = {};
    if (client.connectionId) { payload.connectionId = client.connectionId; }
    for (var k in (params || {})) {
      if (Object.prototype.hasOwnProperty.call(params, k)) { payload[k] = params[k]; }
    }
    var out;
    try {
      out = client.api.invoke(method, payload, { timeoutMs: timeoutMs || RPC_TIMEOUT });
    } catch (e) {
      return Promise.reject(new Error(method + " call failed: " + errText(e)));
    }
    return Promise.resolve(out);
  }

  /**
   * Turn the car. The host's. invoke() Direct Map to backend.invoke，And put the sidecar. JSON-RPC result
   * As it is. resolve Come back; the sidecar is wrong and the host reject。There's only one compatible package.
   */
  function rpc(method, params, timeoutMs) {
    var started = since();
    var ms = function () { return (since() - started).toFixed(0) + "ms"; };
    return rpcRaw(method, params, timeoutMs).then(function (res) {
      if (res && typeof res === "object" && res.error && !res.ok && !res.data) {
        note("Sidecar call " + method, false, ms() + " · " + errText(res.error));
        throw new Error(errText(res.error));
      }
      var out = res;
      if (res && typeof res === "object" && res.result !== undefined
        && res.ok === undefined && res.data === undefined && res.path === undefined && res.dir === undefined) {
        out = res.result;
      }
      note("Sidecar call " + method, true, ms());
      return out;
    }, function (err) {
      note("Sidecar call " + method, false, ms() + " · " + errText(err));
      throw err;
    });
  }

  /* ====================== Session memory backend (cache only, not disguise for long) ====================== */

  function memoryBackend() {
    var mem = null;
    return {
      name: "memory",
      persistent: false,
      available: function () { return true; },
      read: function () { return mem; },
      write: function (data) { mem = data; return true; }
    };
  }

  /* ============ Local directory backend (non-sandbox environment only open) index.html time;DBX Not available internally) ============ */

  function isSandboxed() {
    try { return !window.origin || String(window.origin) === "null"; } catch (e) { return true; }
  }
  function fsSupported() {
    return typeof window.showDirectoryPicker === "function" && !isSandboxed();
  }

  var FS_FILE = "md-notes.json";
  var fsState = { handle: null, name: "" };

  function folderBackend() {
    return {
      name: "folder",
      persistent: true,
      available: function () { return !!fsState.handle; },
      read: function () {
        return fsState.handle.getFileHandle(FS_FILE, { create: false })
          .then(function (fh) { return fh.getFile(); })
          .then(function (f) { return f.text(); })
          .then(function (t) { return t ? JSON.parse(t) : null; })
          .catch(function () { return null; });
      },
      write: function (data) {
        return fsState.handle.getFileHandle(FS_FILE, { create: true })
          .then(function (fh) { return fh.createWritable(); })
          .then(function (w) {
            return w.write(JSON.stringify(data)).then(function () { return w.close(); });
          })
          .then(function () { return true; });
      }
    };
  }

  /* ============================ Current Backend ============================ */

  var current = null;
  var flushTimer = null;
  var pendingData = null;

  function readCurrent() {
    if (!current) { current = memoryBackend(); }
    var read = null;
    try { read = current.read(); } catch (e) { read = null; }
    return Promise.resolve(read).then(function (d) {
      if (d && d.data !== undefined) {
        return {
          data: (d.data && typeof d.data === "object") ? d.data : null,
          pending: d.pending || null,
          backend: current.name,
          persistent: current.persistent,
          firstRun: !(d.data && d.data.nodes)
        };
      }
      return {
        data: d || null,
        pending: null,
        backend: current.name,
        persistent: current.persistent,
        firstRun: !d
      };
    }).catch(function (err) {
      setStatus({ ok: false, lastError: errText(err) });
      note("Read notes", false, errText(err));
      return {
        data: null, pending: null,
        backend: current ? current.name : "memory",
        persistent: false, firstRun: true
      };
    });
  }

  /* ============================ Initialize ============================ */

  function failHard(reason) {
    setStatus({
      backend: "none", persistent: false, available: false, ok: false,
      sidecarAvailable: false, sidecarError: reason, lastError: reason,
      backupOnly: true
    });
    current = memoryBackend();
    client = null;
  }

  var initCalled = false;
  var initStartedAt = 0;

  function init() {
    initCalled = true;
    initStartedAt = since();
    note("=== Storage initialization started ===", null, UI_VERSION + " @ " + new Date().toLocaleTimeString("en-US"));
    note("Environment snapshot", null, envSnapshot());
    return waitBridge(BRIDGE_TIMEOUT).then(function (a) {
      note("Waiting for window.dbxPlugin injection", !!a, (since() - initStartedAt).toFixed(0) + "ms"
        + (a ? " · available" : " · timed out after " + BRIDGE_TIMEOUT + "ms"));
      if (!a) {
        var msg = "Host did not inject window.dbxPlugin (not in DBX plugin workspace)";
        note("Acquire dbxPlugin bridge", false, msg);
        setStatus({ hostAvailable: false, fsSupported: fsSupported() });
        failHard(msg);
        return fallbackResult(msg);
      }
      note("Acquire dbxPlugin bridge", true, "Available invoke=" + (typeof a.invoke) + " request=" + (typeof a.request));
      setStatus({ hostAvailable: true, fsSupported: fsSupported() });

      return waitReady(a).then(function () {
        return readContext(a);
      }).then(function (ctx) {
        var info = extractContext(ctx);
        setStatus({
          connectionId: info.connectionId,
          storageDir: info.storageDir,
          storagePath: info.storageDir
        });
        note("Parse connection context", !!info.connectionId || !!info.storageDir,
          "connectionId=" + (info.connectionId || "(none)") + " storage_dir=" + (info.storageDir || "(none; managed by sidecar)"));

        client = { api: a, connectionId: info.connectionId, storageDir: info.storageDir };

        // Synchronize when context updates (reconnection), not reconstruct iframe I can keep up.
        if (typeof a.onContext === "function") {
          try {
            a.onContext(function (next) {
              var nx = extractContext(next || {});
              if (nx.connectionId) { status.connectionId = nx.connectionId; }
              if (nx.storageDir) { status.storageDir = nx.storageDir; }
              if (client) {
                client.connectionId = nx.connectionId || client.connectionId;
                client.storageDir = nx.storageDir || client.storageDir;
              }
              emit();
            });
          } catch (e) { /* No old host. onContext，Ignore */ }
        }

        // —— The sidecar shakes hands: This is the real law of availability --
        return settle(withTimeout(rpc("notes/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "Sidecar handshake notes/ping"))
          .then(function (r) {
            if (!r.ok) {
              var why = "Sidecar unavailable: " + errText(r.error);
              note("Sidecar handshake notes/ping", false, errText(r.error));
              failHard(why);
              return fallbackResult(why);
            }
            var pl = r.value || {};
            note("Sidecar handshake notes/ping", true,
              "version=" + (pl.version || "?") + " dir=" + (pl.storagePath || pl.dir || "(not reported)")
              + " configured=" + (pl.configured === true));

            current = sidecarBackend();
            setStatus({
              backend: "sidecar", persistent: true, available: true, ok: true,
              lastError: "", sidecarAvailable: true, sidecarError: "",
              backupOnly: false,
              storageDir: nonEmptyStr(pl.storagePath) || status.storageDir,
              storagePath: nonEmptyStr(pl.storagePath) || status.storagePath,
              dirConfigured: pl.configured === true
            });

            // If the context reads storage_dir，Tell the sidecar to go under. config.json）
            if (info.storageDir) {
              settle(rpc("notes/setDir", { dir: info.storageDir }, PING_TIMEOUT)).then(function (s) {
                note("Sync storage directory to sidecar notes/setDir", s.ok,
                  s.ok ? ((s.value && s.value.dir) || info.storageDir) : errText(s.error));
                if (s.ok && s.value) {
                  setStatus({
                    storageDir: nonEmptyStr(s.value.dir) || status.storageDir,
                    storagePath: nonEmptyStr(s.value.path) || status.storagePath
                  });
                }
              });
            }

            return readCurrent().then(function (r) {
              r.connectionId = status.connectionId;
              r.storageDir = status.storageDir;
              r.path = status.storagePath;
              note("Read notes notes/load", true,
                "Node count=" + ((r.data && r.data.nodes && r.data.nodes.length) || 0) + " firstRun=" + r.firstRun);
              return r;
            });
          });
      });
    }).catch(function (err) {
      var msg = "Storage initialization error: " + errText(err);
      note("Storage initialization", false, errText(err));
      failHard(msg);
      return fallbackResult(msg);
    });
  }

  function fallbackResult(reason) {
    return readCurrent().then(function (r) {
      r.connectionId = status.connectionId;
      r.storageDir = "";
      r.path = "";
      r.backupOnly = true;
      r.error = reason;
      return r;
    });
  }

  /* ====================== Side end achieved ====================== */

  function jsonBytes(v) {
    try { return new Blob([JSON.stringify(v)]).size; }
    catch (e) {
      try { return JSON.stringify(v).length; } catch (e2) { return 0; }
    }
  }

  function sidecarBackend() {
    return {
      name: "sidecar",
      persistent: true,
      available: function () { return true; },
      read: function () {
        return rpc("notes/load", {}, RPC_TIMEOUT).then(function (pl) {
          if (!pl || typeof pl !== "object") { return null; }
          setStatus({
            storagePath: nonEmptyStr(pl.path) || status.storagePath,
            storageDir: nonEmptyStr(pl.dir) || status.storageDir,
            dirConfigured: pl.configured === true
          });
          return { data: pl.data || null, pending: pl.pending || null };
        });
      },
      write: function (data) {
        var bytes = jsonBytes(data);
        setStatus({ payloadBytes: bytes });
        if (bytes > BRIDGE_PAYLOAD_LIMIT) {
          var over = "Notebook size " + Math.round(bytes / 1024) + " KB exceeds the host bridge limit (2 MB) per request. "
            + "Split or shorten notes, then try again.";
          note("notes/save payload check", false, over);
          return Promise.reject(new Error(over));
        }
        var extra = { data: data };
        if (client && client.storageDir) { extra.storage_dir = client.storageDir; }
        return rpc("notes/save", extra, RPC_TIMEOUT).then(function (pl) {
          if (pl && typeof pl === "object") {
            setStatus({
              storagePath: nonEmptyStr(pl.path) || status.storagePath,
              storageDir: nonEmptyStr(pl.dir) || status.storageDir,
              dirConfigured: true
            });
          }
          note("notes/save", true,
            Math.round(bytes / 1024) + " KB -> " + (status.storagePath || "(sidecar did not report path)"));
          return true;
        });
      }
    };
  }

  /* ================== Host「Save As」：Let the user choose his directory ==================
   * Why do you have to walk the host? a.download：Plugin UI Run in opaque origin sandbox iframe Lee,
   * blob Navigation/Downloads will be cancelled by host silently (WKWebView Direct cancel），The frontend does not move any downloads.
   * Provided by the host host.saveFile The user-optional directories and filenames are written by it.
   *
   * Transfer mode (host source) apps/desktop/src/lib/plugins/pluginHostBridge.ts · host.saveFile）：
   *   - Pass Uint8Array / ArrayBuffer → postMessage Here. transfer Zero copies sent, maximum 512 MiB；
   *   - Pass base64 String          → Walk as Request Parameter JSON，2 MiB Parameter upper limit bound (consent) 1.5 MB Documentation.
   * That's why it's all over. ArrayBuffer，And must be precise in length. buffer —— SDK Lee.
   * `data instanceof Uint8Array ? data.buffer : …` ♪ Will take the whole ♪ underlying buffer Send it away.
   * If it's big buffer The view above, the drop-off content will add another piece of garbage.
   */

  /** The host. request Parameters have 2 MiB Upper limitenforcePayloadLimit）→ The top file (e.g., restoration of backup) should hold this level. */
  var MAX_UPSTREAM_BYTES = 1500 * 1000;

  function base64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i) & 0xff; }
    return out;
  }

  /** Got it.「Length Precision」ArrayBuffer（See comment above: View will be complete buffer Send them away) */
  function toExactBuffer(v) {
    if (v instanceof ArrayBuffer) { return v; }
    var u8;
    if (typeof v === "string") { u8 = base64ToBytes(v); }
    else if (v instanceof Uint8Array) { u8 = v; }
    else { u8 = new Uint8Array(v || 0); }
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) { return u8.buffer; }
    var copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return copy.buffer;
  }

  function hasHostSave() {
    return !!(api && typeof api.saveFile === "function");
  }

  /** It's the homeowner.「Save As」，Writes bytes to the directory selected by the user. Back {ok, canceled, path, error} */
  function hostSaveFile(fileName, contentType, bytes) {
    if (!hasHostSave()) {
      note("Host saveFile", false, "Current host lacks saveFile capability; cannot open save dialog");
      return Promise.resolve({
        ok: false, canceled: false, path: "",
        error: "Current DBX host does not support the Save As dialog"
      });
    }
    var buf, size = 0;
    try {
      buf = toExactBuffer(bytes);
      size = buf.byteLength;
    } catch (e) {
      note("Host saveFile", false, "Failed to prepare bytes: " + errText(e));
      return Promise.resolve({ ok: false, canceled: false, path: "", error: errText(e) });
    }
    var opts = { fileName: fileName, contentType: contentType };
    return Promise.resolve(api.saveFile(opts, buf)).then(function (res) {
      // Host document: When user cancels resolve null
      if (res === null || res === undefined) {
        note("Host saveFile", null, "User canceled save: " + fileName);
        return { ok: false, canceled: true, path: "", error: "Canceled" };
      }
      var p = (res && typeof res.path === "string") ? res.path : "";
      note("Host saveFile", true, fileName + " (" + size + " B) -> " + (p || "(host did not return path)"));
      return { ok: true, canceled: false, path: p, error: "" };
    }).catch(function (e) {
      note("Host saveFile", false, fileName + ": " + errText(e));
      return { ok: false, canceled: false, path: "", error: errText(e) };
    });
  }

  /* ============================ External API ============================ */

  var Store = {
    DATA_KEY: DATA_KEY,
    VERSION: UI_VERSION,

    onStatus: function (fn) {
      if (typeof fn === "function") { listeners.push(fn); }
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    /** Subscription to diagnostic log changes (one call back for every one down) for real-time updating of page top diagnostic bars */
    onDiag: onDiag,

    /** By UI Layer to fill in the same diagnostic log (first-end start-up phases) */
    log: function (step, ok, detail) { note(step, ok, detail); },

    /** Full diagnostic report text (one key copy) */
    report: report,

    env: envSnapshot,

    status: function () {
      var copy = {};
      for (var k in status) {
        if (Object.prototype.hasOwnProperty.call(status, k)) { copy[k] = status[k]; }
      }
      copy.diag = diagLines();
      return copy;
    },

    /** Initialize, return { data, pending, firstRun, connectionId, storageDir, path, backupOnly } */
    init: init,

    /** Rebound when context changes (not reconstructed) iframe The host will push context，I usually don't need to do it manually. */
    rebind: function () {
      return waitBridge(BRIDGE_TIMEOUT).then(function (a) {
        if (!a) { return Store.status(); }
        return readContext(a).then(function (ctx) {
          var info = extractContext(ctx);
          setStatus({ connectionId: info.connectionId, storageDir: info.storageDir });
          if (client) {
            client.connectionId = info.connectionId || client.connectionId;
            client.storageDir = info.storageDir || client.storageDir;
          }
          return Store.status();
        });
      }).catch(function () { return Store.status(); });
    },

    /** Manually specify notes memory directory (sideside) Car notes/setDir） */
    setDir: function (dir) {
      if (!nonEmptyStr(dir)) { return Promise.resolve({ ok: false, error: "Directory is empty" }); }
      return settle(rpc("notes/setDir", { dir: dir }, PING_TIMEOUT)).then(function (r) {
        if (!r.ok) {
          note("notes/setDir", false, errText(r.error));
          return { ok: false, error: errText(r.error) };
        }
        var pl = r.value || {};
        if (client) { client.storageDir = dir; }
        setStatus({
          storageDir: nonEmptyStr(pl.dir) || dir,
          storagePath: nonEmptyStr(pl.path) || status.storagePath,
          dirConfigured: true
        });
        note("notes/setDir", true, status.storageDir);
        return { ok: true, path: status.storagePath };
      });
    },

    /** Directory Selector (non-sand box environment only);DBX The button does not appear inside) */
    pickDirectory: function () {
      if (!fsSupported()) {
        return Promise.resolve({
          ok: false,
          error: "This environment does not allow frontend access to local directories (sandboxed iframe has no disk permission); the sidecar writes notes to the storage directory"
        });
      }
      return window.showDirectoryPicker({ mode: "readwrite" }).then(function (h) {
        fsState.handle = h;
        fsState.name = h.name || "";
        current = folderBackend();
        setStatus({
          backend: "folder", persistent: true, available: true, ok: true,
          lastError: "", folderName: fsState.name, backupOnly: false
        });
        note("Select local directory", true, fsState.name);
        return { ok: true, name: fsState.name };
      }).catch(function (e) {
        return { ok: false, error: errText(e) || "Canceled or not permitted" };
      });
    },

    fsSupported: fsSupported,
    folderName: function () { return fsState.name; },

    /** Read again with the current backend (sync after sidecar directory changes) UI） */
    reload: function () {
      return readCurrent().then(function (r) {
        r.connectionId = status.connectionId;
        r.storageDir = status.storageDir;
        r.path = status.storagePath;
        return r;
      });
    },

    /** Direct sidecar RPC（Export/Back-up back-end on-board,resolve Sidecar result */
    invoke: function (method, params) {
      return rpc(method, params, RPC_TIMEOUT);
    },

    /* ---------------- AI（Side-by-sidecar; front-end without the key or front-end) ----------------
     *
     * Design trade-offs: no longer dependent on host host.ai（Internal AI Panel.
     *   - That interface just...「Open Dialogue」，I can't do it without returning to the model.「And then I wrote back.」；
     *   - It needs host.ai Permissions, which are static - the old host will be directly denied at the installation stage when it encounters unknown privileges.
     *     It's all for an unserviceable entrance. <0.6.20 Users are blocking the door.
     * There is only one path left: a third-party model with a key and a direct connection from the sidecar.
     */

    /** The sidecar is now. AI Configure and Status (without key, only one) hasKey Boer) */
    aiConfig: function () {
      return rpc("ai/config", {}, RPC_TIMEOUT).catch(function () { return null; });
    },

    /**
     * Update AI Configure.cfg Including:
     *   enabled / provider / baseUrl / model / apiKey / systemPrompt / timeoutSecs / maxChars
     *   rememberKey（true = Allows the key to be written into the Plugin Data Directory)
     *   clearKey（true = Clear the key saved by this machine)
     * persist=false Only memory changes「Test connection」Use, don't drop the wheel.
     */
    aiSetConfig: function (cfg, persist) {
      var payload = { persist: persist !== false };
      var src = cfg || {};
      ["enabled", "provider", "baseUrl", "model", "apiKey", "systemPrompt",
        "timeoutSecs", "maxChars", "rememberKey", "clearKey"].forEach(function (k) {
          if (src[k] !== undefined) { payload[k] = src[k]; }
        });
      return rpc("ai/setConfig", payload, RPC_TIMEOUT);
    },

    /**
     * Sends a minimum request with a set of parameters (sustained with current effective configuration).
     * **No changes to effective configuration** —— It doesn't break the user's original configuration.
     */
    aiTest: function (cfg) {
      return rpc("ai/test", cfg || {}, AI_TIMEOUT);
    },

    /** Clear the configuration of this machine. Go back.「Based on connection configuration」 */
    aiResetConfig: function () {
      return rpc("ai/resetConfig", {}, RPC_TIMEOUT);
    },

    /** Jean. AI Processing a paragraph text.task ∈ analyze|polish|continue|ask */
    aiChat: function (task, text, instruction) {
      return rpc("ai/chat", { task: task, text: text, instruction: instruction || "" }, AI_TIMEOUT);
    },

    /** AI Call timeout (ms) for UI Show progress expectations */
    AI_TIMEOUT: AI_TIMEOUT,

    /* ---------------- UI Preferences (panel width, etc., Plugin data directories exist, not note directories) ---------------- */

    getPrefs: function () {
      return rpc("ui/getPrefs", {}, RPC_TIMEOUT)
        .then(function (r) { return (r && r.prefs) || {}; })
        .catch(function () { return {}; });
    },

    setPrefs: function (prefs) {
      return rpc("ui/setPrefs", { prefs: prefs || {} }, RPC_TIMEOUT).catch(function () { return null; });
    },

    /** Hosts offer「Save As」dialogue box (decision export)/Can Backup Make Users Choose Directory) */
    hasHostSave: hasHostSave,

    /** It's the homeowner.「Save As」，Write byte to the user selected directory */
    saveFile: hostSaveFile,

    /** Upline (frontend) → Single file size limit, see MAX_UPSTREAM_BYTES Comment */
    MAX_UPSTREAM_BYTES: MAX_UPSTREAM_BYTES,

    /** Write.debounce=true Merge multiple times within a short period of time */
    save: function (data, debounce) {
      if (debounce) {
        pendingData = data;
        if (flushTimer) { clearTimeout(flushTimer); }
        flushTimer = setTimeout(function () { Store.flush(); }, SAVE_DEBOUNCE);
        return Promise.resolve(true);
      }
      return Store.writeNow(data);
    },

    writeNow: function (data) {
      // Direct writing must cancel the hang-up tremors: otherwise the earlier queues of the old fast notes are in 400ms Backwards,
      // Write this (updated) overwrite. When the backup was restored, the entire restoration result was therefore covered back to its old state.
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pendingData = null;
      if (!current) { current = memoryBackend(); }
      var target = current;
      return Promise.resolve().then(function () {
        return target.write(data);
      }).then(function () {
        setStatus({
          ok: true, lastError: "", lastSavedAt: Date.now(),
          backend: target.name, persistent: target.persistent,
          available: target.name !== "memory",
          backupOnly: target.name === "memory"
        });
        return true;
      }).catch(function (err) {
        // Sidecar failure: trying to reconnect and try again.
        if (target.name === "sidecar") {
          return settle(withTimeout(rpc("notes/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "Reconnect sidecar"))
            .then(function (r) {
              if (r.ok) { return target.write(data); }
              throw err;
            }).then(function () {
              setStatus({ ok: true, lastError: "", lastSavedAt: Date.now() });
              return true;
            }).catch(function (again) {
              var msg = errText(again || err);
              setStatus({ ok: false, lastError: msg, sidecarAvailable: false, sidecarError: msg });
              note("notes/save", false, msg);
              return false;
            });
        }
        var m = errText(err);
        setStatus({ ok: false, lastError: m });
        note("Write notes", false, m);
        return false;
      });
    },

    flush: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingData) {
        var d = pendingData;
        pendingData = null;
        return Store.writeNow(d);
      }
      return Promise.resolve(true);
    },

    readFileAsText: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result)); };
        r.onerror = function () { reject(r.error || new Error("Failed to read file")); };
        r.readAsText(file);
      });
    },

    /** Read Local File As base64（Restore backup:zip It's binary, not textable. */
    readFileAsBase64: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var u8 = new Uint8Array(r.result);
          var s = "";
          for (var i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          }
          resolve(btoa(s));
        };
        r.onerror = function () { reject(r.error || new Error("Failed to read file")); };
        r.readAsArrayBuffer(file);
      });
    },

    /** Diagnosis text (storage of dialogs) */
    diagLines: diagLines
  };

  /* ====================== Watchdog: Leave evidence if you can't get results. ======================
   * Meaning of existence: the accidentbindEvents Dropped on the missing button → boot Interrupt → init() Never called)
   * At the frontend「State has always been unknown」，But there was no unusual hint. Watchdogs take this.「Zimmerka's dead.」
   * Turned into a diagnostic log. FAIL，Just say yes. UI It's not working. init，Not the storage problem.
   */
  var WATCHDOG_MARKS = [4000, 10000, 20000];
  WATCHDOG_MARKS.forEach(function (ms) {
    setTimeout(function () {
      try {
        if (!initCalled) {
          note("Watchdog +" + (ms / 1000) + "s", false,
            "Storage module loaded " + (ms / 1000) + " seconds ago, but init() was never called "
            + "→ UI startup stopped earlier (check below for 'Frontend startup interrupted / Page JS error')");
        } else if (status.backend === "unknown") {
          note("Watchdog +" + (ms / 1000) + "s", false,
            "Storage initialization has not completed (backend still unknown); last log entry shows where it stalled");
        }
      } catch (e) { /* ignore */ }
    }, ms);
  });

  // Page Hide/Write out the last editor before unmounting
  window.addEventListener("pagehide", function () { Store.flush(); });
  window.addEventListener("beforeunload", function () { Store.flush(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { Store.flush(); }
  });

  MD.storage = Store;
})();
