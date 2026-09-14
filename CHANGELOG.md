# Changelog

## 1.0.6 — 2026-09-14

- Shorten the Chrome Web Store summary to "Keep several bookmark bars - one per project or context - and switch in a click". The previous line ran 118 characters in English and reached 147 in German and 142 in Greek; the store's page description trims around 128, so those two ended mid-sentence in search results. Every language now fits, the longest at 102
- Stop duplicating the English translator notes into the other 27 locale files. The `description` field is context about a string, never a translated value — Chrome ignores it at runtime and every tooling script reads it from English — so the copies were write-only. The locale files are roughly half the size; no translated text changed

## 1.0.5 — 2026-09-13

- Switching to another bar no longer erases a toolbar it does not recognise. The extension only asked before replacing the toolbar when it could tell which saved bar was loaded — a marker kept per computer. On a second machine, or any fresh install, there was no marker, so a toolbar holding bookmarks that were in no saved bar was replaced with no prompt, and browser sync then carried the emptied toolbar to every other machine
- Three states are now told apart instead of two: the toolbar matches a saved bar, it has unsaved changes against a known one, or it matches none. The third is treated as the most dangerous rather than the least — nothing about it is stored anywhere
- Switching away from an unrecognised toolbar asks first, offering Save as a new bar, Switch anyway, or Cancel. The popup also says so above the bar list, instead of showing every row idle, which read as "everything is saved"
- A keyboard switch cannot ask, so it now declines to replace an unrecognised toolbar and marks the toolbar button. Opening the popup clears the mark and offers the choice
- Switching reads every bar it is about to copy before erasing the toolbar, so a deleted or unreadable bar fails while the toolbar is still intact. If a copy fails halfway the partial toolbar is reported as unrecognised, rather than being offered for saving over a good bar. Saving a bar likewise reads the toolbar before clearing the destination
- Greek added — the interface is now available in 28 languages
- Firefox: the extension was inert because the manifest declared the background script as a classic script while the code uses ES modules, so it never loaded — taking first-run setup and every keyboard shortcut with it
- Document the switching model in the README: what the copy-based design protects, and where it stops

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
