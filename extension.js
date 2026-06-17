const vscode = require("vscode");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // The webview that lives under the Activity Bar icon. Clicking the icon
  // resolves this view, which immediately opens the main editor tab.
  const launcher = new LauncherViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "plotCompare.launcher",
      launcher
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("plotCompare.open", () => {
      PlotComparePanel.createOrShow(context);
    })
  );
}

function deactivate() {}

/**
 * Renders a small panel in the side bar. Its only job is to open (and re-open)
 * the comparison tab in the editor area when the Activity Bar icon is clicked.
 */
class LauncherViewProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message && message.type === "open") {
        vscode.commands.executeCommand("plotCompare.open");
      }
    });

    // Open the editor tab as soon as the user clicks the Activity Bar icon.
    vscode.commands.executeCommand("plotCompare.open");

    // If the user collapses and re-expands the side bar, re-open the tab.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        vscode.commands.executeCommand("plotCompare.open");
      }
    });
  }

  getHtml() {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 14px; }
    p { font-size: 12px; line-height: 1.5; opacity: 0.85; margin: 0 0 14px; }
    button {
      width: 100%; padding: 8px 10px; cursor: pointer; border: none; border-radius: 4px;
      font-size: 13px; color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <p>Build a plot layout, add a second version, then flip between them with the arrow keys.</p>
  <button id="open">Open Plot Compare</button>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("open").addEventListener("click", () => {
      vscode.postMessage({ type: "open" });
    });
  </script>
</body>
</html>`;
  }
}

/**
 * The comparison tool itself, hosted in a WebviewPanel in the main editor area.
 * Singleton: re-running the command reveals the existing tab instead of duplicating it.
 */
class PlotComparePanel {
  static createOrShow(context) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (PlotComparePanel.current) {
      PlotComparePanel.current.panel.reveal(column);
      return;
    }

    // The webview may only load images from these roots. We start with the
    // extension's media folder plus every open workspace folder; when the user
    // drags a file from the Explorer we widen this to include its folder too,
    // so plots living anywhere (even outside the workspace) can be shown.
    const localResourceRoots = [
      vscode.Uri.joinPath(context.extensionUri, "media"),
    ];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      localResourceRoots.push(folder.uri);
    }

    const panel = vscode.window.createWebviewPanel(
      "plotCompare.tab",
      "Plot Compare",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );

    PlotComparePanel.current = new PlotComparePanel(panel, context, localResourceRoots);
  }

  constructor(panel, context, localResourceRoots) {
    this.panel = panel;
    this.context = context;
    this.roots = localResourceRoots.slice();
    this.output = vscode.window.createOutputChannel("Plot Compare");

    this.panel.webview.html = this.getHtml(this.panel.webview, context);
    this.panel.iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "icon.svg"
    );

    this.panel.webview.onDidReceiveMessage((message) => {
      if (!message) return;
      // When the user drops files from the Explorer (or the view reloads with
      // saved slots), the webview hands us the raw drag payload and we convert
      // it into webview URIs it can actually render.
      if (message.type === "resolve") {
        this.resolve(message);
      } else if (message.type === "resolveDir") {
        this.resolveDir(message);
      } else if (message.type === "listCommon") {
        this.listCommon(message);
      } else if (message.type === "imgerror") {
        this.log(`image FAILED to load: ${message.name} -> ${message.uri}`);
      }
    });

    this.panel.onDidDispose(() => {
      this.output.dispose();
      PlotComparePanel.current = undefined;
    });
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /**
   * Collect every candidate path/URI string out of a drag payload. The webview
   * sends us a map of { dataTransferType: value }; we split text lists by line
   * and JSON-decode the "resourceurls"-style arrays VS Code sometimes uses.
   */
  gatherCandidates(message) {
    const out = [];
    const add = (s) => {
      const t = String(s == null ? "" : s).trim();
      if (t && !t.startsWith("#")) out.push(t);
    };

    for (const u of message.uris || []) add(u);

    const data = message.data || {};
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (typeof val !== "string" || !val) continue;
      val.split(/\r?\n/).forEach(add); // plain text / uri-list style
      const trimmed = val.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          collectStrings(JSON.parse(trimmed), add); // pull URIs out of any JSON
        } catch {
          /* not JSON — the line split above already covered it */
        }
      }
    }
    return out;
  }

  /**
   * Turn raw file URIs (from an Explorer drag or restored state) into webview
   * URIs the page can load, widening the allowed resource roots as needed.
   */
  resolve(message) {
    const items = [];
    const seen = new Set();
    let rootsChanged = false;

    for (const raw of this.gatherCandidates(message)) {
      const uri = this.toFileUri(raw);
      if (!uri) continue;
      if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri.path)) continue; // images only
      if (seen.has(uri.toString())) continue;
      seen.add(uri.toString());

      // If the file isn't already under an allowed root, add its folder so the
      // webview is permitted to load it (handles plots outside the workspace).
      const folder = uri.with({ path: uri.path.replace(/\/[^/]*$/, "") });
      if (this.ensureRoot(folder)) rootsChanged = true;
      items.push({
        fileUri: uri.toString(),
        name: decodeURIComponent(uri.path.split("/").pop() || uri.toString()),
        uri: this.panel.webview.asWebviewUri(uri).toString(),
      });
    }

    if (rootsChanged) this.applyRoots();

    // Diagnostics: log the raw drag payload and what we made of it, and send a
    // compact copy back so a failed drop can show what it actually contained.
    let debug;
    if (message.data) {
      const types = Object.keys(message.data);
      this.log(`drop on version ${message.version}, slot ${message.index}`);
      this.log(`  data types: ${types.join(", ") || "(none)"}`);
      for (const t of types) this.log(`    [${t}] = ${String(message.data[t]).slice(0, 400)}`);
      this.log(`  -> resolved ${items.length} image(s)${items.length ? ": " + items.map((i) => i.fileUri).join(" | ") : ""}`);
      if (items.length === 0) {
        this.output.show(true);
        debug = {
          types,
          values: Object.fromEntries(types.map((t) => [t, String(message.data[t]).slice(0, 400)])),
        };
      }
    }

    this.panel.webview.postMessage({
      type: "resolved",
      items,
      version: message.version,
      index: message.index,
      debug,
    });
  }

  /** Permit the webview to load resources under `uri`; returns true if added. */
  ensureRoot(uri) {
    const s = uri.toString();
    const covered = this.roots.some((r) => {
      const base = r.toString();
      return s === base || s.startsWith(base + "/");
    });
    if (covered) return false;
    this.roots.push(uri);
    return true;
  }

  applyRoots() {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.roots,
    };
  }

  /**
   * Resolve a dropped folder: find the first candidate that is actually a
   * directory, widen the allowed roots to it, and report it back.
   */
  async resolveDir(message) {
    let found;
    for (const raw of this.gatherCandidates(message)) {
      const uri = this.toFileUri(raw);
      if (!uri) continue;
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.type & vscode.FileType.Directory) { found = uri; break; }
      } catch {
        /* not reachable — try the next candidate */
      }
    }

    if (found) {
      if (this.ensureRoot(found)) this.applyRoots();
      this.log(`directory drop on ${message.slot} -> ${found}`);
      this.panel.webview.postMessage({
        type: "dirResolved",
        slot: message.slot,
        dir: {
          fileUri: found.toString(),
          name: decodeURIComponent(found.path.split("/").filter(Boolean).pop() || found.toString()),
          path: decodeURIComponent(found.path),
        },
      });
      return;
    }

    let debug;
    if (message.data) {
      const types = Object.keys(message.data);
      this.log(`directory drop on ${message.slot} resolved no folder`);
      this.output.show(true);
      debug = {
        types,
        values: Object.fromEntries(types.map((t) => [t, String(message.data[t]).slice(0, 400)])),
      };
    }
    this.panel.webview.postMessage({ type: "dirResolved", slot: message.slot, dir: null, debug });
  }

  /** Image filenames directly inside a directory. */
  async imageNames(dir) {
    const set = new Set();
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.File) && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
          set.add(name);
        }
      }
    } catch (e) {
      this.log(`failed to read directory ${dir}: ${e}`);
    }
    return set;
  }

  /**
   * List the images that both directories contain under the same filename,
   * with a renderable webview URI for each side.
   */
  async listCommon(message) {
    const dirA = vscode.Uri.parse(message.dirA);
    const dirB = vscode.Uri.parse(message.dirB);

    let changed = false;
    if (this.ensureRoot(dirA)) changed = true;
    if (this.ensureRoot(dirB)) changed = true;
    if (changed) this.applyRoots();

    const [namesA, namesB] = await Promise.all([
      this.imageNames(dirA),
      this.imageNames(dirB),
    ]);
    const common = [...namesA]
      .filter((n) => namesB.has(n))
      .sort((a, b) => a.localeCompare(b));

    const items = common.map((name) => {
      const fa = vscode.Uri.joinPath(dirA, name);
      const fb = vscode.Uri.joinPath(dirB, name);
      return {
        name,
        fileUriA: fa.toString(),
        uriA: this.panel.webview.asWebviewUri(fa).toString(),
        fileUriB: fb.toString(),
        uriB: this.panel.webview.asWebviewUri(fb).toString(),
      };
    });

    this.log(`common images between ${dirA} and ${dirB}: ${items.length}`);
    this.panel.webview.postMessage({ type: "commonListed", items });
  }

  /**
   * Coerce one dragged string into a file URI. It may already be a full URI
   * (file:// or vscode-remote://) or just a bare path, in which case we borrow
   * the scheme/authority of a workspace folder so remote drops resolve too.
   */
  toFileUri(raw) {
    // Windows drive path (C:\...) — Uri.parse would mistake "C" for a scheme.
    if (/^[a-zA-Z]:[\\/]/.test(raw)) return vscode.Uri.file(raw);

    try {
      const u = vscode.Uri.parse(raw, true);
      if (u.scheme && u.scheme.length > 1) return u; // real scheme, not a drive
    } catch {
      /* not a strict URI — treat it as a path below */
    }

    const norm = raw.replace(/\\/g, "/");
    // Only absolute paths name a real file. Bare relative strings (e.g. a tree
    // node id like "0:em_col_mass_L1.png" that a drag sometimes carries) are not
    // files and must not be coerced into one, or they 404 in a phantom slot.
    if (!norm.startsWith("/")) return undefined;

    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length) {
      const host =
        folders.find((f) => norm.startsWith(f.uri.path + "/")) || folders[0];
      return host.uri.with({ path: norm });
    }

    try {
      return vscode.Uri.file(norm);
    } catch {
      return undefined;
    }
  }

  getHtml(webview, context) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "style.css")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Plot Compare</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Recursively walk a parsed JSON value and hand every string to `add`, so a
// file URI nested anywhere inside a drag payload's JSON still gets picked up.
function collectStrings(value, add) {
  if (typeof value === "string") add(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, add));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectStrings(v, add));
  }
}

function getNonce() {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = { activate, deactivate };
