# Plot Compare

A VS Code extension that lets you arrange plots into a chosen layout, build a
second version of that same layout, then flip between the two versions with the
arrow keys.

## What it does

1. Adds an icon to the **Activity Bar**. Clicking it opens a **Plot Compare**
   tab in the main editor area (not the Explorer side bar).
2. The tab first shows **six layout choices**: 1, 2, 3, 4, 6, or 8 plots.
3. Pick one and it lays out that many **placeholders**. **Hold Shift and drag**
   an image straight from the Explorer onto a placeholder — it loads in place
   instead of opening in a new tab. (Shift is what tells VS Code to hand the
   drop to the tab rather than opening the file.) Images anywhere in the tree,
   including subfolders, work; PNG/JPG/GIF/WebP/BMP/SVG are accepted.
4. When every placeholder is filled, the dimmed bottom-right button lights up:
   **Next: Version 2 →**. Click it and fill the same layout a second time.
5. When version 2 is complete, the bottom-right button becomes **Compare**.
6. In compare mode, press **↑** to show version 1 and **↓** to show version 2.

## Run it (development)

No build step — it's plain JavaScript.

1. Open this folder in VS Code: `code plot-compare`
2. Press **F5** (Run → Start Debugging). A second VS Code window
   ("Extension Development Host") opens with the extension loaded.
3. Click the **Plot Compare** icon in the Activity Bar of that new window.

## Install it locally (optional)

To use it in your normal VS Code instead of the debug host:

```bash
npm install -g @vscode/vsce
cd plot-compare
vsce package        # produces plot-compare-0.0.1.vsix
code --install-extension plot-compare-0.0.1.vsix
```

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Manifest: Activity Bar container, launcher view, command |
| `src/extension.js` | Registers the launcher; opens the editor-tab panel |
| `media/icon.svg` | Activity Bar icon |
| `media/main.js` | The webview app: chooser, drag-and-drop, compare flip |
| `media/style.css` | Themed styling (follows your VS Code theme) |

## Notes

- The plots are the real image files from your workspace, dragged in from the
  Explorer — there is no built-in tray. The compare view fills the editor and
  flips between versions with no animation, so small differences between
  version 1 and version 2 stay put and are easy to spot.
- Progress is kept per tab, so hiding and reshowing the tab keeps your work.
  Each slot remembers the file it points at and re-links it after a reload.
- Use **Start over** (top right of the tab) to reset to the layout chooser.
