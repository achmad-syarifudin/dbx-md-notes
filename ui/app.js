/*
 * AI.MD 笔记 主逻辑
 * 依赖（按 index.html 加载顺序）：sql-highlight.js、markdown.js、storage.js
 *
 * 本版修复：
 *  - 笔记丢失：存储层多后端探测 + 写入失败可见；仅在「确实没有任何数据」时才初始化示例
 *  - 目录树：笔记/文件夹图标区分、支持移动到任意文件夹（对话框 + 拖拽）、右键菜单
 *  - 导出：文件名安全化、重名处理、沙箱禁用下载时降级为「可复制」弹窗、支持文件夹导出 zip
 *  - 体验：状态栏（存储后端/字数/视图切换）、空状态、Toast、快捷键、明暗主题跟随 DBX
 */
(function () {
  "use strict";

  var S = window.MDNotes.storage;
  function $(id) { return document.getElementById(id); }

  /**
   * 安全绑定：元素不存在时记一条诊断日志并跳过，绝不抛错中断启动。
   * 历史事故：index.html 里 `btn-copy-sql` 被注释掉，而 bindEvents 里仍写
   *   `$("btn-copy-sql").onclick = copySqlToDbx;`
   * → TypeError: Cannot set properties of null
   * → bindEvents 在这里中断（后面 40 多个绑定全部没执行）
   * → boot() 第一行就抛错 → applyTheme/renderStatus/S.init 从未执行
   * → 表现为「所有按钮点不动 + 存储状态一直停在 unknown + 笔记永远不落盘」。
   * 现在改成：缺元素只记日志，不再连坐后面所有绑定。
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

  /** 页面级错误捕获：任何未捕获异常都进置顶诊断条，不再静默失败 */
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
    // 本会话内【用户显式删掉】的节点 id（删文件夹时含其全部子节点）。
    // 只累积、不清理：多带一次已删的 id 是无害的，而漏带就会让删除不生效。
    // 后端只认这个列表，绝不把「快照里没有」当成删除 —— 否则另一端（同目录的另一个
    // 连接）保存旧快照时就会把这边新建的笔记删掉。
    deletedIds: [],
    // 正文没读上来的笔记 id：这类笔记【不许】把正文写回（会把磁盘上的正文清空）。
    // 由 notes/load 的 contentMissing 标记填充。
    contentMissing: {}
  };
  var manualTheme = null;
  var configuredDir = "";   // 连接表单里填的「笔记存储目录」（宿主传入，前端只能读不能写）
  var dragId = null; // 保留兼容，指针拖拽使用 pdrag
  var pdrag = null; // 指针拖拽状态：{id, n, row, startX, startY, moved, ghost}
  var previewTimer = null;
  var toastTimer = null;

  // ---------------- 基础工具 ----------------
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
  /** 新建笔记时默认落到哪个文件夹：当前选中文件夹 → 当前笔记所在文件夹 → 根目录 */
  function targetFolderId() {
    var n = selectedNode();
    if (!n) { return null; }
    return n.type === "folder" ? n.id : (n.parentId || null);
  }

  // ---------------- 持久化 ----------------
  function snapshot() {
    // 正文没读上来的笔记【省略 content 字段】：后端见到"没带正文"就原样保留磁盘内容。
    // 若这里发一个空串，后端会把它当作"用户把正文清空了"写盘 —— 笔记就真的没了。
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

  /** 记录哪些笔记的正文没读上来（后端 contentMissing 标记），并给出可见提示 */
  function indexContentMissing(nodes) {
    state.contentMissing = {};
    var n = 0;
    (nodes || []).forEach(function (x) {
      if (x && x.type === "note" && x.contentMissing) { state.contentMissing[x.id] = true; n++; }
    });
    if (n) {
      toast(n + " notes have unreadable content files. Editing is locked to prevent overwriting them. Check the storage directory.", "warn");
      S.log("Notes with missing content found during load", false, n + " locked");
    }
    return n;
  }

  /**
   * 把「载入结果」套用到 state，成功返回 true。
   *
   * 坑：S.init() / S.reload() resolve 的是 {data:{nodes,...}, firstRun, ...}，
   * 笔记数据在 .data 这一层，不在顶层。取错层会静默失败（守卫条件不成立），
   * 于是「换存储目录」或「恢复备份」后界面仍显示旧状态，而紧接着的那次
   * persist 又把旧状态写回磁盘 —— 等于把刚写好的结果原地抹掉。
   */
  function applyLoaded(res) {
    var d = (res && res.data) ? res.data : res;
    if (!d || Object.prototype.toString.call(d.nodes) !== "[object Array]") { return false; }
    state.nodes = d.nodes;
    state.activeId = d.activeId || null;
    state.expanded = d.expanded || {};
    if (d.view) { setView(d.view); }
    // 重新载入 = 世界被整体替换：此前累积的删除记录作废，缺正文标记按新数据重建。
    state.deletedIds = [];
    indexContentMissing(d.nodes);
    if (state.activeId && !byId(state.activeId)) { state.activeId = null; }
    if (!state.activeId) {
      var firsts = state.nodes.filter(function (n) { return n.type === "note"; });
      if (firsts.length) { state.activeId = firsts[0].id; }
    }
    return true;
  }

  // ---------------- 图标 ----------------
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

  // ---------------- 主题 ----------------
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

  // ---------------- 通用弹窗 ----------------
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

  // ---------------- 目录树渲染 ----------------
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
    // 这里【绝对不能】写 draggable="true"：
    // 目录树的拖拽是上面用指针事件自实现的；一旦元素可原生拖拽，浏览器会在拖到几像素时
    // 抢走手势 → 触发原生 HTML5 拖拽 → 随即发 pointercancel 掐断我们的 pointermove，
    // 结果就是「拖不动 + 一路禁止光标」。2026-09-21 的实际事故正是这一行遗留属性。
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

    // 指针拖拽（不依赖 HTML5 DnD API，在沙箱/插件 webview 中更可靠）
    row.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      // 展开箭头/按钮上不启动拖拽，保证点击展开、重命名等交互正常
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

  // ---------------- 指针拖拽（替代 HTML5 DnD，避免沙箱内 dragover 不生效/无放置光标） ----------------

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

  // 返回落点：文件夹 id=移入；笔记 id=成为同级（取其父级）；null=根目录；undefined=取消（无效/自身/子文件夹）
  function computeDropTarget(x, y, srcId) {
    var nodeEl = elementToNode(x, y);
    if (!nodeEl) {
      var tree = $("tree");
      var under = document.elementFromPoint(x, y);
      if (tree && under && tree.contains(under)) { return null; } // 树空白区 = 根目录
      return undefined; // 落在插件区域外，视为取消
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
      if (dx * dx + dy * dy < 36) { return; } // 阈值 ~6px，区分点击与拖拽
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

  // 全局指针监听（仅在拖拽进行中生效，否则直接 return，不影响其它交互）
  document.addEventListener("pointermove", pdragMove);
  document.addEventListener("pointerup", pdragEnd);
  document.addEventListener("pointercancel", pdragEnd);

  // 兜底闸门：任何情况下都不允许原生 HTML5 拖拽接管目录树。
  // 原生拖拽一旦启动会立刻发 pointercancel 掐断指针拖拽，并显示禁止光标 —— 加这一层
  // 是为了让「日后有人再加回 draggable / 或从别处拖入元素」也不会把拖拽功能搞死。
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
      // 命中的父链也要显示
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

  // ---------------- 编辑器 / 预览 ----------------
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
    // 正文没读上来的笔记：冻结编辑。这种笔记绝不会把正文写回磁盘（见 snapshot），
    // 若还允许输入，用户敲的内容会静默丢失；冻结 + 说明才是诚实的做法。
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

  // ---------------- 存储状态 ----------------
  var STATUS_TEXT = {
    host: "Saved to DBX plugin storage",
    folder: "Saved to a local folder",
    local: "Saved to browser storage",
    session: "Saved temporarily (lost when closed)",
    memory: "In memory only (not saved)",
    sidecar: "Saved to the storage directory"
  };
  function renderStatus(st) {
    st = S.status();   // 必须现取副本：onStatus 回调传的是内部 status 对象（没有 .diag 等派生字段）
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
    // 异常时仅用状态条颜色 + title 提示，不再弹干扰性横幅
    pill.title = unconfigured
      ? "Notes storage directory not configured: notes are currently saved in " + (st.storageDir || st.storagePath || "the plugin's default directory") +
        ". Set the notes storage directory in connection settings and reconnect to save them in your chosen folder."
      : (bad ? "Storage error: " + (st.lastError || "not persisted")
             : "Saved persistently" + (st.storageDir ? " (" + st.storageDir + ")" : ""));
  }

  /* ============ 页面置顶诊断条（上线默认关闭，保留代码便于排障） ============
   * 2026-09-21：存储已稳定，按产品要求把置顶条下线（线上太占地方）。
   * 需要排障时：把 SHOW_DIAG_BAR 改成 true + 取消 index.html 里那段注释即可，
   * renderDiag() 的调用点全部保留着，无需再改其它地方。
   */
  var SHOW_DIAG_BAR = false;
  var SHOW_DIAG_LOG_IN_MODAL = false;   // 存储状态弹窗里的「存储诊断日志」面板，默认隐藏

  /* ============ 功能开关：导入 .md（暂时下线） ============
   * 2026-09-21：导入功能容易出问题，先摘掉入口（工具栏按钮 / 右键菜单 / 隐藏 file input 全下线），
   * 代码与处理逻辑全部保留。要恢复：把下面改成 true，并把 index.html 里 #btn-import-md 与
   * #file-input 两处注释取消即可 —— 打包闸门会校验「开关与 HTML 必须一致」，不一致直接拒绝打包。
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
    if (!SHOW_DIAG_BAR) { return; }   // 置顶诊断条已下线
    var bar = $("diag-bar");
    if (!bar) { return; }
    var st = S.status();   // 同上：必须现取副本，否则 st.diag 为空 → 日志区永远显示"（暂无日志）"
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
    // 默认展开；一旦出现严重问题（bad）强制再展开一次，保证故障不会被折叠藏起来
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

      // 诊断日志面板：上线默认隐藏（SHOW_DIAG_LOG_IN_MODAL=false），
      // 改成 true 即可放出来；日志本身始终保留在 S.status().diag / S.report() 里。
      if (SHOW_DIAG_LOG_IN_MODAL) {
        var det = document.createElement("details");
        det.className = "m-diag";
        det.open = !st.persistent;   // 有问题默认展开
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

  // ---------------- 侧栏底部：统计 ----------------
  // 这里不再显示存储位置：存储状态弹窗（点状态栏）是唯一权威出口，
  // 同一信息两处显示只会出现「两处不一致、用户不知道该信哪个」。
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

    // 未配置 storage_dir 时给出醒目提示：笔记其实写进了插件默认目录，用户看不到 → 误以为没存储。
    // 注意这里只说「去哪看」，不重复贴路径（状态弹窗里有）。
    if (st.backend === "sidecar" && st.dirConfigured === false) {
      var warn = document.createElement("div");
      warn.className = "foot-warn";
      warn.textContent = "Notes storage directory is not configured. Notes are temporarily stored in the plugin's default directory, not your chosen folder. "
        + "Set the directory in connection settings and reconnect (click the status bar for details).";
      foot.appendChild(warn);
    }
  }

  /** 授权一个本地目录，把笔记真正落盘 */
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

  // ---------------- 渲染入口 ----------------
  function render() {
    renderTree();
    renderEditor();
    renderStatus();
    renderSideFoot();
    renderDiag();
    renderAITarget();   // AI 栏顶部要显示「当前处理哪篇 / 选中多少字」，换笔记就得跟着变
  }

  // ---------------- 节点操作 ----------------
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

  // ---------------- 右键菜单 ----------------
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

  // ---------------- 导入 / 导出 / 备份 / 恢复 ----------------
  //
  // 落盘有两条通道，优先级从高到低：
  //   1. 宿主原生「另存为」（dbxPlugin.saveFile）—— 由宿主弹系统保存对话框，用户自己选目录和文件名。
  //      沙箱 iframe 里没有磁盘权限，a.download / blob 导航会被宿主静默取消，所以只能借宿主之手。
  //   2. 侧车写进「笔记存储目录」（toDisk=true）—— 宿主没有 saveFile 能力时的兜底，路径回显给用户。
  //
  // 备份必须包含配置：mdnotes-backup.json（版本/时间/原存储目录/计数）+ .mdnotes/meta.json（目录树索引）
  // + 全部正文 .md。只备份正文而不备份索引，恢复出来就是一堆没有名字和层级的孤儿文件。

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

  /** 让侧车产出字节，再交给用户：优先宿主「另存为」（自选目录），否则回退写进存储目录 */
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

  /** 备份成功后把「包里装了什么」摊开说 —— 「含配置」必须看得见，否则没人知道它能用来恢复。 */
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

  /** 已保存到用户所选目录的弹窗 */
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
   * 多行内容确认框（恢复这种破坏性操作要先逐条列清楚）。
   *
   * 注意：这里**不能**也叫 confirmModal —— 同名函数声明会被后声明的覆盖，
   * 而上面那个 confirmModal(title, message, ...) 收的是字符串。
   * 一旦重名，先声明的那个被顶掉，removeNode 传字符串进来就会
   * `lines.join is not a function` 抛错 → 「删除」按钮点了毫无反应（弹窗都出不来）。
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

  // ---------------- 从备份恢复 ----------------

  function restoreFlow() {
    var inp = $("backup-input");
    if (!inp) { toast("Restore option unavailable", "warn"); return; }
    inp.value = "";
    inp.click();
  }

  function handleRestoreFile(files) {
    var f = files && files[0];
    if (!f) { return; }
    // 宿主对 request 参数有 2 MiB 上限，base64 之后能带上行的 zip 约 1.5 MB。
    // 超过就明确拒绝并给替代方案，而不是让它失败在一个看不懂的报错上。
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
      // 恢复前先把挂起的防抖写落定，避免「恢复完成」之后又被那一帧旧快照覆盖。
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
  /** 打开「导入 .md」的文件选择框。导入功能下线时不会走到这里；
   *  取元素用安全写法（先赋值再判空），避免元素缺失时抛错把调用方连坐。 */
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

  // ---------------- 与数据库表联动 ----------------
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

  /** 从宿主传入的上下文自动建笔记（右键「为此表新建笔记」） */
  /**
   * 处理「为此表新建笔记」上下文。
   * 上下文有两个来源：
   *  1) 宿主直接把 context 挂在桥接对象上（dbxPlugin.context）
   *  2) 右键菜单由侧车记录到 pending，前端 notes/load 取回（不依赖宿主的打开方法名）
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
    var exist = state.nodes.filter(function (n) { return n.type === "note" && (n.name === title || n.name === ("表设计：" + table)); })[0];
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
    var m = String(n.name || "").match(/(?:Table design|表设计)[：:]\s*(.+)$/i);
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

  // ---------------- 初始化示例（仅在完全没有数据时） ----------------
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

  // ---------------- AI 助手（右侧常驻栏） ----------------
  //
  // 模型调用全部发生在侧车（前端在沙箱里既没有网络，也拿不到密钥）。
  // 这里只负责：取目标文本 → 展示结果（带会话记录）→ 让用户**显式**选择
  // 「插入到光标 / 替换选中 / 追加到末尾 / 复制」。
  // 任何会覆盖已有正文的操作（替换选中、在有选区时插入）都必须先过确认框 ——
  // 与全插件的「不静默覆盖」原则一致。
  //
  // 为什么不做成弹窗：弹窗会遮住笔记、关掉就丢历史，而 AI 结果常常要边看边改。
  //
  // noContext = 没有笔记正文时**仍然可用**：
  //   「提问」退化成纯对话，「续写」退化成按你的要求自由生成（两者都要求你写下问题/要求）；
  //   「分析」「润色」的语义就是处理一份现成文本，没有正文做不了 —— 所以它们没这个标记。
  var AI_TASKS = [
    { id: "analyze", label: "Analyze", hint: "Summarize key points, to-dos, and inconsistencies", needsInput: false, go: "Start analysis", noContext: false },
    { id: "polish", label: "Polish", hint: "Improve clarity while preserving meaning and Markdown structure", needsInput: true, go: "Start polish", noContext: false },
    { id: "continue", label: "Continue", hint: "Continue writing at the end; or generate from your prompt if empty", needsInput: true, go: "Start writing", noContext: true },
    { id: "ask", label: "Ask", hint: "Ask questions about the note; pure chat when no note content", needsInput: true, go: "Ask", noContext: true }
  ];

  // 两个模式（默认聊天）：
  //   聊天 —— 纯对话：只发你写的话，不带任何笔记内容；不涉及"分析对象"，也没有写回操作。
  //   创作 —— 处理笔记：出现「分析对象」与任务标签，结果带四个写回操作。
  var AI_VIEWS = [
    { id: "chat", label: "Chat", hint: "Conversation only: sends your message without note content" },
    { id: "create", label: "Compose", hint: "Work with notes: analyze content and write results back to notes" }
  ];

  // 缺配置时给中文名，用户才知道要去填哪一项
  var AI_MISSING_LABEL = {
    enabled: "Enable AI features",
    baseUrl: "API URL",
    model: "Model name",
    apiKey: "API key"
  };

  var AI_MAX_ENTRIES = 20;   // 只留最近若干条，避免长时间使用后内存无限增长

  var aiState = {
    open: false,
    view: "chat",        // chat（默认，纯对话）| create（创作：带分析对象与写回）
    task: "analyze",     // 仅创作模式使用
    cfg: null,
    busy: false,
    entries: [],
    cfgPristine: true,   // 配置弹框还没被用户改过（没改过就允许用服务端值覆盖表单）
    targetMode: "auto",  // 分析对象来源：auto | selection | note | none
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

  /* ---------------- 分析对象（显式可控 + 实时刷新） ----------------
   *
   * 之前的做法是"打开面板时算一次范围"，两个问题：
   *   1) 面板一开就把范围钉住了 —— 之后在编辑器里改选、改内容，栏里显示的还是旧的，
   *      看起来就是"对象改不了了"；
   *   2) 没有任何方式显式指定或清除对象。
   * 现在把对象做成显式状态，并且跟着编辑器实时刷新：
   *   auto      —— 跟随编辑器：有选中用选中，否则整篇（默认）
   *   selection —— 固定用选中内容（要求当前真的有选中）
   *   note      —— 固定用整篇笔记
   *   none      —— 已清除：不发送任何正文，生成按钮禁用
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

  /** 当前编辑器里的选区（没有选中则返回空串） */
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
   * 当前要交给模型的对象。
   * - `empty:true` 表示"没有可发送的正文"（已清除 / 未选中 / 笔记为空 / 根本没选笔记）：
   *   调用方据此给出**不同**的提示与后续动作，别都笼统说成"没有内容"。
   * - `noNote:true` 表示连笔记都没选（这时「提问」「续写」仍然可用）。
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

  /** 有可发送的正文（生成按钮据此启停） */
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
   * 当前状态能不能发出去。
   * 聊天模式：写下内容就能发（纯对话，不需要对象）。
   * 创作模式：有正文就能发；没有正文时只有 noContext 任务（提问 / 续写）能跑，且要自己写下要求。
   */
  function aiCanRun(cfg) {
    if (aiState.busy || !(cfg && cfg.ready)) { return false; }
    if (aiIsChat()) { return !!aiInputText(); }
    if (aiTargetUsable()) { return true; }
    if (!aiTaskDef(aiState.task).noContext) { return false; }
    return !!aiInputText();
  }

  /* ---------------- 模式：聊天 / 创作 ---------------- */

  /**
   * 切换模式。聊天模式把「分析对象 + 任务」整块收起来 ——
   * 那是创作才需要的东西，摆在纯对话栏里只会让人以为"必须先选个对象才能说话"。
   */
  function setAIMode(id) {
    var def = aiViewDef(id);
    aiState.view = def.id;
    renderAIMode();
    aiState.cfgPristine = true;
    syncAIConfigForm(aiState.cfg);
    renderAITabs();         // 任务标签只在创作模式渲染；切回来必须补画一次
    renderAILog();          // 空态提示语也要跟着模式变
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
   * 画「分析对象」区：模式按钮高亮 + 对象摘要 + 内容预览。
   * 预览是重点 —— 用户必须能一眼看出"到底要发什么出去"，否则就只能靠猜。
   */
  function renderAITarget() {
    if (!aiState.open || aiIsChat()) { return; }   // 聊天模式没有分析对象
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
   * 刷新「分析对象」相关的全部 UI：对象区 + 状态行 + 生成按钮。
   * 三处必须一起刷新 —— 只刷对象区会出现「对象写的是选中内容、状态行还写着整篇笔记」这种自相矛盾
   * （e2e 里真抓到过），用户就不知道该信哪个。
   */
  function refreshAITargetUI() {
    renderAITarget();
    var st = $("aip-status");
    if (st) { st.textContent = aiReadyText(aiState.cfg); }
    setAIReady(aiState.cfg);
  }

  // 编辑器里的划选/输入都要让「分析对象」实时跟着变 —— 否则又会变成"钉死的旧值"。
  // 用 addEventListener 而不是 on("editor", ...)：编辑器已经用属性方式挂了 oninput/onblur，
  // 属性赋值会把它整个顶掉。
  var aiTargetTimer = null;
  function refreshAITargetSoon() {
    if (!aiState.open || aiTargetTimer) { return; }
    aiTargetTimer = setTimeout(function () {
      aiTargetTimer = null;
      try { refreshAITargetUI(); } catch (e) { /* 纯展示，失败不影响主流程 */ }
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
      // 聊天模式：只发一句话，按钮就叫「发送」
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

  /** 把服务端配置填回弹框表单（仅在用户还没改过表单时覆盖，避免把正在输入的内容冲掉） */
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
    set("aic-key", "");   // 密钥从不回传，永远是空的（留空 = 不改）
  }

  /** 发送按钮的可用性 = 配置就绪 +（聊天：写了内容 / 创作：有对象或该任务可无对象且写了要求） */
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
    // 聊天模式：只发你写的话，不带任何笔记内容
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
    // 没有正文：只有「提问」「续写」能继续，且必须自己写下问题/要求
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

  /** 拉一次配置：刷新表单、标题、状态与按钮可用性 */
  function refreshAIConfig(quiet) {
    return S.aiConfig().then(function (cfg) {
      aiState.cfg = cfg;
      syncAIConfigForm(cfg);
      renderAIModel();
      refreshAITargetUI();
      if (!quiet && cfg && !cfg.ready && aiState.cfgPristine) {
        // 首次打开就发现没配对：直接把配置弹框打开，省去"为什么点不动"的困惑
        openAIConfigModal();
      }
      return cfg;
    });
  }

  /* ---------------- 配置弹框（不占聊天区） ---------------- */

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
    if (key.trim()) { cfg.apiKey = key.trim(); }   // 留空 = 不修改
    return cfg;
  }

  /** persist=true 落盘（长期有效）；false 只用于「测试连接」，不写入配置文件 */
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
        // 存完就没什么要看的了，收起弹框（有错时留着让用户看）
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

  /* ---------------- 会话记录（每条结果都有四个操作） ---------------- */

  function aiHintEl() {
    var d = document.createElement("div");
    d.className = "aip-hint";
    // 提示语要跟着模式变：聊天模式下说"选一种任务"会让人以为还得先选点什么
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

  // 创作模式：结果是要写进笔记的，四个操作都要；
  // 聊天模式：纯对话，没有"要写回哪儿"这回事，只留「复制」。
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
      // 聊天条目只留「复制」；创作条目才带四个写回操作
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
    // 滚动的容器是 #aip-scroll（上半区整体滚动，底栏固定）；拿不到就退回 log 自己
    var sc = $("aip-scroll") || log;
    sc.scrollTop = sc.scrollHeight;
  }

  function clearAILog() {
    if (!aiState.entries.length) { toast("No conversation history yet"); return; }
    aiState.entries = [];
    renderAILog();
    toast("Conversation history cleared");
  }

  /* ---------------- 执行任务 ---------------- */

  function runAITask() {
    if (aiState.busy) { return; }
    var chat = aiIsChat();
    // 聊天模式：没有任务、没有对象，就是把你说的话发出去（task 用 ask，text 为空 = 不带笔记）
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
      // 没有正文：只有 noContext 的任务能跑，且必须自己写下问题/要求
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
      // 「选中内容」/「整篇笔记」/「不带笔记内容」—— 记录本次实际用了什么
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

  /* ---------------- 结果回写（四个操作） ---------------- */

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
      // 结果来自另一篇笔记：写进去几乎一定是误操作，先问一句
      // （noteId 为 null = 生成时就没带笔记，不存在"串笔记"的问题，直接写）
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

    // 换行/覆盖都会改动已有正文，一律先确认（选中时的「插入」其实也是替换）
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
        // 确认框期间用户可能又改了正文：范围越界就放弃，绝不写坏
        if (sel.end > cur.length) { toast("Content changed; please reselect before replacing", "warn"); return; }
        ed.value = cur.slice(0, sel.start) + result + cur.slice(sel.end);
        ed.selectionStart = ed.selectionEnd = sel.start + result.length;
        commitEditor(n, ed);
        toast("Replaced selected content");
      });
      return;
    }

    // 无选区 → 纯插入，不动任何已有正文
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
    renderAITarget();   // 正文被 AI 结果改写了，对象预览要跟着更新
  }

  /* ---------------- 面板开关 ---------------- */

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
   * 打开面板。task 省略时保持当前模式（默认聊天）。
   * 右键菜单的「AI 分析 / AI 润色 / AI 续写 / 问 AI」属于处理笔记的用法 —— 自动切到创作模式。
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

  /* ---------------- 三栏宽度（拖动分隔条） ----------------
   * 宽度存在侧车（<dataDir>/prefs.json）：沙箱里 window.origin 是 "null"（opaque origin），
   * 访问 localStorage 会直接抛 SecurityError；也不该塞进笔记数据里 —— 这是每台机器的界面偏好。
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
   * 把一条分隔条接上指针拖拽。
   * 用指针事件 + setPointerCapture 自实现：沙箱里 HTML5 拖拽（dragstart/drop）会出禁止光标，
   * 而且它在 iframe 里也拿不到跨元素坐标。
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
    // move / up 挂在 document 上，而不是分隔条自己：
    // 指针一旦移出分隔条（拖快一点就会），挂在元素上就收不到 pointermove，
    // 表现成「拖一半断掉」；setPointerCapture 在部分环境（如测试用的 jsdom）并不存在。
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    // 双击复位到默认宽度：拖歪了不用一点点挪回来
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

  /** 启动早期：立刻把分隔条接上（纯 DOM，不依赖侧车） */
  function initChrome() {
    initGutters();
  }

  /** 存储就绪后：读回上次的宽度与面板开关（要发 RPC，所以不能更早） */
  function restoreChromePrefs() {
    return loadLayout().catch(function () { /* 偏好读不到不影响主流程 */ });
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    click("btn-new-note", function () { createNote("Untitled note", targetFolderId(), ""); });
    click("btn-new-folder", function () { newFolderFlow(targetFolderId()); });
    click("btn-empty-new", function () { createNote("Untitled note", targetFolderId(), ""); });

    click("btn-rename", function () { var n = selectedNode(); if (n) { renameNode(n); } });
    click("btn-move", function () { var n = selectedNode(); if (n) { moveNodeFlow(n); } });
    click("btn-delete", function () { var n = selectedNode(); if (n) { removeNode(n); } });

    click("btn-table-note", function () { openTableModal(null); });
    click("btn-insert-sql", insertSqlBlock);
    // 工具栏的「AI 助手」是开/关（常驻右栏），不是弹窗；右键菜单则会带上具体任务
    click("btn-ai", toggleAIPanel);
    click("aip-close", function () { setAIPanelOpen(false); });
    click("aip-cfg-toggle", openAIConfigModal);
    click("aip-clear-log", clearAILog);
    click("aip-go", runAITask);
    // 模式：聊天（默认）/ 创作
    AI_VIEWS.forEach(function (def) {
      click("aip-view-" + def.id, function () { setAIMode(def.id); });
    });
    // 配置弹框
    click("aic-save", function () { submitAIConfig(true); });
    click("aic-test", testAIConfig);
    click("aic-clear", clearLocalAIConfig);
    click("aic-cancel", closeAIConfigModal);
    click("ai-cfg-modal", function (e) { if (e.target === $("ai-cfg-modal")) { closeAIConfigModal(); } });
    // 分析对象：四种来源（自动跟随 / 选中内容 / 整篇笔记 / 清除）
    AI_TARGET_MODES.forEach(function (def) {
      click("aip-mode-" + def.id, function () { setAITargetMode(def.id); });
    });
    // 划选、输入都要让对象实时跟着变（编辑器已用属性方式挂了 oninput，所以走 addEventListener）
    bindAITargetWatch();
    // 「没有正文」时，发送按钮的可用性取决于你写没写问题/要求 —— 输入框也要触发刷新
    on("aip-input", "oninput", refreshAITargetSoon);
    // 用户一改表单就不再让服务端值覆盖它（否则「保存失败 → 重填」时会白填一遍）
    on("ai-cfg-modal", "oninput", function () { aiState.cfgPristine = false; });
    on("ai-cfg-modal", "onchange", function () { aiState.cfgPristine = false; });
    // 注意：index.html 里 #btn-copy-sql 目前是注释状态，这里必须用安全绑定（optional=true），
    // 否则整个 bindEvents 会在此处中断（2026-09-21 实际事故：所有按钮点不动 + 笔记从不落盘）。
    click("btn-copy-sql", copySqlToDbx, true);
    click("btn-export-md", function () { exportNote(activeNote()); });
    // 导入功能暂时下线（ENABLE_IMPORT=false）：入口与绑定一起摘掉，避免出现点了没反应的按钮。
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

    // 目录空白处右键 → 根目录菜单
    on("tree", "oncontextmenu", function (e) {
      if (e.target !== $("tree")) { return; }
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, null);
    });

    // 置顶诊断条上的按钮：随 SHOW_DIAG_BAR 一起下线（元素已注释，绑定会打日志噪音）。
    // 需要排障时连同上面的开关一起放开：
    // click("diag-toggle", function () { diagOpen = !diagOpen; renderDiag(); });
    // click("diag-copy", function () { copyText(S.report(), "diagnostic report"); });
    // click("diag-detail", openStoreModal);

    // 状态栏胶囊 → 状态详情弹窗
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
        // 在 AI 栏的输入框里按 Ctrl/Cmd+Enter 直接执行当前任务
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

    // 主题跟随 DBX
    window.addEventListener("dbx-plugin-env", function () { applyTheme(); });
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (!manualTheme) { applyTheme(); }
        });
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------- 启动 ----------------
  /** 读取侧车实际在用的笔记存储目录（由 storage.js 从连接配置里解析） */
  function readConfiguredDir() {
    try {
      var st = S.status();
      configuredDir = st.storageDir || st.storagePath || "";
    } catch (e) { configuredDir = ""; }
  }

  function boot() {
    S.log("Frontend boot started", null, "readyState=" + document.readyState);

    // 状态/日志一变就刷新状态栏 + 置顶诊断条
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
      // 关键：任何前置阶段出错也要把诊断条画出来，否则用户只会看到一个死界面
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
        // 只有「确实没有任何数据」时才放示例笔记；读成空数组绝不重新初始化，
        // 否则用户删空笔记后每次打开都会把示例塞回来。
        // 存储不可持久化时也不放：否则会塞进一批根本存不下的假数据，掩盖真实故障。
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
      // 宽度与「上次是否开着 AI 栏」存在侧车（插件数据目录），这里读回来
      restoreChromePrefs();
      // 启动时【绝不】保存整份快照。
      //
      // 以前这里无条件 persist(false)"写一次验证可写"，代价是把本实例的旧快照推成权威状态：
      // 同一个存储目录被第二个连接打开时，先打开的那个实例只要被打开一次，就会用它手里的
      // 旧列表覆盖索引（新增的笔记当场被删，改过的正文被回滚）。
      // 现在拆成两件事：
      //   - 可写性 → 用非破坏性的 notes/probe（只写 .mdnotes/ 里的探针文件）
      //   - 真有新数据要落盘（空目录首用 seed 了示例笔记）→ 才保存
      probeWritable();
      if (seeded) { persist(false); }
    }).catch(function (e) {
      S.log("Storage init() completion error", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
    });
  }

  /** 非破坏性可写性探测：不碰索引、不碰正文，只写 .mdnotes/ 下的探针文件 */
  function probeWritable() {
    return S.invoke("notes/probe", {}).then(function (r) {
      if (r && r.ok === false) {
        S.log("Storage writability probe failed", false, (r && r.error) || "Unknown error");
      } else {
        S.log("Storage writability probe passed", true, (r && r.dir) || "");
      }
      return !!(r && r.ok !== false);
    }).catch(function (e) {
      // 老版本侧车没有 notes/probe：退化成 ping（同样不写任何数据）
      S.log("Writability probe unavailable, falling back to ping", false, (e && e.message) || String(e));
      return true;
    });
  }

  /* ---------------- 启动 ----------------
   * 立即启动，不等 dbxPlugin.ready。
   * 旧写法是 `dbxPlugin.ready.then(boot)`：一旦 ready 因为任何原因不 resolve，
   * 整个 UI 永远停在初始状态（按钮全死、状态永远 unknown），而且没有任何报错。
   * storage.js 内部自己会 await ready（带 8 秒超时兜底），外层不需要再等一次。
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
  // 兜底：万一 DOMContentLoaded 没触发（历史事故里出现过界面完全不动的情况），3 秒后强制启动一次
  setTimeout(function () { bootOnce("Fallback timer 3s"); }, 3000);
})();
