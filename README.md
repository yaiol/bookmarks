<p align="center">
  <img src="docs/assets/logo.png" alt="Bookmark Bar Switcher" width="110" height="110">
</p>

<h1 align="center">Bookmark Bar Switcher</h1>

<div align="center">
  <strong>One bookmark bar per context.</strong><br>
  Work, personal, a project — switch between bars, share a common set, and stay safe under browser sync.
</div>

<br>

<!-- readme:nav -->

<div align="center">
  <a href="https://chromewebstore.google.com/detail/bookmark-bar-switcher/ojgicgcfipkfokdpbkjnnamhmjfcoede"><img src="https://img.shields.io/chrome-web-store/v/ojgicgcfipkfokdpbkjnnamhmjfcoede?color=5a4fff&label=chrome%20web%20store&style=flat-square" alt="Chrome Web Store"></a>
  <a href="https://chromewebstore.google.com/detail/bookmark-bar-switcher/ojgicgcfipkfokdpbkjnnamhmjfcoede"><img src="https://img.shields.io/chrome-web-store/users/ojgicgcfipkfokdpbkjnnamhmjfcoede?color=5a4fff&label=users&style=flat-square" alt="Users"></a>
</div>

<h3 align="center">
  <a href="https://apps.yaiol.com/en/p/bookmarks/">Website</a>
  <span>&nbsp;·&nbsp;</span>
  <a href="#install">Install</a>
  <span>&nbsp;·&nbsp;</span>
  <a href="#what-it-is">Features</a>
  <span>&nbsp;·&nbsp;</span>
  <a href="#documentation">Documentation</a>
  <span>&nbsp;·&nbsp;</span>
  <a href="#build-from-source">Development</a>
</h3>

<div align="center">
  <sub><a href="https://apps.yaiol.com/en/p/bookmarks/help/"><b>Help in 28 languages</b></a></sub>
</div>

<!-- /readme:nav -->

---

<p align="center">
  <img src="docs/assets/hero.png" alt="Bookmark Bar Switcher's popup picking between several bookmark bars" width="900">
</p>

---

## Install

<div align="center">
  <a href="https://chromewebstore.google.com/detail/bookmark-bar-switcher/ojgicgcfipkfokdpbkjnnamhmjfcoede"><img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-5a4fff?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install from the Chrome Web Store"></a>
</div>

Edge installs the same listing (Edge accepts Chrome Web Store extensions). To run it unpacked
instead, build `dist/chrome/` (see [Build from source](#build-from-source)), open
`chrome://extensions`, enable **Developer mode**, then **Load unpacked** → pick `dist/chrome/`.
For Edge use `dist/edge/`, for Firefox `dist/firefox/`.

---

## What it is

A browser sticks you with one bookmark bar. Bookmark Bar Switcher lets you keep several - work, personal, a project - and flip between them, so only the bar that fits the moment is on screen. A "common" bar can be shared into the others, and the whole thing is designed to survive browser autosync running on several machines without scrambling your saved bookmarks.

---

## Features

- **Multiple bookmark bars** - keep work, personal, and project bookmarks on their own bars instead of one cluttered row; only the active context shows.
- **Common bar** - flag any bar as common, then have other bars pull it in. Its bookmarks merge into each chosen bar, folder by folder. Edit the common once and every bar that uses it reflects the change.
- **Safe on multiple computers** - switching only copies a master set onto a disposable toolbar, never moving your saved bars, so browser autosync can't scramble them the way move-based switchers do.
- **Easy switching** - a popup picker to switch, rename, reorder, and delete bars, plus keyboard shortcuts: cycle with Ctrl+Down / Up, or jump to one with Ctrl+Shift+1 / 2.
- **Refresh bookmark icons** - bookmarks whose icon never loaded sit there blank forever, because a browser only fetches a favicon when it loads the page. One button in the popup visits those pages quietly in the background and fills the icons in. It targets only the bookmarks that are missing an icon; Shift-click to refresh every bookmark on the bar, for sites that have changed their icon.
- **Export & import, in four formats** - export any bar to **JSON**, **Markdown**, **BBCode**, or **AsciiDoc**, and import it back as a new dated copy (import always adds, never overwrites). JSON is the complete backup; the text formats are readable files you can paste into a forum post, a wiki, or a README. Import reads any of them and works out the format from the file itself.

---

## Documentation

| | |
|---|---|
| **User manual** | [Read it online](https://apps.yaiol.com/en/p/bookmarks/help/) |
| **What's new** | [Release notes](https://apps.yaiol.com/en/p/bookmarks/help/releases/) |
| **Product page** | [apps.yaiol.com](https://apps.yaiol.com/en/p/bookmarks/) |

---

## Build from source

```bash
node app-build.mjs            # builds every manifest in manifests/
node app-build.mjs chrome     # one target only
```

The browser loads `dist/<browser>/`, never `src/` — rebuild after every source edit, then click the
reload icon on the extension card.

---

## Architecture

The extension is built around a **copy-based** model that makes it safe under browser sync — the load-bearing design decision.

| Piece | Role |
|---|---|
| `core.js` | Shared core - the bookmark-tree model, the switch/save/merge operations, cross-browser root resolution |
| `background/main.js` | Service worker - keyboard commands, lifecycle, dispatch into `core.js` |
| `popup/` | The visual picker - switch, rename, reorder, delete bars |
| `options/` | Settings page - common-bar flags, per-bar common selection, export/import |
| `lib/formats.js` | Import/export file formats - one codec per format, around a single payload shape |
| `lib/i18n.js` | Runtime i18n loader |

<details>
<summary><b>The model — why switching copies instead of moving</b></summary>

- **Master sets** live in a `Bookmark Bars` container folder (under "Other Bookmarks") and are **never mutated by switching** - only an explicit user save rewrites one.
- **The visible bookmark bar (toolbar) is a disposable working copy.** Switching wipes it and copies the chosen master set onto it.
- **Switching copies, it never moves.** Because masters are never touched by a switch, the browser's bookmark sync cannot corrupt them across machines - the failure mode of move-based switchers.
- **The "loaded set" is tracked per-PC** in `chrome.storage.local` (not sync storage), so each machine tracks its own working state independently.
- **A common bar merges folder-by-folder** into each bar that opts into it; the common itself stays read-only.

Roots are resolved cross-browser: Firefox uses stable string IDs (`toolbar_____`, `unfiled_____`), Chrome uses numeric strings (`"1"` = toolbar, `"2"` = other), with a positional fallback.

</details>

<details>
<summary><b>File formats</b></summary>

Every export format is a codec around **one** intermediate shape - the export payload `core.js` already produced, `{ version, exportedAt, bars, sets: [{ title, children }] }`. A format supplies `serialize(payload)` and `parse(text)`, so both ends of the pipeline stay format-blind and adding a format is one entry in `FORMATS`.

- **JSON is the only lossless format.** It carries the payload verbatim, including the `bars` map that re-links a restored bar to its common bars. The text formats are a folder/link tree and nothing else, so a round-trip through one drops the commons config.
- **Import detects the format from the file extension, not from the picker.** The dropdown chooses what *export* writes; making import obey it would let a mismatched selection mangle a perfectly good file.
- **A parsed link is only emitted if its URL survives `new URL()`.** A hand-edited or mangled document therefore cannot abort a half-finished import with a `bookmarks.create()` throw - the bad entry is dropped and the rest lands.

</details>

---

## License

Released under the [MIT License](LICENSE).

<div align="center">
  <sub>Bookmark Bar Switcher is part of <a href="https://apps.yaiol.com">yaiol Applications</a>.</sub>
</div>
