// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  // Inline folder glyph (themed via currentColor); sized by CSS per context.
  const FOLDER_SVG = `<svg class="folder-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h3.8a2 2 0 0 1 1.4.6l1.2 1.2a2 2 0 0 0 1.4.6H19a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;

  // ---- Layout templates (the layout choices) -----------------------------
  const LAYOUTS = {
    1: { count: 1, cols: 1, rows: 1, label: "Single" },
    2: { count: 2, cols: 2, rows: 1, label: "Side by side" },
    3: { count: 3, cols: 3, rows: 1, label: "Three across" },
    4: { count: 4, cols: 2, rows: 2, label: "Two by two" },
    6: { count: 6, cols: 3, rows: 2, label: "Three by two" },
    8: { count: 8, cols: 4, rows: 2, label: "Four by two" },
  };

  // Shift-drag from the Explorer: one document-level handler serves every slot
  // and directory box, and lets events bubble on to VS Code's webview host.
  const dropTarget = (e) => e.target.closest?.(".slot, .dirbox");
  const highlight = (t) => document.querySelectorAll(".slot, .dirbox").forEach((el) => el.classList.toggle("dragover", el === t));
  document.addEventListener("dragover", (e) => { e.preventDefault(); highlight(dropTarget(e)); });
  document.addEventListener("dragleave", () => highlight(null));
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    highlight(null);
    const t = dropTarget(e);
    if (!t) return;
    const data = captureDrop(e.dataTransfer);
    if (t.dataset.dirslot) vscode.postMessage({ type: "resolveDir", data, slot: t.dataset.dirslot });
    else vscode.postMessage({ type: "resolve", data, version: state.screen === "v1" ? 1 : 2, index: Number(t.dataset.slot) });
  });

  // Rubber-band selection on the pick screen, like a desktop file manager: drag a rectangle to
  // select every plot it touches (hold Shift or Cmd to add to the current selection).
  let band = null; // transient: { x, y, base, hits, box } while a selection rectangle is drawn
  function endBand() {
    if (!band || (!band.box && band.onCard)) { band = null; return; } // a plain click on a card toggles it instead
    band.box?.remove();
    const sel = [...new Set([...band.base, ...band.hits])];
    pickWarning = sel.length > 8;
    state.selected = sel.slice(0, 8);
    setTimeout(() => (band = null)); // outlive the click that follows, so it can't toggle a card
    save();
    render();
  }
  document.addEventListener("mousedown", (e) => {
    const grid = state.screen === "pick" && e.button === 0 && e.target.closest(".pick-grid");
    if (grid && e.clientX < grid.getBoundingClientRect().left + grid.clientWidth) {
      band = { x: e.clientX, y: e.clientY, base: e.shiftKey || e.metaKey ? state.selected || [] : [], hits: [], onCard: !!e.target.closest(".pick-card") };
    }
  });
  document.addEventListener("mousemove", (e) => {
    if (band && !(e.buttons & 1)) return endBand();
    if (!band || (!band.box && Math.hypot(e.clientX - band.x, e.clientY - band.y) < 5)) return;
    const l = Math.min(band.x, e.clientX), t = Math.min(band.y, e.clientY);
    const r = Math.max(band.x, e.clientX), b = Math.max(band.y, e.clientY);
    band.box ||= document.body.appendChild(Object.assign(document.createElement("div"), { className: "marquee" }));
    Object.assign(band.box.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
    band.hits = [];
    document.querySelectorAll(".pick-card").forEach((card) => {
      const q = card.getBoundingClientRect();
      const name = decodeURIComponent(card.dataset.pick);
      if (q.left < r && q.right > l && q.top < b && q.bottom > t) band.hits.push(name);
      card.classList.toggle("selected", band.hits.includes(name) || band.base.includes(name));
    });
  });
  document.addEventListener("mouseup", endBand);
  document.addEventListener("click", (e) => { if (band?.box) e.stopPropagation(); }, true);

  // ---- State -------------------------------------------------------------
  // Each slot is null or { name, fileUri, uri }:
  //   fileUri – the original Explorer URI (stable, what we persist)
  //   uri     – the webview URI we actually render (re-resolved after reload)
  const fresh = () => ({
    screen: "template", // template | v1 | v2 | dirs | pick | compare
    mode: "manual",     // manual (layout flow) | dirs (directory flow)
    count: 0, cols: 0, rows: 0,
    v1: [], v2: [],
    compareVersion: 1,
    dirA: null, dirB: null, // { fileUri, name, path } for the directory flow
    dirNames: null,         // [nameA, nameB], shown in the compare view
    common: [],             // [{ name, fileUriA, uriA, fileUriB, uriB }]
    selected: [],           // names chosen on the pick screen
    pickView: "grid",       // grid | list — plot-picker layout
  });
  let state = vscode.getState() || fresh();
  let debugInfo = null; // transient: what a failed drop actually contained
  let confirmReset = false; // transient: compare-view "start over?" prompt is up
  let pickWarning = false; // transient: "max 8" notice on the pick screen
  let loadingCommon = false; // transient: scanning the two directories
  let navIndex = 0; // transient: keyboard-focused card on the template/pick grids
  let _lastRenderedScreen = null; // transient: screen shown on the previous render

  // Columns/rows for an arbitrary plot count (the directory flow has no preset).
  function dimsFor(count) {
    const map = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2] };
    const d = map[count] || [Math.min(count || 1, 4), Math.ceil((count || 1) / 4)];
    return { cols: d[0], rows: d[1] };
  }

  function save() { vscode.setState(state); }
  const slotsFor = (v) => (v === 1 ? state.v1 : state.v2);
  const isComplete = (v) => state.count > 0 && slotsFor(v).every((s) => !!s);

  // ---- Scroll helpers ----------------------------------------------------
  // Returns the scrollable element for the current screen (null if none).
  function scrollEl() {
    return document.querySelector(".pick-grid") || document.querySelector(".body");
  }

  // ---- Render ------------------------------------------------------------
  function gridStyle() {
    return `grid-template-columns: repeat(${state.cols}, minmax(0, 1fr));`
      + `grid-template-rows: repeat(${state.rows}, minmax(0, 1fr));`;
  }

  function plotImg(s) {
    return `<img src="${s.uri}" alt="${s.name}" draggable="false" />`;
  }

  // A readable filesystem path for a stored slot, derived from its fileUri.
  function pathOf(s) {
    const u = (s && s.fileUri) || "";
    try {
      const m = u.match(/^[a-z][a-z0-9+.\-]*:\/\/[^/]*(\/.*)$/i);
      return decodeURIComponent(m ? m[1] : u);
    } catch (_) {
      return u;
    }
  }

  // The filename preceded by up to `depth` parent directories (the rest elided),
  // so a slot shows enough context to tell similar plots apart.
  function tailPath(s, depth) {
    const full = pathOf(s);
    const parts = full.split("/").filter(Boolean);
    const tail = parts.slice(-(depth + 1));
    const elided = parts.length > tail.length;
    return (elided ? "…/" : full.startsWith("/") ? "/" : "") + tail.join("/");
  }

  // On the Version 2 screen, show what was picked for Version 1 (thumbnail,
  // name, and path) so the user can mirror it.
  function v1Reference() {
    const cells = state.v1.map((s, i) => {
      if (!s) {
        return `<div class="ref-cell empty"><span class="ref-no">${i + 1}</span></div>`;
      }
      return `<div class="ref-cell">
        <img src="${s.uri}" alt="${s.name}" draggable="false" />
        <div class="ref-name" title="${s.name}">${s.name}</div>
        <div class="ref-path" title="${pathOf(s)}">${pathOf(s)}</div>
      </div>`;
    }).join("");
    return `<div class="v1-ref">
      <div class="v1-ref-head">Version 1 — your picks</div>
      <div class="v1-ref-grid" style="grid-template-columns: repeat(${state.cols}, minmax(0, 1fr));">${cells}</div>
    </div>`;
  }

  function topbar() {
    const steps = state.mode === "dirs"
      ? [
          { key: "template", n: 1, name: "Layout" },
          { key: "dirs", n: 2, name: "Directories" },
          { key: "pick", n: 3, name: "Select plots" },
          { key: "compare", n: 4, name: "Compare" },
        ]
      : [
          { key: "template", n: 1, name: "Layout" },
          { key: "v1", n: 2, name: "Version 1" },
          { key: "v2", n: 3, name: "Version 2" },
          { key: "compare", n: 4, name: "Compare" },
        ];
    const order = steps.map((s) => s.key);
    const here = order.indexOf(state.screen);

    const items = steps
      .map((s, i) => {
        const idx = order.indexOf(s.key);
        const cls = idx === here ? "active" : idx < here ? "done" : "";
        const sep = i < steps.length - 1 ? `<div class="step-sep"></div>` : "";
        return `<div class="step ${cls}" data-step="${s.key}"><span class="dot">${s.n}</span><span>${s.name}</span></div>${sep}`;
      })
      .join("");

    return `<div class="topbar">
      <h1>Plot Compare</h1>
      <div class="steps">${items}</div>
      <button class="ghost-btn" id="reset">Start over</button>
    </div>`;
  }

  function templateScreen() {
    const cards = Object.keys(LAYOUTS).map((k) => {
      const L = LAYOUTS[k];
      const cells = Array.from({ length: L.count }, () => `<div class="cell"></div>`).join("");
      return `<button class="template-card" data-count="${k}">
        <div class="preview" style="grid-template-columns: repeat(${L.cols}, 1fr); grid-template-rows: repeat(${L.rows}, 1fr);">${cells}</div>
        <div class="count">${L.count} plot${L.count > 1 ? "s" : ""}</div>
        <div class="label">${L.label}</div>
      </button>`;
    }).join("");

    const dirCard = `<button class="template-card" data-mode="dirs">
      <div class="preview preview-dirs" style="grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(1, 1fr);">
        <div class="cell">${FOLDER_SVG}</div><div class="cell">${FOLDER_SVG}</div>
      </div>
      <div class="count">Directories</div>
      <div class="label">Compare two folders</div>
    </button>`;

    return `${topbar()}
      <div class="body">
        <div class="intro">
          <h2>Choose a layout</h2>
          <p>Pick how many plots you want to arrange and fill it twice — or compare two directories of plots at once.</p>
        </div>
        <div class="templates">${cards}${dirCard}</div>
      </div>`;
  }

  function dirBox(slot) {
    const d = slot === "A" ? state.dirA : state.dirB;
    if (d) {
      return `<div class="dirbox filled" data-dirslot="${slot}">
        <button class="remove" data-removedir="${slot}" title="Remove">×</button>
        <span class="dir-icon">${FOLDER_SVG}</span>
        <div class="dir-name" title="${d.name}">${d.name}</div>
        <div class="dir-path" title="${d.path}">${d.path}</div>
      </div>`;
    }
    return `<div class="dirbox" data-dirslot="${slot}">
      <span class="dir-icon dim">${FOLDER_SVG}</span>
      <span class="placeholder-text">Drop the ${slot === "A" ? "first" : "second"} directory here</span>
    </div>`;
  }

  function dirsScreen() {
    const ready = !!(state.dirA && state.dirB);
    const have = (state.dirA ? 1 : 0) + (state.dirB ? 1 : 0);
    return `${topbar()}
      <div class="body workspace-body">
        <div class="intro">
          <h2>Compare two directories</h2>
          <p>Select a folder in the Explorer and press ⌘⇧D (or right-click → Add to Plot Compare). We'll find the plots they share.</p>
        </div>
        <div class="dirgrid">${dirBox("A")}${dirBox("B")}</div>
      </div>
      <div class="footer">
        <span class="progress-note">${have} of 2 directories</span>
        <button class="primary-btn" id="selectimages" ${ready && !loadingCommon ? "" : "disabled"}>${loadingCommon ? "Scanning…" : "Select images →"}</button>
      </div>`;
  }

  function pickScreen() {
    const common = state.common || [];
    const sel = new Set(state.selected || []);
    const cards = common.map((it) => {
      const on = sel.has(it.name);
      return `<button class="pick-card ${on ? "selected" : ""}" data-pick="${encodeURIComponent(it.name)}">
        <span class="pick-check">${on ? "✓" : ""}</span>
        <img src="${it.uriA}" alt="${it.name}" draggable="false" />
        <div class="pick-name" title="${it.name}">${it.name}</div>
      </button>`;
    }).join("");

    const empty = common.length === 0
      ? `<p class="pick-empty">No images with matching names were found in both directories.</p>` : "";
    const n = (state.selected || []).length;
    const warn = pickWarning ? `<span class="pick-warning">Up to 8 plots can be compared at once.</span>` : "";
    const view = state.pickView === "list" ? "list" : "grid";
    const toggle = common.length === 0 ? "" : `<div class="view-toggle">
      <button class="view-btn ${view === "grid" ? "active" : ""}" data-view="grid" title="Grid view" aria-label="Grid view">▦</button>
      <button class="view-btn ${view === "list" ? "active" : ""}" data-view="list" title="List view" aria-label="List view">☰</button>
    </div>`;
    const unselectAll = n > 0 ? `<button class="ghost-btn" id="unselectall">Unselect all</button>` : "";

    return `${topbar()}
      <div class="body workspace-body">
        <div class="intro">
          <h2>Select plots to compare</h2>
          <p>Choose up to 8 plots that appear in both directories.</p>
        </div>
        <div class="pick-head">${toggle}${unselectAll}</div>
        ${empty}
        <div class="pick-grid ${view}">${cards}</div>
      </div>
      <div class="footer">
        <span class="progress-note">${n} of 8 selected ${warn}</span>
        <button class="primary-btn" id="docompare" ${n >= 1 ? "" : "disabled"}>Compare</button>
      </div>`;
  }

  function workspaceScreen(version) {
    const slots = slotsFor(version);

    const grid = slots.map((s, i) => {
      if (s) {
        return `<div class="slot filled" data-slot="${i}">
          <button class="remove" data-remove="${i}" title="Remove">×</button>
          ${plotImg(s)}<div class="slot-name" title="${s.name}">${s.name}</div>
        </div>`;
      }
      return `<div class="slot" data-slot="${i}">
        <span class="slot-no">${i + 1}</span>
        <span class="placeholder-text">Drop a plot here</span>
      </div>`;
    }).join("");

    const placed = slots.filter(Boolean).length;
    const done = placed === state.count;
    const nextLabel = version === 1 ? "Next: Version 2 →" : "Compare";
    const heading = version === 1 ? "Build version 1" : "Build version 2";
    const sub = version === 1
      ? "Select plots in the Explorer and press ⌘⇧D (or right-click → Add to Plot Compare) to fill the placeholders."
      : "Now arrange the second version of the same layout.";

    return `${topbar()}
      <div class="body workspace-body">
        <div class="intro">
          <h2>${heading}</h2>
          <p>${sub}</p>
        </div>
        ${version === 2 ? v1Reference() : ""}
        <div class="grid" style="${gridStyle()}">${grid}</div>
      </div>
      <div class="footer">
        <span class="progress-note">${placed} of ${state.count} placed</span>
        <button class="primary-btn" id="advance" ${done ? "" : "disabled"}>${nextLabel}</button>
      </div>`;
  }

  function compareScreen() {
    const v = state.compareVersion;
    const slots = slotsFor(v);
    const cells = slots.map((s) => {
      const label = s ? tailPath(s, 3) : "";
      return `<div class="compare-cell">${s ? plotImg(s) : ""}<div class="slot-name" title="${s ? pathOf(s) : ""}">${label}</div></div>`;
    }).join("");

    const confirm = confirmReset ? `<div class="confirm-overlay">
      <div class="confirm-box">
        <strong>Start over?</strong>
        <p>This clears both versions and returns to the layout chooser.</p>
        <p class="confirm-hint">Press <kbd>Enter</kbd> to start over · <kbd>Esc</kbd> to cancel</p>
      </div>
    </div>` : "";

    const dirName = state.mode === "dirs" && state.dirNames
      ? ` · ${v === 1 ? state.dirNames[0] : state.dirNames[1]}` : "";

    return `${topbar()}
      <div class="body compare-body">
        <div class="compare-head">
          <span class="version-pill"><span class="dotmark"></span>Version ${v}${dirName}</span>
          <span class="flip-hint">Press <kbd>↑</kbd> for version 1 · <kbd>↓</kbd> for version 2 · <kbd>Enter</kbd> to start over</span>
        </div>
        <div class="compare-grid" style="${gridStyle()}">${cells}</div>
      </div>${confirm}`;
  }

  function debugPanel() {
    if (!debugInfo) return "";
    const rows = (debugInfo.types || []).map((t) => {
      const v = (debugInfo.values && debugInfo.values[t]) || "";
      return `<tr><td>${t}</td><td>${v ? v.replace(/</g, "&lt;") : "<em>(empty)</em>"}</td></tr>`;
    }).join("");
    return `<div class="debug">
      <div class="debug-head">
        <strong>Drop received, but no image path was found in it.</strong>
        <button id="debug-close" class="ghost-btn small">Dismiss</button>
      </div>
      <p>Here is everything the drag carried — please send this to Claude:</p>
      <table>${rows || `<tr><td colspan="2"><em>(the drag carried no data types)</em></td></tr>`}</table>
    </div>`;
  }

  function render() {
    // When staying on the same screen, preserve the scroll position so a plot
    // selection in the pick list doesn't jump back to the top.
    const stayingSameScreen = _lastRenderedScreen === state.screen;
    const prevEl = stayingSameScreen ? scrollEl() : null;
    const savedScroll = prevEl ? prevEl.scrollTop : 0;

    if (state.screen === "template") app.innerHTML = templateScreen();
    else if (state.screen === "v1") app.innerHTML = workspaceScreen(1) + debugPanel();
    else if (state.screen === "v2") app.innerHTML = workspaceScreen(2) + debugPanel();
    else if (state.screen === "dirs") app.innerHTML = dirsScreen() + debugPanel();
    else if (state.screen === "pick") app.innerHTML = pickScreen();
    else app.innerHTML = compareScreen();

    _lastRenderedScreen = state.screen;
    bind();

    // Restore scroll position after the DOM is rebuilt.
    if (savedScroll > 0) {
      const el = scrollEl();
      if (el) el.scrollTop = savedScroll;
    }

    // On the card grids, put keyboard focus on the active card so the arrow
    // keys and Enter work immediately (and survive a re-render).
    const navSel = state.screen === "template" ? ".template-card"
      : state.screen === "pick" ? ".pick-card" : null;
    if (navSel) {
      const items = app.querySelectorAll(navSel);
      if (items.length) {
        navIndex = Math.max(0, Math.min(navIndex, items.length - 1));
        items[navIndex].focus({ preventScroll: true });
        return;
      }
    }
    // Other interactive screens: keep the webview itself focused so the
    // shortcuts (Enter to advance, arrows to flip) work without a click.
    if (state.screen !== "template") {
      app.setAttribute("tabindex", "-1");
      app.focus({ preventScroll: true });
    }
  }

  // ---- Capture an Explorer drag -----------------------------------------
  // VS Code exposes the dragged file under different data-transfer types
  // depending on build and on whether the workspace is local or remote. Rather
  // than guess, we hand every available type to the extension and let it figure
  // out which one names a real file.
  function captureDrop(dt) {
    const data = {};
    for (const t of Array.from(dt.types || [])) {
      try { data[t] = dt.getData(t); } catch (_) { data[t] = ""; }
    }
    if (dt.files && dt.files.length) {
      data["__files__"] = Array.from(dt.files).map((f) => f.name).join("\n");
    }
    return data;
  }

  // ---- Event wiring ------------------------------------------------------
  function bind() {
    const reset = document.getElementById("reset");
    if (reset) reset.addEventListener("click", () => { state = fresh(); confirmReset = false; save(); render(); });

    const debugClose = document.getElementById("debug-close");
    if (debugClose) debugClose.addEventListener("click", () => { debugInfo = null; render(); });

    // Step navigation (only to already-reachable screens)
    document.querySelectorAll(".step").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.getAttribute("data-step");
        if (target === "template") { go("template"); return; }
        if (state.mode === "dirs") {
          if (target === "dirs") go("dirs");
          else if (target === "pick" && (state.common || []).length) go("pick");
          else if (target === "compare" && isComplete(2)) go("compare");
        } else {
          if (target === "v1" && state.count) go("v1");
          else if (target === "v2" && isComplete(1)) go("v2");
          else if (target === "compare" && isComplete(2)) go("compare");
        }
      });
    });

    // Template choice
    document.querySelectorAll(".template-card").forEach((card) => {
      card.addEventListener("click", () => {
        if (card.getAttribute("data-mode") === "dirs") {
          state.mode = "dirs";
          state.dirA = null; state.dirB = null;
          state.common = []; state.selected = [];
          go("dirs");
          return;
        }
        const count = Number(card.getAttribute("data-count"));
        const L = LAYOUTS[count];
        state.mode = "manual";
        state.count = L.count;
        state.cols = L.cols;
        state.rows = L.rows;
        state.v1 = new Array(L.count).fill(null);
        state.v2 = new Array(L.count).fill(null);
        state.compareVersion = 1;
        go("v1");
      });
    });

    document.querySelectorAll("[data-removedir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.getAttribute("data-removedir") === "A") state.dirA = null;
        else state.dirB = null;
        save();
        render();
      });
    });
    const selectImages = document.getElementById("selectimages");
    if (selectImages) selectImages.addEventListener("click", requestCommon);

    // Pick screen: toggle a plot (cap at 8), then compare.
    document.querySelectorAll(".pick-card").forEach((card) => {
      card.addEventListener("click", () => {
        togglePick(decodeURIComponent(card.getAttribute("data-pick")));
      });
    });
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.pickView = btn.getAttribute("data-view") === "list" ? "list" : "grid";
        save();
        render();
      });
    });
    const unselectAll = document.getElementById("unselectall");
    if (unselectAll) unselectAll.addEventListener("click", () => { state.selected = []; pickWarning = false; save(); render(); });
    const doCompare = document.getElementById("docompare");
    if (doCompare) doCompare.addEventListener("click", startDirCompare);

    const version = state.screen === "v1" ? 1 : 2;

    // Report images that fail to load, so a bad URL is visible (not silent).
    document.querySelectorAll(".slot img, .compare-cell img").forEach((img) => {
      img.addEventListener("error", () => {
        const cell = img.closest(".slot, .compare-cell");
        if (cell) cell.classList.add("img-broken");
        vscode.postMessage({ type: "imgerror", uri: img.getAttribute("src"), name: img.getAttribute("alt") });
      });
    });

    // Remove from a slot
    document.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-remove"));
        slotsFor(version)[i] = null;
        save();
        render();
      });
    });

    // Primary advance button
    const advance = document.getElementById("advance");
    if (advance) {
      advance.addEventListener("click", () => {
        if (state.screen === "v1" && isComplete(1)) go("v2");
        else if (state.screen === "v2" && isComplete(2)) { state.compareVersion = 1; go("compare"); }
      });
    }
  }

  function go(screen) {
    state.screen = screen;
    confirmReset = false;
    pickWarning = false;
    navIndex = 0;
    save();
    render();
  }

  // Ask the extension for the images both directories have in common.
  function requestCommon() {
    if (!(state.dirA && state.dirB) || loadingCommon) return;
    loadingCommon = true;
    render();
    vscode.postMessage({ type: "listCommon", dirA: state.dirA.fileUri, dirB: state.dirB.fileUri });
  }

  // Add/remove a plot from the selection, capping it at 8.
  function togglePick(name) {
    const sel = state.selected || (state.selected = []);
    const i = sel.indexOf(name);
    if (i >= 0) { sel.splice(i, 1); pickWarning = false; }
    else if (sel.length >= 8) { pickWarning = true; }
    else { sel.push(name); pickWarning = false; }
    // Keep keyboard focus on the card that was just toggled.
    const at = (state.common || []).findIndex((it) => it.name === name);
    if (at >= 0) navIndex = at;
    save();
    render();
  }

  // Build a compare view from the chosen common plots: version 1 is directory A,
  // version 2 is directory B (same filenames).
  function startDirCompare() {
    const chosen = (state.common || []).filter((it) => (state.selected || []).includes(it.name));
    if (!chosen.length) return;
    const { cols, rows } = dimsFor(chosen.length);
    state.count = chosen.length;
    state.cols = cols;
    state.rows = rows;
    state.v1 = chosen.map((it) => ({ name: it.name, fileUri: it.fileUriA, uri: it.uriA }));
    state.v2 = chosen.map((it) => ({ name: it.name, fileUri: it.fileUriB, uri: it.uriB }));
    state.dirNames = [state.dirA && state.dirA.name, state.dirB && state.dirB.name];
    state.compareVersion = 1;
    go("compare");
  }

  // How many cards sit in one row of a wrapping grid (1 in list view).
  function columnsOf(items) {
    if (items.length < 2) return 1;
    const top0 = items[0].offsetTop;
    let c = 1;
    while (c < items.length && items[c].offsetTop === top0) c++;
    return c;
  }

  // Move keyboard focus across a card grid with the arrow keys. Enter/Space are
  // left to the browser, which activates the focused <button> (select/toggle).
  function gridNav(e, selector) {
    const items = Array.from(app.querySelectorAll(selector));
    if (!items.length) return;
    const cols = columnsOf(items);
    let idx = items.indexOf(document.activeElement);
    let next = idx;
    switch (e.key) {
      case "ArrowRight": next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1); break;
      case "ArrowLeft":  next = idx < 0 ? 0 : Math.max(0, idx - 1); break;
      case "ArrowDown":  next = idx < 0 ? 0 : Math.min(items.length - 1, idx + cols); break;
      case "ArrowUp":    next = idx < 0 ? 0 : Math.max(0, idx - cols); break;
      default: return; // Enter/Space activate the focused card natively
    }
    e.preventDefault();
    navIndex = next;
    items[next].focus({ preventScroll: true });
  }

  // ---- Keyboard shortcuts ------------------------------------------------
  window.addEventListener("keydown", (e) => {
    // Card grids: arrow keys move focus, Enter selects the focused card.
    if (state.screen === "template") { gridNav(e, ".template-card"); return; }
    if (state.screen === "pick") { gridNav(e, ".pick-card"); return; }

    // Directory flow: Enter advances when both folders are chosen.
    if (state.screen === "dirs") {
      if (e.key === "Enter" && state.dirA && state.dirB) { e.preventDefault(); requestCommon(); }
      return;
    }

    // Build screens: Enter advances once every placeholder is filled.
    if (state.screen === "v1" || state.screen === "v2") {
      if (e.key === "Enter") {
        const v = state.screen === "v1" ? 1 : 2;
        if (isComplete(v)) {
          e.preventDefault();
          if (v === 1) go("v2");
          else { state.compareVersion = 1; go("compare"); }
        }
      }
      return;
    }

    if (state.screen !== "compare") return;

    // Compare: first Enter asks to start over, second Enter confirms.
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirmReset) { confirmReset = false; state = fresh(); save(); render(); }
      else { confirmReset = true; render(); }
      return;
    }
    if (e.key === "Escape") {
      if (confirmReset) { e.preventDefault(); confirmReset = false; render(); }
      return;
    }
    if (confirmReset) return; // hold off other shortcuts while the prompt is up

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.compareVersion !== 1) { state.compareVersion = 1; save(); render(); }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.compareVersion !== 2) { state.compareVersion = 2; save(); render(); }
    }
  });

  // ---- Messages from the extension ---------------------------------------
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg) return;

    // Explorer "Add to Plot Compare": fill the next empty slots (or directory boxes) in order.
    if (msg.type === "add") {
      const dirs = state.screen === "dirs";
      const v = { v1: 1, v2: 2 }[state.screen];
      const free = dirs ? ["A", "B"].filter((k) => !state[`dir${k}`]) : v ? slotsFor(v).flatMap((s, i) => (s ? [] : [i])) : [];
      msg.uris.slice(0, free.length).forEach((u, k) => vscode.postMessage(dirs
        ? { type: "resolveDir", uris: [u], slot: free[k] }
        : { type: "resolve", uris: [u], version: v, index: free[k] }));
      return;
    }

    // A dropped directory resolved (or didn't).
    if (msg.type === "dirResolved") {
      if (msg.dir) {
        if (msg.slot === "A") state.dirA = msg.dir; else state.dirB = msg.dir;
        debugInfo = null;
      } else {
        debugInfo = msg.debug || null;
      }
      save();
      render();
      return;
    }

    // The list of images both directories share.
    if (msg.type === "commonListed") {
      state.common = msg.items || [];
      const names = new Set(state.common.map((it) => it.name));
      state.selected = (state.selected || []).filter((n) => names.has(n));
      loadingCommon = false;
      if (state.screen === "dirs") go("pick");
      else { save(); render(); } // refresh stale thumbnails after a reload
      return;
    }

    if (msg.type !== "resolved") return;
    const items = msg.items || [];

    // Refresh any existing slots pointing at these files (covers reload, where
    // the webview URI changes but the stored fileUri stays the same).
    const byFile = new Map(items.map((it) => [it.fileUri, it]));
    [1, 2].forEach((v) => {
      const arr = slotsFor(v);
      arr.forEach((s, i) => {
        if (s && byFile.has(s.fileUri)) arr[i] = { ...s, ...byFile.get(s.fileUri) };
      });
    });

    // A fresh drop fills only the slot it landed on. A single Explorer drag can
    // carry several representations of the same file, so we take just the first
    // resolved item and leave neighbouring slots untouched.
    if (msg.version && Number.isInteger(msg.index)) {
      const arr = slotsFor(msg.version);
      const it = items[0];
      if (it && msg.index < state.count) {
        arr[msg.index] = { name: it.name, fileUri: it.fileUri, uri: it.uri };
      }
    }

    // If a drop landed but produced nothing, surface what it actually held.
    debugInfo = items.length === 0 && msg.debug ? msg.debug : null;

    save();
    render();
  });

  render();

  // After a reload our stored slots hold stale webview URIs; re-resolve them.
  const existing = [...(state.v1 || []), ...(state.v2 || [])]
    .filter(Boolean)
    .map((s) => s.fileUri)
    .filter(Boolean);
  if (existing.length) {
    vscode.postMessage({ type: "resolve", uris: [...new Set(existing)] });
  }

  // Likewise re-scan the directories so the pick-screen thumbnails reload.
  if (state.mode === "dirs" && state.dirA && state.dirB &&
      (state.screen === "pick" || (state.common || []).length)) {
    vscode.postMessage({ type: "listCommon", dirA: state.dirA.fileUri, dirB: state.dirB.fileUri });
  }
})();
