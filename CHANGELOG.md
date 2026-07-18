# Changelog

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
