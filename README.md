# Bookmark Bar Switcher

Keep a separate bookmark bar for each context - with shared common bookmarks and safe sync across all your computers.

## What it is

A browser sticks you with one bookmark bar. Bookmark Bar Switcher lets you keep several - work, personal, a project - and flip between them, so only the bar that fits the moment is on screen. A "common" bar can be shared into the others, and the whole thing is designed to survive browser autosync running on several machines without scrambling your saved bookmarks.

## Features

- **Multiple bookmark bars** - keep work, personal, and project bookmarks on their own bars instead of one cluttered row; only the active context shows.
- **Common bar** - flag any bar as common, then have other bars pull it in. Its bookmarks merge into each chosen bar, folder by folder. Edit the common once and every bar that uses it reflects the change.
- **Safe on multiple computers** - switching only copies a master set onto a disposable toolbar, never moving your saved bars, so browser autosync can't scramble them the way move-based switchers do.
- **Easy switching** - a popup picker to switch, rename, reorder, and delete bars, plus keyboard shortcuts: cycle with Ctrl+Down / Up, or jump to one with Ctrl+Shift+1 / 2.
- **Export & import** - export any bar to a JSON file and import it back as a new dated copy (import always adds, never overwrites).

## Install

Not yet on the Web Store. To run it unpacked:

1. Build `dist/chrome/` (see below).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → pick `dist/chrome/`.

For Edge use `dist/edge/`, for Firefox `dist/firefox/`.

## Build from source

```bash
node app-build.mjs            # builds every manifest in manifests/
node app-build.mjs chrome     # one target only
```

## Overview
The extension is built around a **copy-based** model that makes it safe under browser sync (this is the load-bearing design decision - see the invariant in `../CLAUDE.md`).

| Piece | Role |
|---|---|
| `core.js` | Shared core - the bookmark-tree model, the switch/save/merge operations, cross-browser root resolution |
| `background/main.js` | Service worker - keyboard commands, lifecycle, dispatch into `core.js` |
| `popup/` | The visual picker - switch, rename, reorder, delete bars |
| `options/` | Settings page - common-bar flags, per-bar common selection, export/import |
| `lib/i18n.js` | Runtime i18n loader |

### The model

- **Master sets** live in a `Bookmark Bars` container folder (under "Other Bookmarks") and are **never mutated by switching** - only an explicit user save rewrites one.
- **The visible bookmark bar (toolbar) is a disposable working copy.** Switching wipes it and copies the chosen master set onto it.
- **Switching copies, it never moves.** Because masters are never touched by a switch, the browser's bookmark sync cannot corrupt them across machines - the failure mode of move-based switchers.
- **The "loaded set" is tracked per-PC** in `chrome.storage.local` (not sync storage), so each machine tracks its own working state independently.
- **A common bar merges folder-by-folder** into each bar that opts into it; the common itself stays read-only.

Roots are resolved cross-browser: Firefox uses stable string IDs (`toolbar_____`, `unfiled_____`), Chrome uses numeric strings (`"1"` = toolbar, `"2"` = other), with a positional fallback.

## License / links
Bookmark Bar Switcher is part of [yaiol Applications](https://apps.yaiol.com).

Released under the [MIT License](LICENSE).
