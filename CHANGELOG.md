# Changelog

## 1.0.4 — 2026-08-22

- Shorten the app-icon marker comment in `src/core.js` to just the `data-icon` tag

## 1.0.3 — 2026-08-08

- Refresh bookmark icons — a popup button that quietly visits, in a background tab, the pages of the bookmarks whose icon never loaded, and fills the icons in; Shift-click refreshes every bookmark on the bar, for sites that changed their icon
- The refresh runs in the service worker and reports progress, so closing the popup can neither strand its tabs nor lose the run — reopening adopts the run in flight
- The missing-icon filter calibrates itself against two never-visited probe URLs and refreshes the whole bar when it cannot tell, so it can never silently skip work
- Chrome / Edge now request the `favicon` permission (read-only icon-cache access); Firefox has no equivalent endpoint and skips the filter
- Export a bar to Markdown, BBCode or AsciiDoc as well as JSON — a new "Import & export" section in Settings picks the format; JSON stays the complete backup (it alone restores a bar's common-bar links), the text formats are readable files carrying folders and links only
- Import accepts all four formats and detects the right one from the file itself, ignoring the picker, so a mismatched selection cannot mangle a good file
- A link whose URL the browser cannot parse is dropped on import instead of aborting a half-finished one
- Move the popup's icon-refresh button to the left side of the footer, leaving GitHub / Help / Settings alone on the right — the footer's right-hand icons stay identical across every extension, and an app-specific action now sits visibly apart
- Document the file-format codec model and the icon refresh in the README

## 1.0.2 — 2026-07-18

- Serialize bar switches so a second switch triggered before the first finishes now waits its turn, preventing duplicated or scrambled bookmarks (and Sync collisions on Firefox)

## 1.0.1 — 2026-07-18

- Faster bar switching — the disposable toolbar is now cleared in parallel instead of one bookmark at a time (Firefox's slow bookmark API made switching laggy)
- Firefox: require Firefox 142+ and declare no data collection, for AMO submission
- Replace all dynamic innerHTML with a safe DOMParser-based icon helper, so Firefox's AMO linter no longer flags it

## 1.0.0 — 2026-07-17

- Import now always adds: each bar in a file becomes a new "<name> (<date>)" copy beside the existing bars, never replacing or wiping one
- Replaced the whole Import / Export section with a single "Import bar…" button next to Add bar
- Removed the bulk Export all / Replace all / Add from file actions, per-bar Replace, and the import confirmation modal
- Export stays per-bar (each bar's own export icon)

## 1.0.0 — 2026-07-15

- Initial release
