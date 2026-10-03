/*
 * AI.MD Notes, master logic
 * Dependency (by index.html Load order:sql-highlight.js、markdown.js、storage.js
 *
 * Refurbishment:
 *  - Loss of notes: multiple backend of storage + Writing failed visible;only「There is no data.」Only then start with an example
 *  - Directory tree: Notes/Folder icon differentiates and supports moving to any folder (dialog) + Drag, Right Key Menu
 *  - Export: Secure file name, duplicate-name handling, downgraded to「Replicable」Dialog, support folder export zip
 *  - Experience: Statusbar (store backend)/Number of words/View Switch, Empty Status,Toast、Shortcut, Dark Theme Follow DBX
 */
(function () {
  "use strict";

  var S = window.MDNotes.storage;
  function $(id) { return document.getElementById(id); }

  /**
   * Secure binding: The element is kept in a diagnostic log when it does not exist and skips, and no error is thrown to interrupt the start.
   * Historical accidents:index.html Lee. `btn-copy-sql` It's been said off, and... bindEvents It still says
   *   `$("btn-copy-sql").onclick = copySqlToDbx;`
   * → TypeError: Cannot set properties of null
   * → bindEvents Break here. 40 Multiple bindings not executed)
   * → boot() First line is wrong. → applyTheme/renderStatus/S.init Never implemented
   * → As in「All buttons hold still. + Storage status stopped. unknown + The notes will never leave behind.」。
   * Now, the missing elements will only be recorded in the log and will no longer be tied to the back.
   */
  function on(id, evName, handler, optional) {
    var el = $(id);
    if (!el) {
      S.log("Bind " + evName + " → #" + id, optional ? null : false,
        optional
          ? "Element not found (disabled in HTML); feature skipped"
          : "Element not found in DOM (commented out or removed); feature unavailable, other bindings unaffected");
      return null;
    }
    el[evName] = handler;
    return el;
  }
  function click(id, handler, optional) { return on(id, "onclick", handler, optional); }

  /** Page-level error capture: Any uncaught exception enters the top diagnostic bar and fails silently */
  window.addEventListener("error", function (e) {
    var where = (e && e.filename)
      ? " @ " + String(e.filename).split(/[\\/]/).pop() + ":" + (e.lineno || 0) + ":" + (e.colno || 0)
      : "";
    S.log("Page JavaScript error", false, ((e && e.message) || "Unknown error") + where);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    S.log("Unhandled Promise rejection", false, (r && (r.message || r.stack)) || String(r));
  });

  var state = {
    nodes: [],        // [{id,type:'folder'|'note',name,parentId,content,createdAt,updatedAt}]
    activeId: null,
    expanded: {},
    view: "split",
    query: "",
    loaded: false,
    // Node in this session [User 's visible deleted] id（Can not delete folder: %s: No such folder
    // Accumulated, not cleaned: one more time deleted id It is harmless, and the omission would make the deletion ineffective.
    // This is the list for the backend. Never.「Not in the snapshot.」Consider delete -- otherwise the other end (the other one in the same directory)
    // When you save old snapshots, you delete the new notes here.
    deletedIds: [],
    // It's not in the text. id：Such notes [can't] write back the body (will empty the disk).
    // By notes/load contentMissing Mark fill.
    contentMissing: {}
  };
  var manualTheme = null;
  var configuredDir = "";   // From the connection form.「Note Storage Directory」（Host in, read and write only at the frontend)
  var dragId = null; // Keep compatible, pointer drag pdrag
  var pdrag = null; // Pointer drag state:{id, n, row, startX, startY, moved, ghost}
  var previewTimer = null;
  var toastTimer = null;

  // ---------------- Basic tools ----------------
  function uid() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() { return new Date().toISOString(); }

  function byId(id) {
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].id === id) { return state.nodes[i]; }
    }
    return null;
  }
  function childrenOf(pid) {
    var p = pid || null;
    return state.nodes.filter(function (n) { return (n.parentId || null) === p; });
  }
  function isDescendant(id, ancestorId) {
    var n = byId(id), guard = 0;
    while (n && n.parentId && guard < 64) {
      if (n.parentId === ancestorId) { return true; }
      n = byId(n.parentId); guard++;
    }
    return false;
  }
  function countNotes(pid) {
    var total = 0;
    childrenOf(pid).forEach(function (n) {
      if (n.type === "note") { total++; } else { total += countNotes(n.id); }
    });
    return total;
  }
  function sortNodes(list) {
    return list.slice().sort(function (a, b) {
      if (a.type !== b.type) { return a.type === "folder" ? -1 : 1; }
      return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
    });
  }
  function uniqueName(pid, name, excludeId) {
    var taken = {};
    childrenOf(pid).forEach(function (n) {
      if (n.id !== excludeId) { taken[String(n.name).toLowerCase()] = true; }
    });
    if (!taken[String(name).toLowerCase()]) { return name; }
    var i = 2;
    while (taken[(name + " (" + i + ")").toLowerCase()]) { i++; }
    return name + " (" + i + ")";
  }
  function stripExt(name) {
    return String(name || "").replace(/\.(md|markdown|txt)$/i, "");
  }
  function activeNote() {
    var n = state.activeId ? byId(state.activeId) : null;
    return n && n.type === "note" ? n : null;
  }
  function selectedNode() {
    return state.activeId ? byId(state.activeId) : null;
  }
  /** Default folder to which to drop when new notes are created: Current selected file Catalog → Synchronising folder → Root Directory */
  function targetFolderId() {
    var n = selectedNode();
    if (!n) { return null; }
    return n.type === "folder" ? n.id : (n.parentId || null);
  }

  // ---------------- Enduring ----------------
  function snapshot() {
    // Note not read in text. content Fields): Seed at Backend"No text."Keeps the disk content as it is.
    // If there's an empty string here, the backend will take it."The user cleared the text."Writing discs -- notes are really gone.
    var nodes = state.nodes.map(function (n) {
      if (n.type !== "note" || !state.contentMissing[n.id]) { return n; }
      var copy = {};
      for (var k in n) { if (k !== "content") { copy[k] = n[k]; } }
      return copy;
    });
    return {
      version: 2,
      nodes: nodes,
      deletedIds: state.deletedIds.slice(),
      activeId: state.activeId,
      expanded: state.expanded,
      view: state.view,
      updatedAt: Date.now()
    };
  }
  function persist(debounce) {
    if (!state.loaded) { return; }
    S.save(snapshot(), debounce !== false);
  }

  /** The text of which notes were not read. contentMissing Mark) and give visible hints */
  function indexContentMissing(nodes) {
    state.contentMissing = {};
    var n = 0;
    (nodes || []).forEach(function (x) {
      if (x && x.type === "note" && x.contentMissing) { state.contentMissing[x.id] = true; n++; }
    });
    if (n) {
      toast(n + " notes have not availableable content files. Editing is locked to prevent overwriting them. Check the storage directory.", "warn");
      S.log("Notes with missing content found during load", false, n + " locked");
    }
    return n;
  }

  /**
   * Put「Load Results」Apply to state，Returns successfully true。
   *
   * Pipe:S.init() / S.reload() resolve {data:{nodes,...}, firstRun, ...}，
   * Note data in .data This floor, not at the top. The wrong layer will fail silently (no security conditions are in place).
   * And...「Change Storage Directory」or「Restore Backup」The back interface still shows the old state, the next one.
   * persist And write back the old state on disk -- it's the same way to erase the just finished results.
   */
  function applyLoaded(res) {
    var d = (res && res.data) ? res.data : res;
    if (!d || Object.prototype.toString.call(d.nodes) !== "[object Array]") { return false; }
    state.nodes = d.nodes;
    state.activeId = d.activeId || null;
    state.expanded = d.expanded || {};
    if (d.view) { setView(d.view); }
    // Reload = The world was replaced as a whole: the previously accumulated deletion records were invalidated and the missing text mark was reconstructed with new data.
    state.deletedIds = [];
    indexContentMissing(d.nodes);
    if (state.activeId && !byId(state.activeId)) { state.activeId = null; }
    if (!state.activeId) {
      var firsts = state.nodes.filter(function (n) { return n.type === "note"; });
      if (firsts.length) { state.activeId = firsts[0].id; }
    }
    return true;
  }

  // ---------------- Icon ----------------
  var ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M2 4.3c0-.6.5-1.1 1.1-1.1h2.5l1.3 1.6h6c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    note: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M4 2.2h5.3L12 4.9V13.8H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M6 7.4h4.4M6 9.8h4.4M6 12.1h2.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path d="M6 4.2l4 3.8-4 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function iconSpan(kind, cls) {
    var s = document.createElement("span");
    s.className = "ico " + (cls || kind);
    s.innerHTML = ICONS[kind] || "";
    return s;
  }

  // ---------------- Theme ----------------
  function hostTheme() {
    try {
      var d = window.dbxPlugin;
      if (d && typeof d.theme === "string") { return d.theme; }
      if (d && d.theme && typeof d.theme.mode === "string") { return d.theme.mode; }
      var attr = document.documentElement.getAttribute("data-dbx-theme");
      if (attr) { return attr.indexOf("dark") >= 0 ? "dark" : "light"; }
    } catch (e) { /* ignore */ }
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) { return "dark"; }
    } catch (e) { /* ignore */ }
    return "light";
  }
  function applyTheme() {
    var m = manualTheme || hostTheme();
    document.documentElement.setAttribute("data-theme", m);
    if (m === "dark") { document.body.classList.add("dark"); } else { document.body.classList.remove("dark"); }
  }

  // ---------------- Toast ----------------
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------- General Blast Window ----------------
  function closeModal() {
    var m = $("modal");
    m.hidden = true;
    m.textContent = "";
    m.onclick = null;
  }
  function openModal(build) {
    var m = $("modal");
    closeModal();
    m.hidden = false;
    var card = document.createElement("div");
    card.className = "modal-card";
    build(card);
    m.appendChild(card);
    m.onclick = function (e) { if (e.target === m) { closeModal(); } };
    var first = card.querySelector("input,textarea");
    if (first) { first.focus(); if (first.select) { first.select(); } }
  }
  function modalButtons(parent, buttons) {
    var wrap = document.createElement("div");
    wrap.className = "modal-actions";
    buttons.forEach(function (b) {
      var el = document.createElement("button");
      el.textContent = b.text;
      if (b.primary) { el.className = "primary"; }
      if (b.danger) { el.className = "danger"; }
      el.onclick = b.onClick;
      wrap.appendChild(el);
    });
    parent.appendChild(wrap);
    return wrap;
  }
  function promptModal(title, label, value, okText) {
    return new Promise(function (resolve) {
      var input;
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var lb = document.createElement("label"); lb.className = "m-label"; lb.textContent = label; card.appendChild(lb);
        input = document.createElement("input");
        input.className = "m-input";
        input.value = value || "";
        input.onkeydown = function (e) {
          if (e.key === "Enter") { done(true); }
          if (e.key === "Escape") { done(false); }
        };
        card.appendChild(input);
        modalButtons(card, [
          { text: "Cancel", onClick: function () { done(false); } },
          { text: okText || "OK", primary: true, onClick: function () { done(true); } }
        ]);
      });
      function done(ok) {
        if (!ok) { closeModal(); resolve(null); return; }
        var v = String(input.value || "").trim();
        if (!v) { toast("Name cannot be empty", "warn"); return; }
        closeModal(); resolve(v);
      }
    });
  }
  function confirmModal(title, message, okText, danger) {
    return new Promise(function (resolve) {
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var p = document.createElement("p"); p.className = "m-msg"; p.textContent = message; card.appendChild(p);
        modalButtons(card, [
          { text: "Cancel", onClick: function () { closeModal(); resolve(false); } },
          { text: okText || "OK", primary: !danger, danger: !!danger, onClick: function () { closeModal(); resolve(true); } }
        ]);
      });
    });
  }
  function moveModal(node) {
    return new Promise(function (resolve) {
      var sel;
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = "Move to…"; card.appendChild(h);
        var p = document.createElement("p");
        p.className = "m-msg";
        p.textContent = "Move “" + node.name + "” to:" + (node.type === "folder" ? " (including all its contents)" : "");
        card.appendChild(p);
        sel = document.createElement("select");
        sel.className = "m-input";
        folderOptions(node.id).forEach(function (o) {
          var op = document.createElement("option");
          op.value = o.id; op.textContent = o.label;
          sel.appendChild(op);
        });
        card.appendChild(sel);
        modalButtons(card, [
          { text: "Cancel", onClick: function () { closeModal(); resolve(null); } },
          { text: "Move", primary: true, onClick: function () { closeModal(); resolve(sel.value); } }
        ]);
      });
    });
  }
  function folderOptions(excludeId) {
    var out = [{ id: "", label: "(Root)" }];
    function walk(pid, depth) {
      sortNodes(childrenOf(pid)).forEach(function (n) {
        if (n.type !== "folder") { return; }
        if (excludeId && (n.id === excludeId || isDescendant(n.id, excludeId))) { return; }
        out.push({ id: n.id, label: new Array(depth + 1).join("　") + n.name });
        walk(n.id, depth + 1);
      });
    }
    walk(null, 0);
    return out;
  }

  // ---------------- Directory Tree Rendering ----------------
  function highlightInto(el, text, q) {
    el.textContent = "";
    var s = String(text || "");
    if (!q) { el.textContent = s; return; }
    var lower = s.toLowerCase(), needle = q.toLowerCase(), from = 0, idx;
    while ((idx = lower.indexOf(needle, from)) >= 0) {
      if (idx > from) { el.appendChild(document.createTextNode(s.slice(from, idx))); }
      var mk = document.createElement("mark");
      mk.textContent = s.slice(idx, idx + needle.length);
      el.appendChild(mk);
      from = idx + needle.length;
    }
    if (from < s.length) { el.appendChild(document.createTextNode(s.slice(from))); }
  }

  function rowEl(n, depth, forceOpen) {
    var row = document.createElement("div");
    row.className = "node" + (n.id === state.activeId ? " active" : "");
    row.setAttribute("data-id", n.id);
    row.setAttribute("data-type", n.type);
    // Here. draggable="true"：
    // The drag in the tree of the directory is self-fulfilled with a pointer event above; once the elements can be dragged, the browser drags to a few pixels.
    // Take the gesture. → Trigger original HTML5 Drag → I'll be right there. pointercancel Cut us off. pointermove，
    // It turns out...「I can't. + Ban cursor all the way.」。2026-09-21 The actual accident is the legacy of this line.
    row.style.paddingLeft = (8 + depth * 14) + "px";

    var tw = document.createElement("span");
    tw.className = "twisty";
    if (n.type === "folder") {
      tw.appendChild(iconSpan("chevron"));
      if (state.expanded[n.id] || forceOpen) { tw.classList.add("open"); }
      tw.onclick = function (e) {
        e.stopPropagation();
        state.expanded[n.id] = !state.expanded[n.id];
        persist(true);
        renderTree();
      };
    }
    row.appendChild(tw);

    row.appendChild(iconSpan(n.type));

    var lb = document.createElement("span");
    lb.className = "node-label";
    lb.title = n.name || "";
    highlightInto(lb, n.name, state.query.trim());
    row.appendChild(lb);

    if (n.type === "folder") {
      var cnt = document.createElement("span");
      cnt.className = "node-count";
      cnt.textContent = String(countNotes(n.id));
      row.appendChild(cnt);
    }

    row.onclick = function () { select(n.id); };
    row.ondblclick = function () { renameNode(n); };
    row.oncontextmenu = function (e) { e.preventDefault(); select(n.id); showCtxMenu(e.clientX, e.clientY, n); };

    // Pointer Drag (not dependent) HTML5 DnD API，In the sandbox./Plugin webview More reliable)
    row.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      // Expand Arrow/Do not start drag on the button, make sure that clicks expand, rename, etc. are interactive
      if (e.target && e.target.closest && (e.target.closest(".twisty") || e.target.closest("button"))) { return; }
      pdragBegin(e, n, row);
    });
    return row;
  }

  function clearDropMarks() {
    var els = document.querySelectorAll(".node.drop-target");
    for (var i = 0; i < els.length; i++) { els[i].classList.remove("drop-target"); }
  }

  function showDropMark(row) {
    clearDropMarks();
    row.classList.add("drop-target");
  }

  // ---------------- Pointer Drag (Replacement) HTML5 DnD，Avoid the sandbox. dragover Not effective/No placement cursor) ----------------

  function pdragBegin(e, n, row) {
    pdrag = { id: n.id, n: n, row: row, startX: e.clientX, startY: e.clientY, moved: false, ghost: null };
  }

  function makeGhost(n) {
    var g = document.createElement("div");
    g.className = "drag-ghost";
    g.textContent = (n.type === "folder" ? "[Folder] " : "[Note] ") + (n.name || "");
    document.body.appendChild(g);
    return g;
  }

  function elementToNode(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el.nodeType === 1) {
      if (el.classList && el.classList.contains("node")) { return el; }
      el = el.parentNode;
    }
    return null;
  }

  // Synchronising folder id=moving;notes id=(a) Be of the same rank (at the parent level);null=Root directories;undefined=Cancel/Self/Subfolders)
  function computeDropTarget(x, y, srcId) {
    var nodeEl = elementToNode(x, y);
    if (!nodeEl) {
      var tree = $("tree");
      var under = document.elementFromPoint(x, y);
      if (tree && under && tree.contains(under)) { return null; } // Tree Space = Root Directory
      return undefined; // Fall outside the plugin area and consider cancellation
    }
    var id = nodeEl.getAttribute("data-id");
    if (id === srcId) { return undefined; }
    var tn = byId(id);
    if (!tn) { return undefined; }
    if (tn.type === "folder" && isDescendant(id, srcId)) { return undefined; }
    if (tn.type === "folder") { return id; }
    return tn.parentId || null;
  }

  function updateDropTarget(x, y, srcId) {
    clearDropMarks();
    var nodeEl = elementToNode(x, y);
    if (!nodeEl) { return; }
    var id = nodeEl.getAttribute("data-id");
    if (id === srcId) { return; }
    var tn = byId(id);
    if (!tn) { return; }
    if (tn.type === "folder" && isDescendant(id, srcId)) { return; }
    nodeEl.classList.add("drop-target");
  }

  function pdragMove(e) {
    if (!pdrag) { return; }
    if (!pdrag.moved) {
      var dx = e.clientX - pdrag.startX, dy = e.clientY - pdrag.startY;
      if (dx * dx + dy * dy < 36) { return; } // threshold ~6px，Distinguishing Click and Drag
      pdrag.moved = true;
      document.body.classList.add("dragging-active");
      if (pdrag.row) { pdrag.row.classList.add("dragging"); }
      pdrag.ghost = makeGhost(pdrag.n);
    }
    if (pdrag.ghost) {
      pdrag.ghost.style.left = e.clientX + "px";
      pdrag.ghost.style.top = e.clientY + "px";
    }
    updateDropTarget(e.clientX, e.clientY, pdrag.id);
  }

  function pdragEnd(e) {
    if (!pdrag) { return; }
    var moved = pdrag.moved;
    var id = pdrag.id;
    if (pdrag.ghost && pdrag.ghost.parentNode) { pdrag.ghost.parentNode.removeChild(pdrag.ghost); }
    if (pdrag.row) { pdrag.row.classList.remove("dragging"); }
    clearDropMarks();
    document.body.classList.remove("dragging-active");
    pdrag = null;
    if (moved) {
      var dest = computeDropTarget(e.clientX, e.clientY, id);
      if (dest !== undefined) { doMove(id, dest); }
    }
  }

  // Global pointer listening (valid only during drag, otherwise direct) return，without prejudice to other interactions)
  document.addEventListener("pointermove", pdragMove);
  document.addEventListener("pointerup", pdragEnd);
  document.addEventListener("pointercancel", pdragEnd);

  // Bottom gate: Not allowed under any circumstances Original Fan. HTML5 Drag to take over the directory tree.
  // The original drag will start right away. pointercancel Cut the pointer drag and show the forbidden cursor - add this layer
  // It's to make...「We'll get it back later. draggable / or drag elements from elsewhere」It's not gonna kill the drag.
  document.addEventListener("dragstart", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("#tree")) { e.preventDefault(); }
  });

  function renderTree() {
    var tree = $("tree");
    tree.textContent = "";
    var q = state.query.trim().toLowerCase();

    var hit = {};
    if (q) {
      state.nodes.forEach(function (n) {
        if (n.type === "note") {
          if (String(n.name || "").toLowerCase().indexOf(q) >= 0 ||
            String(n.content || "").toLowerCase().indexOf(q) >= 0) { hit[n.id] = true; }
        } else if (String(n.name || "").toLowerCase().indexOf(q) >= 0) {
          hit[n.id] = true;
        }
      });
      // You'll have to show your father's life.
      Object.keys(hit).forEach(function (id) {
        var p = byId(id), guard = 0;
        if (p) { p = p.parentId ? byId(p.parentId) : null; }
        while (p && guard < 64) {
          if (p.type === "folder") { hit[p.id] = true; }
          p = p.parentId ? byId(p.parentId) : null;
          guard++;
        }
      });
    }

    function build(pid, depth) {
      var out = [];
      sortNodes(childrenOf(pid)).forEach(function (n) {
        if (q) {
          var selfHit = !!hit[n.id];
          var kids = build(n.id, depth + 1);
          if (!selfHit && kids.length === 0) { return; }
          out.push(rowEl(n, depth, true));
          kids.forEach(function (k) { out.push(k); });
        } else {
          out.push(rowEl(n, depth, false));
          if (n.type === "folder" && state.expanded[n.id]) {
            build(n.id, depth + 1).forEach(function (k) { out.push(k); });
          }
        }
      });
      return out;
    }

    var rows = build(null, 0);
    if (rows.length === 0) {
      var empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = q ? "No matching notes" : "No notes yet. Click “+ New note” to get started.";
      tree.appendChild(empty);
    } else {
      rows.forEach(function (r) { tree.appendChild(r); });
    }

    var sel = selectedNode();
    $("sel-actions").hidden = !sel;
  }

  // ---------------- Editor / Preview ----------------
  function renderEditor() {
    var n = activeNote();
    var panes = $("panes");
    var title = $("title");
    var editor = $("editor");
    if (!n) {
      panes.setAttribute("data-empty", "1");
      title.value = "";
      title.disabled = true;
      editor.value = "";
      editor.disabled = true;
      $("preview").textContent = "";
      updateCounter();
      return;
    }
    panes.setAttribute("data-empty", "0");
    title.disabled = false;
    editor.disabled = false;
    // The notes that are not read in the text: Freezing the editor. Such notes would never return the text to the disk. snapshot），
    // If the input is also allowed, the user knocks silently loses the content; freezes + It's about honesty.
    var frozen = !!state.contentMissing[n.id];
    editor.readOnly = frozen;
    editor.placeholder = frozen
      ? "This note's content file cannot be read (it may have been moved, renamed, or locked). Editing is disabled to prevent overwriting it. Check the notes storage directory."
      : "Write Markdown here… (headings, lists, code blocks, tables, bold text, and quotes; ```sql blocks are highlighted)";
    if (title.value !== n.name && document.activeElement !== title) { title.value = n.name; }
    if (frozen) { editor.value = ""; }
    else if (editor.value !== (n.content || "") && document.activeElement !== editor) { editor.value = n.content || ""; }
    renderPreview();
    updateCounter();
  }

  function renderPreview() {
    var n = activeNote();
    var pv = $("preview");
    if (!n) { pv.textContent = ""; return; }
    pv.innerHTML = window.MDNotes.renderMarkdown(n.content || "");
  }

  function updateCounter() {
    var n = activeNote();
    var el = $("counter");
    if (!n) { el.textContent = "0 characters"; $("note-meta").textContent = ""; return; }
    var txt = n.content || "";
    var lines = txt ? txt.split(/\r?\n/).length : 0;
    el.textContent = txt.length + " characters · " + lines + " lines";
    var meta = $("note-meta");
    if (n.updatedAt) {
      meta.textContent = "Updated " + fmtTime(n.updatedAt);
      meta.title = "Last updated: " + new Date(n.updatedAt).toLocaleString("en-US");
    } else {
      meta.textContent = "";
    }
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      function p2(x) { return (x < 10 ? "0" : "") + x; }
      if (sameDay) { return p2(d.getHours()) + ":" + p2(d.getMinutes()); }
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    } catch (e) { return ""; }
  }

  function setView(v) {
    state.view = v;
    $("panes").setAttribute("data-view", v);
    var btns = $("view-switch").querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute("data-view") === v) { btns[i].classList.add("on"); }
      else { btns[i].classList.remove("on"); }
    }
    persist(true);
  }

  // ---------------- Storage status ----------------
  var STATUS_TEXT = {
    host: "Saved to DBX plugin storage",
    folder: "Saved to a local folder",
    local: "Saved to browser storage",
    session: "Saved temporarily (lost when closed)",
    memory: "In memory only (not saved)",
    sidecar: "Saved to the storage directory"
  };
  function renderStatus(st) {
    st = S.status();   // Copies must be obtained:onStatus It's internal. status Object (no) .diag Waiting field)
    var pill = $("store-status");
    var dot = pill ? pill.querySelector(".store-dot") : null;
    var text = $("store-text");
    if (!dot || !text) { S.log("Render storage status", false, "Status elements missing (#store-status / #store-text)"); return; }

    var unconfigured = (st.backend === "sidecar" && st.dirConfigured === false);
    var bad = !st.ok || !st.persistent;
    var cls = st.ok ? (st.persistent ? "ok" : "warn") : "bad";
    if (unconfigured) { cls = "warn"; }
    dot.className = "store-dot " + cls;

    var label = STATUS_TEXT[st.backend] || ("Storage: " + st.backend);
    if (st.backend === "sidecar" && st.storageDir) { label += ": " + st.storageDir; }
    if (st.backend === "folder" && st.folderName) { label += ": " + st.folderName; }
    if (!st.ok && st.lastError) { label += " (write failed: " + st.lastError + ")"; }
    if (unconfigured) {
      var where = st.storageDir || st.storagePath || "the plugin's default directory";
      label = "Storage directory not configured: notes are temporarily stored in " + where;
    }
    text.textContent = label;
    // Only state bar colours for anomalies + title No more jamming banners.
    pill.title = unconfigured
      ? "Notes storage directory not configured: notes are currently saved in " + (st.storageDir || st.storagePath || "the plugin's default directory") +
        ". Set the notes storage directory in connection settings and reconnect to save them in your chosen folder."
      : (bad ? "Storage error: " + (st.lastError || "not persisted")
             : "Saved persistently" + (st.storageDir ? " (" + st.storageDir + ")" : ""));
  }

  /* ============ Page Top Diagnosis Bar (upline default close, code retention easy to disable) ============
   * 2026-09-21：Storage has stabilized and toplines (overlines too much space) are placed as required by the product.
   * When you need a barrier: SHOW_DIAG_BAR Replace with true + Cancel index.html The comment in the comments reads:
   * renderDiag() The call points are all kept and need not be changed elsewhere.
   */
  var SHOW_DIAG_BAR = false;
  var SHOW_DIAG_LOG_IN_MODAL = false;   // It's in the window.「Storage diagnostic log」Panel, Default Hide

  /* ============ Function Switch: Import .md（Out of line for now) ============
   * 2026-09-21：Import function is easily problematic and the entry is removed (toolbar button) / Right Key Menu / Hide file input I'm sorry.
   * The code and processing logic are preserved. To recover: replace the bottom with the following: true，And put index.html Lee. #btn-import-md with
   * #file-input Just cancel two notes - Pack the gate. Check「Switches and HTML It has to be consistent.」，Inconsistent direct refusal to pack.
   */
  var ENABLE_IMPORT = false;

  var diagOpen = true;
  var diagLastSev = null;

  function diagSeverity(st) {
    if (st.backend === "unknown") { return "warn"; }
    if (!st.hostAvailable) { return "bad"; }
    if (!st.ok || !st.persistent) { return "bad"; }
    if (st.backend === "sidecar" && st.dirConfigured === false) { return "warn"; }
    return "ok";
  }

  function verdictText(st) {
    if (!st.hostAvailable) {
      return "Notes will not be saved to disk: dbxPlugin bridge not found (you may be outside the DBX plugin workspace)";
    }
    if (st.backend === "unknown") {
      return "Storage initialization is still pending. Check the last log entry below to see where it stopped.";
    }
    if (st.backend === "sidecar") {
      var where = st.storageDir || st.storagePath || "the plugin's default directory";
      if (st.ok && st.persistent) {
        return st.dirConfigured === false
          ? "Notes are saved to disk, but no notes storage directory is configured. Actual location: " + where
          : "Notes are being saved to: " + where;
      }
      return "Notes will not be saved to disk: " + (st.lastError || "sidecar write error");
    }
    if (st.sidecarError) { return "Notes will not be saved to disk: " + st.sidecarError; }
    if (st.lastError) { return "Notes will not be saved to disk: " + st.lastError; }
    return "Notes are not being saved to disk (backend: " + st.backend + ")";
  }

  function renderDiag() {
    if (!SHOW_DIAG_BAR) { return; }   // The top diagnostic bar is offline.
    var bar = $("diag-bar");
    if (!bar) { return; }
    var st = S.status();   // Idem: Copies must be taken now, otherwise st.diag empty → Log area always shows"（I don't have a log yet."
    var sev = diagSeverity(st);
    bar.hidden = false;
    bar.setAttribute("data-sev", sev);

    var v = $("diag-verdict");
    if (v) { v.textContent = verdictText(st); }

    var parts = [
      "UI v" + (S.VERSION || "?"),
      "Backend " + st.backend,
      st.persistent ? "Persistent" : "Not persistent",
      "Bridge " + (st.hostAvailable ? "connected" : "missing"),
      "Sidecar " + (st.sidecarAvailable ? "connected" : "not connected"),
      "Directory " + (st.storageDir || "unavailable")
    ];
    if (st.connectionId) { parts.push("Connection " + st.connectionId); }
    if (st.payloadBytes) { parts.push("Last payload " + Math.round(st.payloadBytes / 1024) + " KB"); }
    if (st.lastSavedAt) { parts.push("Last write " + new Date(st.lastSavedAt).toLocaleTimeString("en-US")); }
    if (st.lastError) { parts.push("Error " + st.lastError); }
    var s = $("diag-summary");
    if (s) { s.textContent = parts.join(" · "); }

    var log = $("diag-log");
    if (log) {
      log.textContent = (st.diag && st.diag.length) ? st.diag.join("\n") : "(No logs yet)";
      log.scrollTop = log.scrollHeight;
    }
    // Default roll-out; in case of serious problems (bad）Make sure it doesn't fold up.
    if (sev === "bad" && diagLastSev !== "bad") { diagOpen = true; }
    diagLastSev = sev;
    if (log) { log.hidden = !diagOpen; }
    var btn = $("diag-toggle");
    if (btn) { btn.textContent = diagOpen ? "Hide logs" : "Show logs"; }
  }

  function openStoreModal() {
    var st = S.status();
    var lines = [
      "Backend: " + st.backend
        + (st.backend === "folder" && st.folderName ? " (" + st.folderName + ")" : ""),
      "Persistent: " + (st.persistent ? "Yes" : "No"),
      "Host bridge: " + (st.hostAvailable ? "Connected" : "Missing"),
      "Sidecar: " + (st.sidecarAvailable ? "Connected" : ("Unavailable — " + (st.sidecarError || "unknown reason"))),
      "Connection ID: " + (st.connectionId || "(Unavailable)"),
      "Storage directory: " + (st.storageDir || "(Unavailable)"),
      "Data file: " + (st.storagePath || "(Not written yet)"),
      "Directory configured: " + (st.dirConfigured ? "Yes" : "No (using the plugin's default directory)"),
      "Browser folder access: " + (st.fsSupported ? "Available" : "Unavailable (sandboxed; requires the sidecar)"),
      "Last write: " + (st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleString("en-US") : "None"),
      "Last payload: " + (st.payloadBytes ? Math.round(st.payloadBytes / 1024) + " KB" : "(None)"),
      "Error: " + (st.lastError || "None")
    ];
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = "Storage status"; card.appendChild(h);
      var p = document.createElement("pre");
      p.className = "m-pre";
      p.textContent = lines.join("\n");
      card.appendChild(p);

      // Diagnosis log panel: Upline default hidden (SHOW_DIAG_LOG_IN_MODAL=false），
      // Replace with true ; the log itself remains in S.status().diag / S.report() Lee.
      if (SHOW_DIAG_LOG_IN_MODAL) {
        var det = document.createElement("details");
        det.className = "m-diag";
        det.open = !st.persistent;   // Problem Default Expand
        var sum = document.createElement("summary");
        sum.textContent = "Storage diagnostic logs (" + ((st.diag && st.diag.length) || 0) + " entries)";
        det.appendChild(sum);
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = (st.diag && st.diag.length) ? st.diag.join("\n") : "(None)";
        det.appendChild(pre);
        card.appendChild(det);
      }

      var acts = [];
      if (st.fsSupported) {
        acts.push({ text: "Choose notes folder…", onClick: function () { closeModal(); chooseDirFlow(); } });
      }
      acts.push({ text: "Copy diagnostic report", onClick: function () { copyText(S.report(), "diagnostic report"); } });
      acts.push({ text: "Back up now", onClick: function () { closeModal(); backupAll(); } });
      acts.push({ text: "Restore from backup…", onClick: function () { closeModal(); restoreFlow(); } });
      acts.push({ text: "Close", primary: true, onClick: closeModal });
      modalButtons(card, acts);
    });
  }

  // ---------------- Bottom sidebar: Statistics ----------------
  // The storage position is no longer shown here: the storage-state window (point-state bar) is the only authoritative exit.
  // The same message shows that it only happens.「Two inconsistencies. Users don't know which letter.」。
  function renderSideFoot() {
    var foot = $("side-foot");
    if (!foot) { return; }
    var st = S.status();
    var totalNotes = 0, totalFolders = 0;
    state.nodes.forEach(function (n) {
      if (n.type === "note") { totalNotes++; } else { totalFolders++; }
    });
    foot.textContent = "";

    var stat = document.createElement("div");
    stat.className = "foot-stat";
    stat.innerHTML = '<span class="foot-num">' + totalNotes + '</span> notes · ' +
      '<span class="foot-num">' + totalFolders + '</span> folders';
    foot.appendChild(stat);

    // Not configured storage_dir : The notes are actually written into the plugin default directory, which the user does not see → It's not stored.
    // Here's what I'm saying.「Where to?」，Do not repeat the path (in the status window).
    if (st.backend === "sidecar" && st.dirConfigured === false) {
      var warn = document.createElement("div");
      warn.className = "foot-warn";
      warn.textContent = "Notes storage directory is not configured. Notes are temporarily stored in the plugin's default directory, not your chosen folder. "
        + "Set the directory in connection settings and reconnect (click the status bar for details).";
      foot.appendChild(warn);
    }
  }

  /** Authorize a local directory to actually drop the notes. */
  function chooseDirFlow() {
    S.pickDirectory().then(function (r) {
      if (!r.ok) {
        toast(r.error || "Could not choose a folder", "warn");
        return null;
      }
      return S.reload().then(function (data) {
        if (applyLoaded(data) && state.nodes.length) {
          render();
          persist(false);
          toast("Loaded notes from local folder: " + r.name);
        } else {
          persist(false);
          toast("Notes will be saved to local folder: " + r.name);
        }
        renderStatus();
      });
    });
  }

  // ---------------- Rendering entrance ----------------
  function render() {
    renderTree();
    renderEditor();
    renderStatus();
    renderSideFoot();
    renderDiag();
    renderAITarget();   // AI Show at the top of the column「Which one is currently being processed? / Select how many words」，Change your notes.
  }

  // ---------------- Node Operations ----------------
  function select(id) {
    state.activeId = id;
    var n = byId(id);
    if (n && n.type === "folder" && state.expanded[id] === undefined) { state.expanded[id] = true; }
    persist(true);
    render();
  }

  function createNote(name, parentId, content) {
    var n = {
      id: uid(), type: "note", name: uniqueName(parentId, name || "Untitled note"),
      parentId: parentId || null, content: content == null ? "" : content,
      createdAt: nowISO(), updatedAt: nowISO()
    };
    state.nodes.push(n);
    state.activeId = n.id;
    persist(false);
    render();
    $("editor").focus();
    return n;
  }

  function createFolder(name, parentId) {
    var f = {
      id: uid(), type: "folder", name: uniqueName(parentId, name || "New folder"),
      parentId: parentId || null, createdAt: nowISO(), updatedAt: nowISO()
    };
    state.nodes.push(f);
    state.expanded[f.id] = true;
    state.activeId = f.id;
    persist(false);
    render();
    return f;
  }

  function renameNode(n) {
    promptModal("Rename", n.type === "folder" ? "Folder name" : "Note title", n.name, "Save").then(function (v) {
      if (!v) { return; }
      var finalName = uniqueName(n.parentId, v, n.id);
      n.name = finalName;
      n.updatedAt = nowISO();
      persist(false);
      render();
      toast("Renamed");
    });
  }

  function removeNode(n) {
    var extra = n.type === "folder" ? (countNotes(n.id) + " notes") : "";
    confirmModal(
      "Delete " + (n.type === "folder" ? "folder" : "note"),
      "Delete “" + n.name + "”" + (extra ? " and its " + extra : "") + "? This cannot be undone.",
      "Delete", true
    ).then(function (ok) {
      if (!ok) { return; }
      var kill = {};
      kill[n.id] = true;
      if (n.type === "folder") {
        state.nodes.forEach(function (x) { if (isDescendant(x.id, n.id)) { kill[x.id] = true; } });
      }
      state.nodes = state.nodes.filter(function (x) { return !kill[x.id]; });
      Object.keys(kill).forEach(function (id) {
        if (state.deletedIds.indexOf(id) < 0) { state.deletedIds.push(id); }
      });
      if (kill[state.activeId]) { state.activeId = null; }
      persist(false);
      render();
      toast("Deleted");
    });
  }

  function doMove(id, destId) {
    var n = byId(id);
    if (!n) { return; }
    destId = destId || null;
    if ((n.parentId || null) === destId) { return; }
    if (n.type === "folder") {
      if (destId === n.id || isDescendant(destId, n.id)) {
        toast("A folder cannot be moved into itself or one of its subfolders", "warn");
        return;
      }
    }
    n.parentId = destId;
    n.name = uniqueName(destId, n.name, n.id);
    n.updatedAt = nowISO();
    if (destId) { state.expanded[destId] = true; }
    persist(false);
    render();
    toast("Moved to “" + (destId ? byId(destId).name : "Root") + "”");
  }

  // ---------------- Right Key Menu ----------------
  function closeCtxMenu() {
    var m = $("ctx-menu");
    m.hidden = true;
    m.textContent = "";
  }
  function showCtxMenu(x, y, n) {
    var m = $("ctx-menu");
    m.textContent = "";
    m.hidden = false;

    function item(text, fn, danger) {
      var b = document.createElement("button");
      b.className = "ctx-item" + (danger ? " danger" : "");
      b.textContent = text;
      b.onclick = function () { closeCtxMenu(); fn(); };
      m.appendChild(b);
    }

    if (!n) {
      item("New note", function () { createNote("Untitled note", null, ""); });
      item("New folder", function () { newFolderFlow(null); });
      if (ENABLE_IMPORT) { item("Import .md files", pickImportFiles); }
      item("Back up all notes as zip", backupAll);
      item("Restore from backup…", restoreFlow);
    } else if (n.type === "folder") {
      item("New note", function () { createNote("Untitled note", n.id, ""); });
      item("New subfolder", function () { newFolderFlow(n.id); });
      item("Rename", function () { renameNode(n); });
      item("Move to…", function () { moveNodeFlow(n); });
      item("Export folder as zip", function () { exportFolder(n); });
      item("Delete folder", function () { removeNode(n); }, true);
    } else {
      item("Rename", function () { renameNode(n); });
      item("Move to…", function () { moveNodeFlow(n); });
      item("AI analysis", function () { openAIPanel("analyze"); });
      item("AI polish", function () { openAIPanel("polish"); });
      item("AI continue", function () { openAIPanel("continue"); });
      item("Ask AI", function () { openAIPanel("ask"); });
      item("Export .md", function () { exportNote(n); });
      item("Copy content", function () { copyText(n.content || "", "note content"); });
      item("Delete note", function () { removeNode(n); }, true);
    }

    var w = m.offsetWidth || 168, h = m.offsetHeight || 180;
    var left = Math.min(x, window.innerWidth - w - 8);
    var top = Math.min(y, window.innerHeight - h - 8);
    m.style.left = Math.max(4, left) + "px";
    m.style.top = Math.max(4, top) + "px";
    setTimeout(function () {
      document.addEventListener("click", closeCtxMenu, { once: true });
    }, 0);
  }
  function moveNodeFlow(n) {
    moveModal(n).then(function (dest) {
      if (dest === null) { return; }
      doMove(n.id, dest);
    });
  }
  function newFolderFlow(parentId) {
    promptModal("New folder", "Folder name", "New folder", "Create").then(function (v) {
      if (v) { createFolder(v, parentId); }
    });
  }

  // ---------------- Import / Export / Backup / Restore ----------------
  //
  // There are two channels for landing, with priority levels ranging from high to low:
  //   1. Homeowner.「Save As」（dbxPlugin.saveFile）—— The dialogue box is saved by the host bomb system and the user selects its own directory and filename.
  //      Sandbox iframe There are no disk privileges.a.download / blob The navigation will be cancelled silently by the host, so it will only be possible to borrow the host's hand.
  //   2. The sidecar.「Note Storage Directory」（toDisk=true）—— No host. saveFile The bottom of the power, the path is shown to the user.
  //
  // Backup must contain configuration:mdnotes-backup.json（Version/Time/Original Storage Directory/Counted)+ .mdnotes/meta.json（Directory Tree Index)
  // + All Body .md。Backup is a collection of orphan files without a name and level, but not an index.

  function merge(o, extra) {
    var out = {}, k;
    for (k in (o || {})) { if (Object.prototype.hasOwnProperty.call(o, k)) { out[k] = o[k]; } }
    for (k in (extra || {})) { if (Object.prototype.hasOwnProperty.call(extra, k)) { out[k] = extra[k]; } }
    return out;
  }

  function mimeOf(name) {
    var s = String(name || "").toLowerCase();
    if (/\.zip$/.test(s)) { return "application/zip"; }
    if (/\.md$/.test(s)) { return "text/markdown"; }
    if (/\.txt$/.test(s)) { return "text/plain"; }
    return "application/octet-stream";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) { return n + " B"; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  /** Let the sidecar produce bytes and hand them over to the user: preferred host「Save As」（Custom directory), or return to storage directory */
  function saveViaSidecar(method, params, what, linesFn) {
    if (!S.hasHostSave()) {
      return S.invoke(method, merge(params, { toDisk: true })).then(function (d) {
        showPathModal(what + " saved to the notes storage directory", d.path);
      }).catch(function (e) {
        toast(what + " failed: " + (e && e.message ? e.message : e), "warn");
      });
    }
    return S.invoke(method, params).then(function (r) {
      var name = r.fileName || ("md-notes" + (method.indexOf("backup") >= 0 ? ".zip" : ".md"));
      return S.saveFile(name, mimeOf(name), r.dataBase64).then(function (res) {
        if (res.canceled) { toast(what + " canceled"); return; }
        if (res.ok) { showSavedModal(what + " saved", res.path || name, linesFn ? linesFn(r) : null); return; }
        toast("Save As unavailable (" + res.error + "); saving to the notes storage directory instead", "warn");
        return S.invoke(method, merge(params, { toDisk: true })).then(function (d) {
          showPathModal(what + " saved to the notes storage directory", d.path);
        });
      });
    }).catch(function (e) {
      toast(what + " failed: " + (e && e.message ? e.message : e), "warn");
    });
  }

  function exportNote(n) {
    if (!n) { toast("Select a note first", "warn"); return; }
    return saveViaSidecar("notes/exportNote", { id: n.id }, "Note export");
  }
  function exportFolder(folder) {
    if (!folder) { toast("Select a folder first", "warn"); return; }
    return saveViaSidecar("notes/backup", { scope: folder.id }, "Folder backup", backupLines);
  }
  function backupAll() {
    return saveViaSidecar("notes/backup", {}, "Full notes backup", backupLines);
  }

  /** After the backup is completed「What's in the bag?」Let's go. 「configuration」It must be visible, or no one knows it can be restored. */
  function backupLines(r) {
    var lines = [
      "Contents: " + (r.count || 0) + " notes · " + (r.folders || 0) + " folders",
      "Includes configuration: mdnotes-backup.json (version / export time / original storage directory)",
      "                        .mdnotes/meta.json (folder tree, hierarchy, and titles)",
      "Backup size: " + fmtBytes(r.bytes)
    ];
    if (r.storageDir) { lines.push("Original storage directory: " + r.storageDir); }
    lines.push("");
    lines.push("To restore, select this zip with “Restore backup…” in the toolbar.");
    return lines;
  }

  /** Dialog saved to user selected directory */
  function showSavedModal(title, path, extraLines, actions) {
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
      var p = document.createElement("p");
      p.className = "m-msg";
      p.textContent = "Saved to your chosen folder:";
      card.appendChild(p);
      var ta = document.createElement("textarea");
      ta.className = "m-text";
      ta.value = path || "";
      ta.readOnly = true;
      card.appendChild(ta);
      if (extraLines && extraLines.length) {
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = extraLines.join("\n");
        card.appendChild(pre);
      }
      var acts = [];
      if (path) { acts.push({ text: "Copy path", onClick: function () { copyText(path, "file path"); } }); }
      (actions || []).forEach(function (a) { acts.push(a); });
      acts.push({ text: "Close", primary: !actions || !actions.length, onClick: closeModal });
      modalButtons(card, acts);
    });
  }

  function showPathModal(title, path) {
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
      var p = document.createElement("p");
      p.className = "m-msg";
      p.textContent = "File created in your notes storage directory:";
      card.appendChild(p);
      var ta = document.createElement("textarea");
      ta.className = "m-text";
      ta.value = path || "";
      ta.readOnly = true;
      card.appendChild(ta);
      modalButtons(card, [
        { text: "Close", onClick: closeModal },
        { text: "Copy path", primary: true, onClick: function () { copyText(path, "export path"); } }
      ]);
    });
  }

  /**
   * Multi-line content confirmation box (renewal of this destructive operation should be clear by article).
   *
   * Attention: Here.**I can't.**Yeah. confirmModal —— The same name statement will be overridden by the later declaration.
   * And the one up there. confirmModal(title, message, ...) Collects a string.
   * Once it's renamed, the first one to be declared is replaced.removeNode If you send a string in, you will.
   * `lines.join is not a function` Wrong. → 「Delete」The button did not react.
   */
  function confirmListModal(title, lines, okText) {
    return new Promise(function (resolve) {
      var done = function (v) { closeModal(); resolve(v); };
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = (lines || []).join("\n");
        card.appendChild(pre);
        modalButtons(card, [
          { text: "Cancel", onClick: function () { done(false); } },
          { text: okText || "OK", primary: true, onClick: function () { done(true); } }
        ]);
      });
    });
  }

  // ---------------- Restore from Backup ----------------

  function restoreFlow() {
    var inp = $("backup-input");
    if (!inp) { toast("Restore option unavailable", "warn"); return; }
    inp.value = "";
    inp.click();
  }

  function handleRestoreFile(files) {
    var f = files && files[0];
    if (!f) { return; }
    // The host. request Parameters have 2 MiB ceiling,base64 I'll take care of it later. zip About 1.5 MB。
    // More than explicitly rejecting and giving alternative solutions, rather than letting them fail on an incomprehensible blunder.
    if (f.size > S.MAX_UPSTREAM_BYTES) {
      toast("Backup is too large (" + fmtBytes(f.size) + " > limit " + fmtBytes(S.MAX_UPSTREAM_BYTES)
        + "). Extract it manually and place the .md files in the storage directory.", "warn");
      return;
    }
    var b64 = "";
    S.readFileAsBase64(f).then(function (v) {
      b64 = v;
      return S.invoke("notes/restore", { dataBase64: b64, dryRun: true });
    }).then(function (r) {
      var bi = r.backup || {};
      var lines = [
        "Backup file: " + f.name + " (" + fmtBytes(f.size) + ")",
        "Backup date: " + (bi.exportedAt || "(Not recorded)"),
        "Plugin version: " + (bi.version || "(Not recorded)"),
        "Storage directory at backup time: " + (bi.storageDir || "(Not recorded)"),
        "Contents: " + r.notes + " notes · " + r.folders + " folders",
        "",
        "Restore into current storage directory: " + r.storageDir,
        "Notes with matching names will be overwritten, and the folder tree will revert to its backed-up state.",
        "A pre-restore-*.zip safety backup will be created automatically."
      ];
      return confirmListModal("Restore this backup?", lines, "Restore now");
    }).then(function (ok) {
      if (!ok) { toast("Restore canceled"); return null; }
      // Put the hang-up-proof writing down before it recovers.「Restore complete」It was then covered by that old photo.
      return S.flush().then(function () {
        return S.invoke("notes/restore", { dataBase64: b64 });
      }).then(function (r) {
        return S.reload().then(function (data) {
          applyLoaded(data);
          render();
          persist(false);
          var lines = [
            "Restored " + r.notes + " notes · " + r.folders + " folders",
            "Storage directory: " + r.storageDir
          ];
          lines.push(r.safetyPath
            ? ("Pre-restore safety backup: " + r.safetyPath)
            : "(There were no notes to back up before restoration)");
          showSavedModal("Restore complete", r.storageDir, lines);
        });
      });
    }).catch(function (e) {
      toast("Restore failed: " + (e && e.message ? e.message : e), "warn");
    });
  }
  /** Open「Import .md」. The file selection box. This is not the way to import downlines;
   *  Takes the element in a secure writing (prior value and emptiness) to avoid the error of the caller when the element is missing. */
  function pickImportFiles() {
    var fi = $("file-input");
    if (fi) { fi.click(); } else { toast("Import is disabled", "warn"); }
  }

  function handleImport(files) {
    if (!files || !files.length) { return; }
    var parentId = targetFolderId();
    var list = Array.prototype.slice.call(files);
    Promise.all(list.map(function (f) {
      return S.readFileAsText(f).then(function (txt) { return { name: stripExt(f.name), text: txt }; })
        .catch(function () { return null; });
    })).then(function (items) {
      var n = 0;
      items.forEach(function (it) {
        if (!it) { return; }
        createNote(it.name, parentId, it.text);
        n++;
      });
      toast(n ? ("Imported " + n + " notes") : "No importable .md files found", n ? "" : "warn");
    });
  }
  function copyText(text, what) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    var done = function (ok) { toast(ok ? ("Copied" + (what ? " (" + what + ")" : "")) : "Copy failed. Select and copy manually.", ok ? "" : "warn"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(fallback()); });
    } else {
      done(fallback());
    }
  }

  // ---------------- Connect to database table ----------------
  function parseFields(text) {
    return String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean).map(function (l) {
        var parts = l.split(/\s+/);
        return { name: parts[0], type: parts.slice(1).join(" ") };
      });
  }
  function tableMarkdown(table, fields) {
    var L = [];
    L.push("# Table design notes: " + table);
    L.push("");
    L.push("> Created on " + new Date().toLocaleString("en-US"));
    L.push("");
    L.push("## Columns");
    L.push("");
    if (fields.length) {
      L.push("| Column | Type | Description |");
      L.push("| --- | --- | --- |");
      fields.forEach(function (f) { L.push("| " + f.name + " | " + (f.type || "") + " |  |"); });
    } else {
      L.push("(No columns provided)");
    }
    L.push("");
    L.push("## Design notes");
    L.push("");
    L.push("- Primary / unique keys:");
    L.push("- Index design:");
    L.push("- Data volume and growth:");
    L.push("");
    L.push("## Lessons learned");
    L.push("");
    L.push("- ");
    L.push("");
    L.push("## SQL tips");
    L.push("");
    L.push("```sql");
    var cols = fields.length ? fields.slice(0, 6).map(function (f) { return f.name; }).join(", ") : "*";
    L.push("SELECT " + cols);
    L.push("FROM " + table);
    L.push("LIMIT 100;");
    L.push("```");
    return L.join("\n");
  }

  function openTableModal(prefill) {
    var tm = $("table-modal");
    var folderSel = $("tn-folder");
    folderSel.textContent = "";
    folderOptions(null).forEach(function (o) {
      var op = document.createElement("option");
      op.value = o.id; op.textContent = o.label;
      folderSel.appendChild(op);
    });
    var def = targetFolderId();
    if (def) { folderSel.value = def; }
    $("tn-table").value = (prefill && prefill.table) || "";
    $("tn-fields").value = (prefill && prefill.fields) || "";
    tm.hidden = false;
    setTimeout(function () { $("tn-table").focus(); }, 0);
  }
  function closeTableModal() { $("table-modal").hidden = true; }
  function submitTableModal() {
    var table = String($("tn-table").value || "").trim();
    if (!table) { toast("Enter a table name", "warn"); return; }
    var fields = parseFields($("tn-fields").value);
    var parent = $("tn-folder").value || null;
    closeTableModal();
    createNote("Table design: " + table, parent, tableMarkdown(table, fields));
    toast("Created note for “" + table + "”");
  }

  /** Automatically build notes from host context (right key)「New Notes for this Table」） */
  /**
   * Process「New Notes for this Table」Context.
   * The context has two sources:
   *  1) The host will take it directly. context Hang on to bridge object (dbxPlugin.context）
   *  2) Right-click menu recorded from sidecar pending，Frontend notes/load Recovery (name of open method not dependent on host)
   */
  function handleHostContext(pending) {
    var ctx = pending || null;
    if (!ctx) {
      try { ctx = window.dbxPlugin && window.dbxPlugin.context; } catch (e) { ctx = null; }
    }
    if (!ctx) { return; }
    var table = ctx.tableName || ctx.table || ctx.name || ctx.objectName || "";
    if (!table) { return; }
    var cols = ctx.columns || ctx.fields || [];
    var fieldsText = cols.map(function (c) {
      if (typeof c === "string") { return c; }
      return (c.name || c.column || "") + (c.type ? " " + c.type : "");
    }).filter(Boolean).join("\n");

    var title = "Table design: " + table;
    var exist = state.nodes.filter(function (n) { return n.type === "note" && (n.name === title || n.name === ("Table design:" + table)); })[0];
    if (exist) {
      state.activeId = exist.id;
      persist(false);
      render();
      toast("Opened existing note: " + (exist.name || title));
      return;
    }
    createNote(title, null, tableMarkdown(table, parseFields(fieldsText)));
    toast("Created note for “" + table + "”");
  }

  function insertSqlBlock() {
    var n = activeNote();
    if (!n) { toast("Select a note first", "warn"); return; }
    var ta = $("editor");
    var table = "";
    var m = String(n.name || "").match(/(?:Table design|Table design)[：:]\s*(.+)$/i);
    if (m) { table = m[1].trim(); }
    var block = "\n```sql\nSELECT *\nFROM " + (table || "your_table") + "\nLIMIT 100;\n```\n";
    var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    var v = ta.value;
    ta.value = v.slice(0, start) + block + v.slice(end);
    var pos = start + block.length;
    ta.selectionStart = ta.selectionEnd = pos;
    n.content = ta.value;
    n.updatedAt = nowISO();
    ta.focus();
    persist(false);
    renderPreview();
    updateCounter();
  }

  function firstSqlBlock(text) {
    var re = /```[ \t]*sql[ \t]*\r?\n([\s\S]*?)```/gi;
    var m = re.exec(String(text || ""));
    return m ? m[1] : "";
  }
  function copySqlToDbx() {
    var ta = $("editor");
    var sel = ta.value.slice(ta.selectionStart || 0, ta.selectionEnd || 0);
    var sql = sel.trim() ? sel.trim() : firstSqlBlock(ta.value);
    if (!sql) { sql = ta.value; }
    if (!String(sql).trim()) { toast("No SQL to copy", "warn"); return; }
    copyText(sql, "SQL (ready to paste into DBX SQL editor)");
  }

  // ---------------- Example of initialization (only when data are completely unavailable) ----------------
  function seed() {
    var welcome =
      "# Welcome to AI.MD Notes\n\n" +
      "This is your first note. The folder tree is on the left; the editor and live preview are on the right.\n\n" +
      "## Supported syntax\n\n" +
      "- Headings, lists, **bold**, *italic*, `inline code`\n" +
      "- > Blockquotes\n\n" +
      "| Column | Type | Description |\n" +
      "| --- | --- | --- |\n" +
      "| id | bigint | Primary key |\n\n" +
      "## SQL code blocks (highlighted automatically)\n\n" +
      "```sql\nSELECT id, name\nFROM users\nWHERE created_at >= '2026-01-01'\nORDER BY id DESC\nLIMIT 100;\n```\n\n" +
      "> Tip: “Copy SQL to DBX” in the top right extracts the first ```sql block so you can paste and run it in the native SQL editor.\n";

    var tips =
      "# DBX tips\n\n" +
      "## Troubleshooting slow queries\n\n" +
      "1. Check the execution plan first\n" +
      "2. Verify whether indexes are hit\n\n" +
      "```sql\nEXPLAIN SELECT * FROM orders WHERE user_id = 42;\n```\n\n" +
      "## Lessons learned\n\n" +
      "- `COUNT(*)` on large tables is slow; use approximations or caching instead.\n";

    var f = { id: uid(), type: "folder", name: "Examples", parentId: null, createdAt: nowISO(), updatedAt: nowISO() };
    var n1 = { id: uid(), type: "note", name: "Welcome to AI.MD Notes", parentId: null, content: welcome, createdAt: nowISO(), updatedAt: nowISO() };
    var n2 = { id: uid(), type: "note", name: "DBX tips", parentId: f.id, content: tips, createdAt: nowISO(), updatedAt: nowISO() };
    state.nodes = [f, n1, n2];
    state.expanded[f.id] = true;
    state.activeId = n1.id;
  }

  // ---------------- AI Assistant (right-hand resident) ----------------
  //
  // The model is all used in the sidecar (with neither a network nor a key in the sandbox at the frontend).
  // It's only for: get the target text. → Presentation of results (with session records)→ Let Users**Visible**Selection
  // 「Insert at cursor / Replace selection / Append to end / Copy」。
  // Any operation that will overwrite an existing body (replacement selection, insert when there is a constituency) must go past the confirmation box -
  // With Full Plugin「Unquietly Overwrite」The principle is consistent.
  //
  // Why don't you make a dialog: the dialog covers the notes, closes them and loses history. AI The result is often seen to change.
  //
  // noContext = When there are no notes,**Still available**：
  //   「Ask」It's a simple conversation.「Continue writing」It's degenerated to be created as you want./Requests);
  //   「Analyze」「Polish」The semantic is to process an off-the-shelf text without text -- so they don't have this tag.
  var AI_TASKS = [
    { id: "analyze", label: "Analyze", hint: "Summarize key points, to-dos, and inconsistencies", needsInput: false, go: "Start analysis", noContext: false },
    { id: "polish", label: "Polish", hint: "Improve clarity while preserving meaning and Markdown structure", needsInput: true, go: "Start polish", noContext: false },
    { id: "continue", label: "Continue", hint: "Continue writing at the end; or generate from your prompt if empty", needsInput: true, go: "Start writing", noContext: true },
    { id: "ask", label: "Ask", hint: "Ask questions about the note; pure chat when no note content", needsInput: true, go: "Ask", noContext: true }
  ];

  // Two modes (default chat):
  //   Chat - pure conversation: send only what you write, without any notes; does not involve"Analysis target"，There is no return operation.
  //   Create - Process Notes: Present「Analysis target」with the task label, the result is four write back operations.
  var AI_VIEWS = [
    { id: "chat", label: "Chat", hint: "Conversation only: sends your message without note content" },
    { id: "create", label: "Compose", hint: "Work with notes: analyze content and write results back to notes" }
  ];

  // The user knows which one to fill when the configuration is missing.
  var AI_MISSING_LABEL = {
    enabled: "Enable AI features",
    baseUrl: "API URL",
    model: "Model name",
    apiKey: "API key"
  };

  var AI_MAX_ENTRIES = 20;   // Only the most recent ones are left to avoid unlimited growth of memory after long use

  var aiState = {
    open: false,
    view: "chat",        // chat（Default, pure conversation)| create（Create: with analyzers and write back)
    task: "analyze",     // Use only creative mode
    cfg: null,
    busy: false,
    entries: [],
    cfgPristine: true,   // The configuration frame has not been modified by the user (the service end is allowed to overwrite the form without changing it)
    targetMode: "auto",  // Sources of analysis:auto | selection | note | none
    layoutReady: false
  };

  function aiIsChat() { return (aiState.view || "chat") === "chat"; }
  function aiViewDef(id) {
    for (var i = 0; i < AI_VIEWS.length; i++) { if (AI_VIEWS[i].id === id) { return AI_VIEWS[i]; } }
    return AI_VIEWS[0];
  }

  function aiTaskDef(id) {
    for (var i = 0; i < AI_TASKS.length; i++) {
      if (AI_TASKS[i].id === id) { return AI_TASKS[i]; }
    }
    return AI_TASKS[0];
  }

  function aiErrText(e) {
    return (e && e.message) ? e.message : String(e || "Unknown error");
  }

  /* ---------------- Analytic Object (Fartable Controllable) + Update in Real Time) ----------------
   *
   * That was the way it was."Calculate range once you open the panel"，Two questions:
   *   1) As soon as the panel was opened, the range was pinned -- and then the selection, the content in the editor, the column was still old.
   *      Looks like it."We can't change the subject."；
   *   2) There is no way to clearly specify or clear objects.
   * The object is now made visible and updated in real time with the editor:
   *   auto      —— Following editor: selected, otherwise whole (default)
   *   selection —— Fixed Selection (requires that the current selection is genuine)
   *   note      —— Fixed whole note
   *   none      —— Cleared: No text sent, generation button disabled
   */
  var AI_TARGET_MODES = [
    { id: "auto", label: "Auto", hint: "Use selection if present; otherwise use the entire note" },
    { id: "selection", label: "Selection", hint: "Only use the text currently selected in the editor" },
    { id: "note", label: "Full note", hint: "Use the entire content of the current note" },
    { id: "none", label: "Clear", hint: "Clear target (do not send any note content)" }
  ];

  function aiTargetModeDef(id) {
    for (var i = 0; i < AI_TARGET_MODES.length; i++) {
      if (AI_TARGET_MODES[i].id === id) { return AI_TARGET_MODES[i]; }
    }
    return AI_TARGET_MODES[0];
  }

  /** Selection in the current editor (return empty string if not selected) */
  function aiSelection(ed) {
    if (!ed || ed.selectionStart == null || ed.selectionEnd == null) { return { text: "", start: 0, end: 0 }; }
    if (ed.selectionEnd <= ed.selectionStart) { return { text: "", start: ed.selectionStart || 0, end: ed.selectionEnd || 0 }; }
    return {
      text: String(ed.value || "").slice(ed.selectionStart, ed.selectionEnd),
      start: ed.selectionStart,
      end: ed.selectionEnd
    };
  }

  /**
   * Currently you want to give it to the object of the model.
   * - `empty:true` configuration"No body to send"（Cleared / Not Selected / Notes are empty. / None of the notes:
   *   The caller gives it on this basis**Different.**Not all the tips and follow-up."Nothing."。
   * - `noNote:true` It means he didn't even pick his notes.「Ask」「Continue writing」It's still available.
   */
  function aiTarget() {
    var n = activeNote();
    var mode = aiState.targetMode || "auto";
    var ed = $("editor");
    var sel = aiSelection(ed);
    if (!n) {
      return { note: null, mode: mode, label: "No note content", text: "", hasSelection: false,
        start: sel.start, end: sel.end, empty: true, noNote: true };
    }

    if (mode === "none") {
      return { note: n, mode: mode, label: "No note content", text: "", hasSelection: false,
        start: sel.start, end: sel.end, empty: true };
    }
    if (mode === "selection" && !sel.text) {
      return { note: n, mode: mode, label: "Selection (nothing currently selected)", text: "", hasSelection: false,
        start: sel.start, end: sel.end, empty: true };
    }
    var useSel = (mode === "selection" || mode === "auto") && !!sel.text;
    var text = useSel ? sel.text : String(n.content || "");
    return {
      note: n,
      mode: mode,
      label: useSel ? "Selection" : "Full note",
      text: text,
      hasSelection: useSel,
      start: sel.start,
      end: sel.end,
      empty: aiCharCount(text) === 0
    };
  }

  /** Text to send (generated buttons to release) */
  function aiTargetUsable() {
    var tgt = aiTarget();
    return !!(tgt && !tgt.empty && String(tgt.text).trim());
  }

  function aiCharCount(s) { return String(s == null ? "" : s).length; }

  function aiInputText() {
    var el = $("aip-input");
    return el ? String(el.value || "").trim() : "";
  }

  /**
   * The state can't be sent out.
   * Chat mode: Write your content and send it (pure conversation, no object).
   * Creative mode: text is available; text is available only when there is no text noContext Tasks (questions) / I can run and write my own requests.
   */
  function aiCanRun(cfg) {
    if (aiState.busy || !(cfg && cfg.ready)) { return false; }
    if (aiIsChat()) { return !!aiInputText(); }
    if (aiTargetUsable()) { return true; }
    if (!aiTaskDef(aiState.task).noContext) { return false; }
    return !!aiInputText();
  }

  /* ---------------- Mode: Chat / Create ---------------- */

  /**
   * Switch mode. Chat Mode「Analysis target + Tasks」Put the whole piece away...
   * That's what it takes to create."You have to choose someone to speak."。
   */
  function setAIMode(id) {
    var def = aiViewDef(id);
    aiState.view = def.id;
    renderAIMode();
    aiState.cfgPristine = true;
    syncAIConfigForm(aiState.cfg);
    renderAITabs();         // Task labels are rendered only in creative mode; cut back must be supplemented once
    renderAILog();          // It's the same as the pattern.
    refreshAITargetUI();
  }

  function renderAIMode() {
    AI_VIEWS.forEach(function (def) {
      var b = $("aip-view-" + def.id);
      if (!b) { return; }
      if ((aiState.view || "chat") === def.id) { b.classList.add("active"); } else { b.classList.remove("active"); }
    });
    var createOnly = $("aip-create-only");
    if (createOnly) { createOnly.hidden = aiIsChat(); }
    var input = $("aip-input");
    if (input) {
      input.placeholder = aiIsChat()
        ? "Say something to AI…"
        : "(Optional) Additional instructions / questions";
    }
  }

  /**
   * Paint「Analysis target」Area: Mode button highlight + Object Summary + Text preview.
   * The preview is the focus -- the user must be able to see it."What are you sending out?"，Otherwise, we have to guess.
   */
  function renderAITarget() {
    if (!aiState.open || aiIsChat()) { return; }   // Chat mode does not analyse objects
    AI_TARGET_MODES.forEach(function (def) {
      var b = $("aip-mode-" + def.id);
      if (!b) { return; }
      var on = (aiState.targetMode || "auto") === def.id;
      if (on) { b.classList.add("active"); } else { b.classList.remove("active"); }
    });

    var box = $("aip-target");
    if (!box) { return; }
    while (box.firstChild) { box.removeChild(box.firstChild); }

    var tgt = aiTarget();
    var cap = (aiState.cfg && aiState.cfg.maxChars) ? aiState.cfg.maxChars : 12000;

    function line(cls, text) {
      var d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      box.appendChild(d);
      return d;
    }

    if (!tgt) {
      line("aip-target-main", "Target: No note selected.");
      return;
    }
    var chars = aiCharCount(tgt.text);
    var name = String(tgt.note ? (tgt.note.name || "") : "");
    if (tgt.empty) {
      var why, tip;
      if (tgt.noNote) {
        why = "No note selected";
        tip = "Click a note on the left to analyze its content; you can still use “Ask” or “Continue” without a note.";
      } else if (tgt.mode === "none") {
        why = "Cleared (no note content will be sent)";
        tip = "Click “Ask” for chat, or “Continue” to generate from your prompt; click “Full note” to include the note.";
      } else if (tgt.mode === "selection") {
        why = "No text selected";
        tip = "Select text in the editor, click “Full note”, or use “Ask” without a note.";
      } else {
        why = "This note has no content yet";
        tip = "Write something first, or click “Clear” and chat using “Ask”.";
      }
      line("aip-target-main warn", "Target: " + why + (name ? " · “" + name + "”" : ""));
      line("aip-target-tip", tip);
      return;
    }
    var main = "Target: " + tgt.label + (name ? " · “" + name + "”" : "") + " · " + chars + " chars";
    if (tgt.mode === "auto") { main += " (auto-following editor)"; }
    if (chars > cap) { main += " · exceeds limit of " + cap + ", will be truncated when sent"; }
    line("aip-target-main", main);

    var preview = document.createElement("div");
    preview.className = "aip-target-preview";
    var head = String(tgt.text).slice(0, 160).replace(/\s+/g, " ");
    preview.textContent = head + (chars > 160 ? " …" : "");
    preview.title = "Preview of content to be sent (first 160 chars)";
    box.appendChild(preview);
  }

  function setAITargetMode(id) {
    var def = aiTargetModeDef(id);
    aiState.targetMode = def.id;
    refreshAITargetUI();
    if (def.id === "selection" && !aiSelection($("editor")).text) {
      toast("No text selected: select a section in the editor", "warn");
    }
  }

  /**
   * Refresh「Analysis target」All relevant UI：Object Area + Status Line + Generates a button.
   * Three places must be refreshed together -- only the object area will appear.「The object writes the selection, the status line, the whole note.」This paradox.
   * （e2e They don't know which one.
   */
  function refreshAITargetUI() {
    renderAITarget();
    var st = $("aip-status");
    if (st) { st.textContent = aiReadyText(aiState.cfg); }
    setAIReady(aiState.cfg);
  }

  // Selection in Editor/I want it all.「Analysis target」It changes in real time -- otherwise it becomes..."Old crucified value."。
  // Use addEventListener Not on("editor", ...)：The editor has already hung up by attribute. oninput/onblur，
  // The attribute will topple it.
  var aiTargetTimer = null;
  function refreshAITargetSoon() {
    if (!aiState.open || aiTargetTimer) { return; }
    aiTargetTimer = setTimeout(function () {
      aiTargetTimer = null;
      try { refreshAITargetUI(); } catch (e) { /* Pure display. Failure does not affect the main process. */ }
    }, 60);
  }

  function bindAITargetWatch() {
    var ed = $("editor");
    if (!ed || !ed.addEventListener) {
      S.log("Bind editor events (AI target tracking)", false, "Editor element missing or unavailable");
      return;
    }
    ["select", "keyup", "mouseup", "focus", "input", "click"].forEach(function (ev) {
      ed.addEventListener(ev, refreshAITargetSoon);
    });
  }

  function renderAITabs() {
    var go = $("aip-go");
    if (aiIsChat()) {
      // Chat mode: One sentence, the button is called「Send」
      if (go) { go.textContent = "Send"; }
      return;
    }
    var box = $("aip-tabs");
    if (!box) { return; }
    while (box.firstChild) { box.removeChild(box.firstChild); }
    AI_TASKS.forEach(function (def) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "aip-tab" + (aiState.task === def.id ? " active" : "");
      b.textContent = def.label;
      b.title = def.hint;
      b.setAttribute("data-task", def.id);
      b.onclick = function () { setAITask(def.id); };
      box.appendChild(b);
    });
    if (go) { go.textContent = aiTaskDef(aiState.task).go; }
    var input = $("aip-input");
    if (input) {
      input.placeholder = (aiState.task === "ask")
        ? "Enter your question (required)"
        : "(Optional) Additional instructions, e.g. more concise / keep technical terms";
    }
  }

  function setAITask(id) {
    aiState.task = aiTaskDef(id).id;
    renderAITabs();
    renderAITarget();
  }

  function renderAIModel() {
    var el = $("aip-model");
    if (!el) { return; }
    var c = aiState.cfg;
    if (!c) { el.textContent = "Loading configuration…"; return; }
    if (!c.ready) {
      el.textContent = "Not configured";
      return;
    }
    el.textContent = (c.provider || "") + " · " + (c.model || "");
    el.title = el.textContent + (c.hasKey ? "\nKey source: " + (c.keyFrom === "local" ? "Local panel" : "Connection settings") : "\nNo key (local model)");
  }

  function aiConfigMsg(text, kind) {
    var el = $("aic-msg");
    if (!el) { return; }
    el.textContent = text || "";
    if (kind) { el.setAttribute("data-kind", kind); } else { el.removeAttribute("data-kind"); }
  }

  /** Fill in the dialog form for the service-end configuration (only if the user has not changed the form to avoid flushing the input) */
  function syncAIConfigForm(cfg) {
    if (!cfg || !aiState.cfgPristine) { return; }
    var set = function (id, v) { var e = $(id); if (e) { e.value = v; } };
    var chk = function (id, v) { var e = $(id); if (e) { e.checked = !!v; } };
    chk("aic-enabled", cfg.enabled);
    set("aic-provider", cfg.provider || "openai");
    set("aic-baseurl", cfg.baseUrl || "");
    set("aic-modelinput", cfg.model || "");
    set("aic-sysprompt", cfg.systemPrompt || "");
    set("aic-timeout", cfg.timeoutSecs || 60);
    set("aic-maxchars", cfg.maxChars || 12000);
    chk("aic-remember", cfg.rememberKey);
    set("aic-key", "");   // The key never returns. It's always empty. = No change)
  }

  /** Availability of sending buttons = Configure Ready +（Chat: wrote about / (b) Creation: the object or the mission may not be object-free and the requirement is written) */
  function setAIReady(cfg) {
    var go = $("aip-go");
    if (!go) { return; }
    go.disabled = !aiCanRun(cfg);
  }

  function aiReadyText(cfg) {
    if (!cfg) { return "Failed to read AI configuration (sidecar not responding)"; }
    if (!cfg.ready) {
      var miss = (cfg.missing || []).map(function (k) { return AI_MISSING_LABEL[k] || k; });
      return "Missing: " + miss.join(", ") + " — click ⚙ in the top right to configure";
    }
    // Chat mode: Send only your words without any notes
    if (aiIsChat()) {
      var msg = aiInputText();
      return msg ? ("Ready · sending message (" + aiCharCount(msg) + " chars, without note content)")
                 : "Chat mode · enter a message to send (without note content)";
    }
    var def = aiTaskDef(aiState.task);
    var tgt = aiTarget();
    if (tgt && !tgt.empty && String(tgt.text).trim()) {
      var n = aiCharCount(tgt.text);
      var cap = cfg.maxChars || 12000;
      return "Ready · will send " + tgt.label + " (" + n + " chars)" + (n > cap ? ", will be truncated to " + cap : "");
    }
    // No text: Only「Ask」「Continue writing」I can go on, and I have to write the questions myself./Request
    if (!def.noContext) {
      var why = "No text content available to send";
      if (tgt && tgt.noNote) { why = "No note selected"; }
      else if (tgt && tgt.mode === "none") { why = "Target cleared"; }
      else if (tgt && tgt.mode === "selection") { why = "No text selected"; }
      else { why = "This note has no content yet"; }
      return why + ": “" + def.label + "” requires note content. Click “Full note” or switch to “Ask” to chat without a note.";
    }
    if (!aiInputText()) {
      return "No note content · " + (def.id === "ask" ? "enter your question below to send" : "describe what to write below to send");
    }
    return "No note content · will " + (def.id === "ask" ? "answer" : "generate") + " based on your instructions";
  }

  /** Pull configuration once: refresh forms, titles, status and button availability */
  function refreshAIConfig(quiet) {
    return S.aiConfig().then(function (cfg) {
      aiState.cfg = cfg;
      syncAIConfigForm(cfg);
      renderAIModel();
      refreshAITargetUI();
      if (!quiet && cfg && !cfg.ready && aiState.cfgPristine) {
        // When you open it for the first time, you find there's no match: just open the frame and save it."Why isn't it moving?"The confusion.
        openAIConfigModal();
      }
      return cfg;
    });
  }

  /* ---------------- Configure bullet frames (no chat area) ---------------- */

  function openAIConfigModal() {
    var m = $("ai-cfg-modal");
    if (!m) { return; }
    aiState.cfgPristine = true;
    syncAIConfigForm(aiState.cfg);
    aiConfigMsg("", "");
    m.hidden = false;
    var btn = $("aip-cfg-toggle");
    if (btn) { btn.classList.add("on"); }
    var first = $("aic-baseurl");
    if (first) { setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 0); }
  }

  function closeAIConfigModal() {
    var m = $("ai-cfg-modal");
    if (m) { m.hidden = true; }
    var btn = $("aip-cfg-toggle");
    if (btn) { btn.classList.remove("on"); }
  }

  function collectAIConfigForm() {
    var val = function (id) { var e = $(id); return e ? String(e.value || "") : ""; };
    var on = function (id) { var e = $(id); return !!(e && e.checked); };
    var cfg = {
      enabled: on("aic-enabled"),
      provider: val("aic-provider") || "openai",
      baseUrl: val("aic-baseurl").trim(),
      model: val("aic-modelinput").trim(),
      systemPrompt: val("aic-sysprompt"),
      rememberKey: on("aic-remember")
    };
    var t = parseInt(val("aic-timeout"), 10);
    if (t > 0) { cfg.timeoutSecs = t; }
    var m = parseInt(val("aic-maxchars"), 10);
    if (m > 0) { cfg.maxChars = m; }
    var key = val("aic-key");
    if (key.trim()) { cfg.apiKey = key.trim(); }   // Leave space. = Do Not Modify
    return cfg;
  }

  /** persist=true (a) Crash (permanent validity);false For Only「Test connection」，Do Not Write Profile */
  function submitAIConfig(persist) {
    aiConfigMsg(persist ? "Saving…" : "Applying (not saving)…", "");
    return S.aiSetConfig(collectAIConfigForm(), persist).then(function (view) {
      aiState.cfg = view;
      aiState.cfgPristine = true;
      syncAIConfigForm(view);
      renderAIModel();
      refreshAITargetUI();
      if (persist) {
        var where = view.keyOnDisk
          ? "Configuration saved (API key stored in local plugin data directory)"
          : (view.hasKey ? "Configuration saved (API key valid for this session only; “Remember key on this machine” unchecked)" : "Configuration saved");
        aiConfigMsg(where, "ok");
        toast("AI configuration saved");
        // There's nothing left to look at when you're done.
        closeAIConfigModal();
      } else {
        aiConfigMsg("Settings applied but not saved: click “Save” to keep them permanently", "");
      }
      return view;
    }).catch(function (e) {
      aiConfigMsg("Save failed: " + aiErrText(e), "err");
    });
  }

  function testAIConfig() {
    var btn = $("aic-test");
    if (btn) { btn.disabled = true; }
    aiConfigMsg("Testing connection (may take up to one minute)…", "");
    S.aiTest(collectAIConfigForm()).then(function (r) {
      if (r && r.success) {
        aiConfigMsg(r.message || "Connected successfully", "ok");
      } else {
        aiConfigMsg((r && r.message) || "Test failed (no reason returned)", "err");
      }
    }).catch(function (e) {
      aiConfigMsg("Test failed: " + aiErrText(e), "err");
    }).then(function () {
      if (btn) { btn.disabled = false; }
    });
  }

  function clearLocalAIConfig() {
    confirmListModal("Clear locally saved AI configuration?", [
      "This deletes the AI configuration file (including any saved API keys) from the local plugin data directory.",
      "The connection configuration for “AI.MD Notes” will be used instead.",
      "Notes, connection settings, and storage directory will remain unchanged."
    ], "Clear").then(function (ok) {
      if (!ok) { return; }
      S.aiResetConfig().then(function (view) {
        aiState.cfg = view;
        aiState.cfgPristine = true;
        syncAIConfigForm(view);
        renderAIModel();
        refreshAITargetUI();
        aiConfigMsg("Local configuration cleared; now using connection configuration", "ok");
        toast("Local AI configuration cleared");
      }).catch(function (e) {
        aiConfigMsg("Clear failed: " + aiErrText(e), "err");
      });
    });
  }

  /* ---------------- Session records (four operations per result) ---------------- */

  function aiHintEl() {
    var d = document.createElement("div");
    d.className = "aip-hint";
    // The hint will be changed in mode: in chat mode"Pick a task."It'll make people think they need to pick something first.
    var lines = aiIsChat()
      ? ["Chat directly with AI here (text only, no note content sent).",
         "To analyze a note or write results back, switch to “Compose” above.",
         "Configure model settings via ⚙ in the top right."]
      : ["Select a task and click the button below; see “Target” above for content to be sent.",
         "“Clear” sends no note content; “Ask” and “Continue” remain available.",
         "Results are never written back automatically — choose “Insert at cursor / Replace selection / Append to end / Copy”."];
    lines.forEach(function (t, i) {
      if (i) { d.appendChild(document.createElement("br")); }
      d.appendChild(document.createTextNode(t));
    });
    return d;
  }

  // (a) Creative mode: the result is written in notes, all four;
  // Chat mode: pure conversation, no"Where to write back?"That's all. Just stay.「Copy」。
  var AI_OPS_CREATE = [
    { op: "insert", text: "Insert at cursor" },
    { op: "replace", text: "Replace selection" },
    { op: "append", text: "Append to end" },
    { op: "copy", text: "Copy" }
  ];
  var AI_OPS_CHAT = [{ op: "copy", text: "Copy" }];

  function aiEntryEl(en) {
    var box = document.createElement("div");
    box.className = "aip-entry";

    var head = document.createElement("div");
    head.className = "aip-entry-head";
    var task = document.createElement("span");
    task.className = "aip-entry-task";
    task.textContent = en.kind === "chat"
      ? "Chat"
      : (en.taskLabel + (en.targetLabel ? " (" + en.targetLabel + ")" : ""));
    head.appendChild(task);
    var note = document.createElement("span");
    note.className = "aip-entry-note";
    note.textContent = en.kind === "chat" ? "No note content"
      : (en.noteName ? ("“" + en.noteName + "”") : "(No note content)");
    head.appendChild(note);
    var meta = document.createElement("span");
    meta.className = "aip-entry-meta";
    meta.textContent = en.meta || "";
    head.appendChild(meta);
    box.appendChild(head);

    if (en.instruction) {
      var ins = document.createElement("div");
      ins.className = "aip-entry-instr";
      ins.textContent = (en.task === "ask" ? "Question: " : "Instructions: ") + en.instruction;
      box.appendChild(ins);
    }

    if (en.pending) {
      var busy = document.createElement("div");
      busy.className = "aip-busy";
      busy.textContent = "Generating… (usually seconds to tens of seconds, please wait for slower models)";
      box.appendChild(busy);
      return box;
    }

    var body = document.createElement("pre");
    body.className = "aip-entry-body" + (en.error ? " err" : "");
    body.textContent = en.error ? ("Failed: " + en.error) : (en.result || "(Empty result)");
    box.appendChild(body);

    if (!en.error && en.result) {
      var acts = document.createElement("div");
      acts.className = "aip-entry-actions";
      // Only chat entries「Copy」；Only four writebacks for creation entries
      (en.kind === "chat" ? AI_OPS_CHAT : AI_OPS_CREATE).forEach(function (def) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = def.text;
        b.onclick = function () { applyAIResult(en, def.op); };
        acts.appendChild(b);
      });
      box.appendChild(acts);
    }
    return box;
  }

  function renderAILog() {
    var log = $("aip-log");
    if (!log) { return; }
    while (log.firstChild) { log.removeChild(log.firstChild); }
    if (!aiState.entries.length) {
      log.appendChild(aiHintEl());
      return;
    }
    aiState.entries.forEach(function (en) { log.appendChild(aiEntryEl(en)); });
    // The rolling container is... #aip-scroll（Scroll as a whole in the first half, with a fixed bottom bar; return if it is not available log For yourself.
    var sc = $("aip-scroll") || log;
    sc.scrollTop = sc.scrollHeight;
  }

  function clearAILog() {
    if (!aiState.entries.length) { toast("No conversation history yet"); return; }
    aiState.entries = [];
    renderAILog();
    toast("Conversation history cleared");
  }

  /* ---------------- Mission ---------------- */

  function runAITask() {
    if (aiState.busy) { return; }
    var chat = aiIsChat();
    // Chat mode: no mission, no object, just send out what you say.task Use ask，text empty = No notes.
    var def = chat ? { id: "ask", label: "Chat", go: "Send", noContext: true } : aiTaskDef(aiState.task);
    var tgt = chat ? null : aiTarget();
    var extra = aiInputText();
    var text = (tgt && !tgt.empty) ? String(tgt.text) : "";
    var hasText = !!text.trim();

    if (chat) {
      if (!extra) { toast("Enter a message before sending", "warn"); return; }
    } else if (def.id === "ask" && !extra) {
      toast(hasText ? "Enter your question below first" : "Enter your question below first (you can ask without a note)", "warn");
      return;
    } else if (!hasText) {
      // No text: Only noContext The mission can run, and we have to write the questions./Request
      if (!def.noContext) { toast(aiReadyText(aiState.cfg), "warn"); return; }
      if (!extra) { toast("Describe what to write below first", "warn"); return; }
    }

    var entry = {
      kind: chat ? "chat" : "create",
      task: def.id,
      taskLabel: def.label,
      noteId: (tgt && tgt.note) ? tgt.note.id : null,
      noteName: (tgt && tgt.note) ? String(tgt.note.name || "") : "",
      instruction: extra,
      // 「Selection」/「Entire note」/「without note content」—— Record what it actually used.
      targetLabel: hasText ? tgt.label : "No note content",
      hasSelection: hasText && !!tgt.hasSelection,
      scopeChars: hasText ? aiCharCount(text) : 0,
      result: "",
      error: "",
      meta: "",
      pending: true
    };
    aiState.busy = true;
    aiState.entries.push(entry);
    if (aiState.entries.length > AI_MAX_ENTRIES) { aiState.entries.shift(); }
    renderAILog();
    setAIReady(aiState.cfg);
    var go = $("aip-go");
    if (go) { go.textContent = chat ? "Sending…" : "Generating…"; }

    var started = Date.now();
    S.aiChat(def.id, text, extra).then(function (r) {
      entry.pending = false;
      entry.result = String((r && r.content) || "");
      if (!entry.result) { entry.error = "Model returned empty content"; }
      var bits = [];
      if (r && r.model) { bits.push(r.model); }
      if (r && r.truncated) { bits.push("Truncated to " + r.sentChars + " chars"); }
      bits.push(((r && r.latencyMs != null) ? r.latencyMs : (Date.now() - started)) + " ms");
      entry.meta = bits.join(" · ");
    }).catch(function (e) {
      entry.pending = false;
      entry.error = aiErrText(e);
    }).then(function () {
      aiState.busy = false;
      renderAILog();
      var g = $("aip-go");
      if (g) { g.textContent = aiIsChat() ? "Send" : aiTaskDef(aiState.task).go; }
      refreshAITargetUI();
    });
  }

  /* ---------------- Resultback (four operations) ---------------- */

  function currentSelection(ed) {
    if (!ed || ed.selectionStart == null || ed.selectionEnd == null) { return null; }
    if (ed.selectionEnd <= ed.selectionStart) { return null; }
    return { start: ed.selectionStart, end: ed.selectionEnd };
  }

  function applyAIResult(en, op) {
    var ed = $("editor");
    var n = activeNote();
    if (!ed || !n) { toast("Select a note on the left first", "warn"); return; }
    if (en.noteId && n.id !== en.noteId) {
      // The result came from another note: it was almost certainly a mistake to write in.
      // （noteId Yes null = They didn't have any notes. They didn't exist."Serial Notes"Question, write directly)
      confirmListModal("This result is from a different note", [
        "Result generated from: “" + en.noteName + "”",
        "Currently editing: “" + String(n.name || "") + "”",
        "",
        "Continuing will write the result into “" + String(n.name || "") + "”."
      ], "Continue").then(function (ok) {
        if (ok) { doApplyAIResult(en, op, ed, n); }
      });
      return;
    }
    doApplyAIResult(en, op, ed, n);
  }

  function doApplyAIResult(en, op, ed, n) {
    var result = String(en.result || "");
    if (!result) { toast("This result has no content", "warn"); return; }
    if (op === "copy") { copyText(result, "AI result"); return; }

    var v = String(ed.value || "");
    var sel = currentSelection(ed);

    if (op === "append") {
      var tail = (v.length && !/\n$/.test(v)) ? "\n\n" : "";
      ed.value = v + tail + result;
      ed.selectionStart = ed.selectionEnd = ed.value.length;
      commitEditor(n, ed);
      toast("Appended to end");
      return;
    }

    // Line Break/The text is always changed to cover.「Insert」It's a replacement.
    if (op === "replace" || sel) {
      if (!sel) { toast("No text selected; cannot replace", "warn"); return; }
      var oldText = v.slice(sel.start, sel.end);
      var oldLines = oldText.split(/\r?\n/).length;
      var newLines = result.split(/\r?\n/).length;
      confirmListModal("Replace selected content?", [
        "Range: " + sel.start + "–" + sel.end + " (" + oldText.length + " chars)",
        "Lines: " + oldLines + " lines → " + newLines + " lines",
        "",
        "Content before replacement:",
        oldText.slice(0, 300) + (oldText.length > 300 ? "…" : "")
      ], "Replace").then(function (ok) {
        if (!ok) { return; }
        var cur = String(ed.value || "");
        // During the confirmation box, the user may have changed the text again: the range is abandoned and never bad.
        if (sel.end > cur.length) { toast("Content changed; please reselect before replacing", "warn"); return; }
        ed.value = cur.slice(0, sel.start) + result + cur.slice(sel.end);
        ed.selectionStart = ed.selectionEnd = sel.start + result.length;
        commitEditor(n, ed);
        toast("Replaced selected content");
      });
      return;
    }

    // No Selection → Purely insert, without moving any existing body
    var at = (ed.selectionStart == null) ? v.length : ed.selectionStart;
    ed.value = v.slice(0, at) + result + v.slice(at);
    ed.selectionStart = ed.selectionEnd = at + result.length;
    commitEditor(n, ed);
    toast("Inserted at cursor");
  }

  function commitEditor(n, ed) {
    n.content = ed.value;
    n.updatedAt = nowISO();
    ed.focus();
    persist(false);
    renderPreview();
    updateCounter();
    renderTree();
    renderAITarget();   // Text by AI It's rewritten. The object preview is updated.
  }

  /* ---------------- Panel Switch ---------------- */

  function setAIPanelOpen(open) {
    aiState.open = !!open;
    var app = $("app");
    var btn = $("btn-ai");
    var panel = $("ai-panel");
    if (app) { app.setAttribute("data-ai", aiState.open ? "on" : "off"); }
    if (panel) { panel.hidden = !aiState.open; }
    if (btn) { if (aiState.open) { btn.classList.add("on"); } else { btn.classList.remove("on"); } }
    if (aiState.open) {
      renderAIMode();
      renderAITabs();
      renderAITarget();
      refreshAIConfig();
    } else {
      closeAIConfigModal();
    }
    S.setPrefs({ aiPanelOpen: aiState.open });
  }

  /**
   * Open the panel.task Keeps the current mode (default chat) while omitting.
   * Right-click menu「AI Analyze / AI Polish / AI Continue writing / Question AI」The use of which to process notes - automatically to create mode.
   */
  function openAIPanel(task) {
    if (task) {
      aiState.view = "create";
      aiState.task = aiTaskDef(task).id;
    }
    if (!aiState.open) {
      setAIPanelOpen(true);
    } else {
      renderAIMode();
      renderAITabs();
      renderAITarget();
      refreshAITargetUI();
    }
    if (task) { toast("Switched to “Compose · " + aiTaskDef(task).label + "”"); }
  }

  function toggleAIPanel() { setAIPanelOpen(!aiState.open); }

  /* ---------------- Three-column width (towed partition) ----------------
   * Width exists on side vehicle (<dataDir>/prefs.json）：In the sandbox. window.origin yes "null"（opaque origin），
   * Visits localStorage It'll just throw. SecurityError；Nor should it be inserted in the notes -- this is the interface for every machine.
   */
  var SIDE_MIN = 180, SIDE_MAX = 720, SIDE_DEFAULT = 272;
  var AI_MIN = 280, AI_MAX = 720, AI_DEFAULT = 400;
  var layout = { side: SIDE_DEFAULT, ai: AI_DEFAULT };

  function clampWidth(v, min, max) {
    var n = Number(v);
    if (!isFinite(n)) { return min; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return Math.round(n);
  }

  function applyLayout() {
    var app = $("app");
    if (!app) { return; }
    app.style.setProperty("--side-w", layout.side + "px");
    app.style.setProperty("--ai-w", layout.ai + "px");
  }

  function saveLayout() {
    S.setPrefs({ sidebarWidth: layout.side, aiWidth: layout.ai });
  }

  function loadLayout() {
    return S.getPrefs().then(function (p) {
      if (p && typeof p.sidebarWidth === "number") { layout.side = clampWidth(p.sidebarWidth, SIDE_MIN, SIDE_MAX); }
      if (p && typeof p.aiWidth === "number") { layout.ai = clampWidth(p.aiWidth, AI_MIN, AI_MAX); }
      applyLayout();
      aiState.layoutReady = true;
      if (p && p.aiPanelOpen === true) { setAIPanelOpen(true); }
      return p;
    });
  }

  /**
   * Drag a partition line to the pointer.
   * Pointer Event + setPointerCapture Self-realization: in sandboxes HTML5 Dragdragstart/drop）It'll be banned.
   * And it's... iframe There are no cross-element coordinates.
   */
  function bindGutter(el, opts) {
    if (!el) { return; }
    var dragging = false;
    var startX = 0;
    var startW = 0;

    function move(e) {
      if (!dragging) { return; }
      var dx = e.clientX - startX;
      var next = startW + (opts.invert ? -dx : dx);
      layout[opts.key] = clampWidth(next, opts.min, opts.max);
      applyLayout();
    }
    function stop(e) {
      if (!dragging) { return; }
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var b = document.body;
      if (b && b.classList) { b.classList.remove("resizing"); }
      saveLayout();
    }

    el.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) { return; }
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = layout[opts.key];
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var b = document.body;
      if (b && b.classList) { b.classList.add("resizing"); }
    });
    // move / up Hang on document Up, not the partition itself:
    // Once the pointer moves out of the partition, you can't get it on the elements. pointermove，
    // Assemble「Half of it is broken.」；setPointerCapture In some environments (e.g. for testing) jsdom）It doesn't exist.
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    // Double-click to default width: a little bit less to drag back
    el.addEventListener("dblclick", function () {
      layout[opts.key] = opts.def;
      applyLayout();
      saveLayout();
    });
  }

  function initGutters() {
    bindGutter($("gutter-side"), { key: "side", min: SIDE_MIN, max: SIDE_MAX, def: SIDE_DEFAULT, invert: false });
    bindGutter($("gutter-ai"), { key: "ai", min: AI_MIN, max: AI_MAX, def: AI_DEFAULT, invert: true });
    applyLayout();
  }

  /** Early start-up: connect the partition immediately. DOM，I don't rely on sidecars) */
  function initChrome() {
    initGutters();
  }

  /** Storage ready: Read back the previous width and panel switch (to send) RPC，That's why we can't be earlier. */
  function restoreChromePrefs() {
    return loadLayout().catch(function () { /* Prefer to not read without affecting the main process */ });
  }

  // ---------------- Event binding ----------------
  function bindEvents() {
    click("btn-new-note", function () { createNote("Untitled note", targetFolderId(), ""); });
    click("btn-new-folder", function () { newFolderFlow(targetFolderId()); });
    click("btn-empty-new", function () { createNote("Untitled note", targetFolderId(), ""); });

    click("btn-rename", function () { var n = selectedNode(); if (n) { renameNode(n); } });
    click("btn-move", function () { var n = selectedNode(); if (n) { moveNodeFlow(n); } });
    click("btn-delete", function () { var n = selectedNode(); if (n) { removeNode(n); } });

    click("btn-table-note", function () { openTableModal(null); });
    click("btn-insert-sql", insertSqlBlock);
    // toolbar「AI Assistant」It's open./Off (relative right) not a dialog; right-click menu with specific tasks
    click("btn-ai", toggleAIPanel);
    click("aip-close", function () { setAIPanelOpen(false); });
    click("aip-cfg-toggle", openAIConfigModal);
    click("aip-clear-log", clearAILog);
    click("aip-go", runAITask);
    // Mode: Chat (default)/ Create
    AI_VIEWS.forEach(function (def) {
      click("aip-view-" + def.id, function () { setAIMode(def.id); });
    });
    // Configure Dialog Boxes
    click("aic-save", function () { submitAIConfig(true); });
    click("aic-test", testAIConfig);
    click("aic-clear", clearLocalAIConfig);
    click("aic-cancel", closeAIConfigModal);
    click("ai-cfg-modal", function (e) { if (e.target === $("ai-cfg-modal")) { closeAIConfigModal(); } });
    // Subject: Four sources (automatic follow-up) / Selection / Entire note / Clear)
    AI_TARGET_MODES.forEach(function (def) {
      click("aip-mode-" + def.id, function () { setAITargetMode(def.id); });
    });
    // Select and enter objects in real time. oninput，So go. addEventListener）
    bindAITargetWatch();
    // 「No text.」, the availability of sending buttons depends on whether you write or not./Request - input box also trigger refreshing
    on("aip-input", "oninput", refreshAITargetSoon);
    // As soon as the user changes the form, the service end will no longer be covered by it (otherwise)「Save Failed → Refill」It will be filled out in vain.
    on("ai-cfg-modal", "oninput", function () { aiState.cfgPristine = false; });
    on("ai-cfg-modal", "onchange", function () { aiState.cfgPristine = false; });
    // Note:index.html Lee. #btn-copy-sql It's an annotated state, and it has to be secured here.optional=true），
    // Or the whole thing. bindEvents Interrupted here.2026-09-21 Actual accident: All buttons remain intact + The notes never drop.
    click("btn-copy-sql", copySqlToDbx, true);
    click("btn-export-md", function () { exportNote(activeNote()); });
    // Import function temporarily down (ENABLE_IMPORT=false）：The entrance was removed along with the binding, avoiding the presence of unresponsive buttons.
    if (ENABLE_IMPORT) { click("btn-import-md", pickImportFiles); }
    click("btn-backup-zip", backupAll);
    click("btn-restore-zip", restoreFlow);

    click("tn-cancel", closeTableModal);
    click("tn-ok", submitTableModal);
    click("table-modal", function (e) { if (e.target === $("table-modal")) { closeTableModal(); } });
    on("tn-fields", "onkeydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { submitTableModal(); }
    });

    if (ENABLE_IMPORT) {
      on("file-input", "onchange", function (e) {
        handleImport(e.target.files);
        e.target.value = "";
      });
    }

    on("backup-input", "onchange", function (e) {
      handleRestoreFile(e.target.files);
      e.target.value = "";
    });

    var search = $("search");
    if (search) {
      search.oninput = function () {
        state.query = search.value;
        $("search-clear").hidden = !search.value;
        renderTree();
      };
    } else {
      S.log("Bind oninput → #search", false, "Element not found; search unavailable");
    }
    click("search-clear", function () {
      search.value = ""; state.query = ""; $("search-clear").hidden = true; renderTree(); search.focus();
    });

    var title = $("title");
    title.oninput = function () {
      var n = activeNote();
      if (!n) { return; }
      n.name = title.value || "Untitled note";
      n.updatedAt = nowISO();
      persist(true);
      renderTree();
    };
    title.onblur = function () {
      var n = activeNote();
      if (!n) { return; }
      var clean = uniqueName(n.parentId, String(n.name || "Untitled note").trim() || "Untitled note", n.id);
      n.name = clean;
      title.value = clean;
      persist(false);
      renderTree();
    };

    var editor = $("editor");
    editor.oninput = function () {
      var n = activeNote();
      if (!n) { return; }
      n.content = editor.value;
      n.updatedAt = nowISO();
      persist(true);
      updateCounter();
      if (previewTimer) { clearTimeout(previewTimer); }
      previewTimer = setTimeout(renderPreview, 120);
    };
    editor.onblur = function () { persist(false); };

    var vs = $("view-switch");
    var btns = vs ? vs.querySelectorAll("button") : [];
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () { setView(b.getAttribute("data-view")); };
      })(btns[i]);
    }

    click("btn-theme", function () {
      manualTheme = (document.documentElement.getAttribute("data-theme") === "dark") ? "light" : "dark";
      applyTheme();
    });

    // Right button in directory blank → Root Directory Menu
    on("tree", "oncontextmenu", function (e) {
      if (e.target !== $("tree")) { return; }
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, null);
    });

    // Put the button on the top diagnostic bar: SHOW_DIAG_BAR Together, offline (Elements are commented and bound to log noise).
    // If you need a barrier to release with the switch above:
    // click("diag-toggle", function () { diagOpen = !diagOpen; renderDiag(); });
    // click("diag-copy", function () { copyText(S.report(), "diagnostic report"); });
    // click("diag-detail", openStoreModal);

    // Status Bar capsule → Status Details Dialog Window
    click("store-status", openStoreModal);

    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        S.flush().then(function () { toast("Saved"); });
        return;
      }
      if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        createNote("Untitled note", targetFolderId(), "");
        return;
      }
      if (mod && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        toggleAIPanel();
        return;
      }
      if (mod && e.key === "Enter" && aiState.open) {
        // AI Press in the input box of the bar Ctrl/Cmd+Enter Directly perform current tasks
        e.preventDefault();
        runAITask();
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.focus();
        return;
      }
      if (e.key === "Escape") {
        closeCtxMenu();
        if (!$("modal").hidden) { closeModal(); }
        if (!$("table-modal").hidden) { closeTableModal(); }
        if (!$("ai-cfg-modal").hidden) { closeAIConfigModal(); }
      }
    });

    document.addEventListener("click", function () { closeCtxMenu(); });

    // Theme Follow DBX
    window.addEventListener("dbx-plugin-env", function () { applyTheme(); });
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (!manualTheme) { applyTheme(); }
        });
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------- Start ----------------
  /** Read the notebook directory actually used by the sidecar storage.js Parsing from Connection Configuration) */
  function readConfiguredDir() {
    try {
      var st = S.status();
      configuredDir = st.storageDir || st.storagePath || "";
    } catch (e) { configuredDir = ""; }
  }

  function boot() {
    S.log("Frontend boot started", null, "readyState=" + document.readyState);

    // Status/Refresh status bar as soon as the log changes + Top bar
    S.onStatus(function () {
      try { renderStatus(); renderDiag(); } catch (e) { /* ignore */ }
    });
    S.onDiag(function () {
      try { renderDiag(); } catch (e) { /* ignore */ }
    });

    var phase = "Bind events";
    try {
      bindEvents();
      phase = "Initialize three-column layout";
      initChrome();
      phase = "Apply theme";
      applyTheme();
      phase = "Read configured directory";
      readConfiguredDir();
      phase = "Initial render";
      renderStatus(S.status());
      renderDiag(S.status());
      S.log("Frontend UI ready", true, "Button bindings complete (top diagnostic bar offline); initializing storage via init()");
    } catch (e) {
      // Key: If you make a mistake at any pre-emptive stage, draw a diagnostic note, otherwise the user will see only one dead end. Noodles.
      S.log("Frontend boot interrupted", false, phase + " phase threw error: " + ((e && e.message) || String(e)));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
      try { toast("UI initialization error; check diagnostics at the top", "warn"); } catch (e2) { /* ignore */ }
    }

    var initResult;
    try {
      initResult = S.init();
    } catch (e) {
      S.log("Call to storage init() threw error", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
      return;
    }
    if (!initResult || typeof initResult.then !== "function") {
      S.log("Call to storage init()", false, "Did not return a Promise (storage layer may not have loaded correctly)");
      return;
    }

    initResult.then(function (res) {
      readConfiguredDir();
      renderStatus(S.status());
      renderDiag(S.status());

      var data = res.data;
      var seeded = false;
      if (data && Object.prototype.toString.call(data.nodes) === "[object Array]") {
        state.nodes = data.nodes;
        state.activeId = data.activeId || null;
        state.expanded = data.expanded || {};
        state.view = data.view || "split";
        state.deletedIds = [];
        indexContentMissing(data.nodes);
      } else if (res.firstRun && S.status().persistent) {
        // Only 「There is no data.」; reading to an empty array will never re-initiate.
        // Otherwise, every time a user removes a note, the example is plugged back.
        // If storage is not sustainable, it is not released: otherwise it will be plugged into a collection of false data that cannot be stored and will cover up real failures.
        seed();
        seeded = true;
      }
      state.loaded = true;
      if (!S.status().persistent) {
        toast("Storage not ready; notes will not be saved to disk. Check diagnostics at the top.", "warn");
      }

      if (state.activeId && !byId(state.activeId)) { state.activeId = null; }
      if (!state.activeId) {
        var firsts = state.nodes.filter(function (n) { return n.type === "note"; });
        if (firsts.length) { state.activeId = firsts[0].id; }
      }

      setView(state.view);
      handleHostContext();
      render();
      renderDiag(S.status());
      // Width &「Did it last time? AI Column」There's a sidecar.
      restoreChromePrefs();
      // Keep the whole snapshot on startup.
      //
      // It used to be unconditional. persist(false)"Write a check to write."，The price is to push the old snapshot of this example into a state of authority:
      // When the same memory directory is opened by the second connection, the example that was opened first will be used by it once.
      // The old list overwrites the index (the new notes are deleted on the spot and the changed text is rolled back).
      // Now two things:
      //   - Writeability → Use non-destructive. notes/probe（Write Only .mdnotes/ In the probe file)
      //   - There's really new data to drop. seed )→ Only to save
      probeWritable();
      if (seeded) { persist(false); }
    }).catch(function (e) {
      S.log("Storage init() completion error", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
    });
  }

  /** Non-destructive writeability detection: no index, no text, only written .mdnotes/ Lower probe file */
  function probeWritable() {
    return S.invoke("notes/probe", {}).then(function (r) {
      if (r && r.ok === false) {
        S.log("Storage writability probe failed", false, (r && r.error) || "Unknown error");
      } else {
        S.log("Storage writability probe passed", true, (r && r.dir) || "");
      }
      return !!(r && r.ok !== false);
    }).catch(function (e) {
      // The old sidecar didn't. notes/probe：Degraded. ping（No data.
      S.log("Writability probe unavailable, falling back to ping", false, (e && e.message) || String(e));
      return true;
    });
  }

  /* ---------------- Start ----------------
   * Start immediately. Wait. dbxPlugin.ready。
   * Old version: `dbxPlugin.ready.then(boot)`：Once ready For any reason. resolve，
   * Whole UI Always stop at the initial state (buttons all dead, status forever) unknown），And there are no mistakes.
   * storage.js Inside himself. await ready（And... 8 The outer layer does not need to wait again.
   */
  var booted = false;
  function bootOnce(why) {
    if (booted) { return; }
    booted = true;
    S.log("Trigger boot", null, why);
    try {
      boot();
    } catch (e) {
      S.log("boot threw exception", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { bootOnce("DOMContentLoaded"); });
  } else {
    bootOnce("DOM ready when script executed (readyState=" + document.readyState + ")");
  }
  // Bottom: in case DOMContentLoaded It was not triggered (in a historical accident, the interface was completely intact).3 Force start in seconds.
  setTimeout(function () { bootOnce("Fallback timer 3s"); }, 3000);
})();
