// data-icon="yaiol:bookmarks"
/**
 * Bookmark Bar Switcher - shared core
 *
 * Copy-based architecture:
 * - Master sets live in the "Bookmark Bars" container and are NEVER mutated
 *   by switching. They are only ever rewritten by an explicit user save.
 * - The visible Bookmark Bar is a disposable working copy. Switching wipes it
 *   and copies a master set onto it.
 * - "Loaded set" is tracked per-PC in chrome.storage.local (NOT sync), so each
 *   machine tracks its own working state independently.
 * - Because masters are never touched by switching, Chrome bookmark sync
 *   cannot corrupt them across PCs.
 */

const CONTAINER_NAME = "Bookmark Bars";
const DEFAULT_BAR_NAME = "Default Bookmark Bar";
const LOCAL_LOADED_SET = "loadedSet"; // { id, title, loadedAt }
const LOCAL_COMMON_BAR_LEGACY = "commonBar"; // legacy single-common shape - migrated on init
const LOCAL_COMMON_BARS = "commonBars"; // string[] - bar IDs flagged as common
const LOCAL_BAR_COMMONS = "barCommons"; // { [barId]: string[] } - per-bar ordered common selection
const LOCAL_COMMON_IDS = "loadedCommonIds"; // string[] - live-bar IDs (recursive) that originated from any common

// ---------------------------------------------------------------------------
// Bookmark tree helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the toolbar + "other bookmarks" roots cross-browser.
 * Firefox uses stable string IDs (`toolbar_____`, `unfiled_____`).
 * Chrome uses numeric strings (`"1"` = toolbar, `"2"` = other).
 * Positional fallback covers anything unexpected.
 */
async function getRoots() {
  const tree = await chrome.bookmarks.getTree();
  const c = tree[0].children;
  const toolbar = c.find(n => n.id === "toolbar_____") || c.find(n => n.id === "1") || c[0];
  const other   = c.find(n => n.id === "unfiled_____") || c.find(n => n.id === "2") || c[1];
  return { toolbar, other };
}

/** Get the visible Bookmark Bar root ID. */
export async function getBookmarkBarId() {
  const { toolbar } = await getRoots();
  return toolbar.id;
}

/** Get or create the "Bookmark Bars" container folder (under Other Bookmarks). */
export async function getContainerId() {
  const { other } = await getRoots();
  const children = await chrome.bookmarks.getChildren(other.id);
  const existing = children.find(n => !n.url && n.title === CONTAINER_NAME);
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ parentId: other.id, title: CONTAINER_NAME });
  return created.id;
}

/** Get all bar (set) folders inside the container. */
export async function getBarFolders() {
  const containerId = await getContainerId();
  const children = await chrome.bookmarks.getChildren(containerId);
  return children.filter(n => !n.url);
}

/** Create a new empty set folder. */
export async function createBar(name) {
  const containerId = await getContainerId();
  return await chrome.bookmarks.create({ parentId: containerId, title: name });
}

/** Rename a set folder. */
export async function renameBar(id, newTitle) {
  await chrome.bookmarks.update(id, { title: newTitle });
}

/** Delete a set folder and all its contents. Purges any common flag / per-bar selection referencing this id. */
export async function removeBar(id) {
  await chrome.bookmarks.removeTree(id);
  await purgeBarReferences(id);
}

/** Reorder: move a set folder to a new index in the container. */
export async function reorderBar(barId, newIndex) {
  const containerId = await getContainerId();
  await chrome.bookmarks.move(barId, { index: newIndex, parentId: containerId });
}

// ---------------------------------------------------------------------------
// Copy / wipe primitives
// ---------------------------------------------------------------------------

/** Remove every child of a folder. */
async function wipeChildren(parentId) {
  const children = await chrome.bookmarks.getChildren(parentId);
  // Removal order is irrelevant (we're clearing the whole disposable toolbar),
  // so remove all subtrees in parallel. On Firefox's bookmarks API each op is a
  // slow round-trip; running them serially made switching noticeably laggy.
  // (Copy stays sequential — there, index = display order, so order matters.)
  await Promise.all(children.map((child) => chrome.bookmarks.removeTree(child.id)));
}

/**
 * Recursively create a copy of `node` under `parentId`. If `idCollector` is
 * provided, every created node ID (including descendants) is pushed into it.
 */
async function copyNode(node, parentId, idCollector = null) {
  if (node.url) {
    const created = await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
    idCollector?.push(created.id);
    return created.id;
  }
  const folder = await chrome.bookmarks.create({ parentId, title: node.title });
  idCollector?.push(folder.id);
  for (const child of node.children || []) {
    await copyNode(child, folder.id, idCollector);
  }
  return folder.id;
}

/** Copy all children of `sourceId` into `destId` (deep). */
async function copyChildrenInto(sourceId, destId) {
  const [source] = await chrome.bookmarks.getSubTree(sourceId);
  for (const child of source.children || []) {
    await copyNode(child, destId);
  }
}

/**
 * Copy children of `sourceId` onto `destId`, with top-level folder-name merging
 * against folders already in `destId`.
 *
 *   mode = "common": the source is a common bar. Newly created nodes (including
 *     descendants) are added to `commonIds`. Folder-name merges KEEP the
 *     existing live folder's ID in `commonIds` (the folder is still pure
 *     common, just sourced from multiple commons).
 *   mode = "x": the source is the loaded set X. Newly created nodes are NOT
 *     added to `commonIds`. Folder-name merges REMOVE the live folder's ID
 *     from `commonIds` (it now holds X items, no longer pure common).
 */
async function copyChildrenMerging(sourceId, destId, commonIds, mode) {
  const liveChildren = await chrome.bookmarks.getChildren(destId);
  const mergeMap = new Map();
  for (const c of liveChildren) {
    if (!c.url) mergeMap.set(c.title, c.id);
  }
  const [source] = await chrome.bookmarks.getSubTree(sourceId);
  const collector = mode === "common" ? [] : null;
  for (const child of source.children || []) {
    if (!child.url && mergeMap.has(child.title)) {
      const liveFolderId = mergeMap.get(child.title);
      if (mode === "x") commonIds.delete(liveFolderId);
      for (const grand of child.children || []) {
        await copyNode(grand, liveFolderId, collector);
      }
    } else {
      await copyNode(child, destId, collector);
    }
  }
  if (mode === "common" && collector) {
    for (const id of collector) commonIds.add(id);
  }
}

/**
 * Copy children of `sourceId` into `destId`, skipping any descendant (at any
 * depth) whose ID is in `excludeIds`. A folder whose ID is in `excludeIds` is
 * skipped entirely; a folder whose ID is NOT in `excludeIds` is recreated in
 * `destId` and its children are recursed into with the same exclusion.
 */
async function copyChildrenIntoExcludingRecursive(sourceId, destId, excludeIds) {
  const [source] = await chrome.bookmarks.getSubTree(sourceId);
  for (const child of source.children || []) {
    await copyNodeWithExclusion(child, destId, excludeIds);
  }
}

async function copyNodeWithExclusion(node, parentId, excludeIds) {
  if (node.url) {
    if (excludeIds.has(node.id)) return;
    await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
    return;
  }
  // Folder: if it's excluded (common-origin) but contains non-excluded
  // descendants, recreate the folder shell so those descendants survive the
  // save. On the next switch, the top-level name-merge in
  // copyChildrenMerging reunites this shell with the common copy.
  if (excludeIds.has(node.id) && !hasNonExcludedDescendant(node, excludeIds)) return;
  const folder = await chrome.bookmarks.create({ parentId, title: node.title });
  for (const child of node.children || []) {
    await copyNodeWithExclusion(child, folder.id, excludeIds);
  }
}

function hasNonExcludedDescendant(folder, excludeIds) {
  for (const child of folder.children || []) {
    if (!excludeIds.has(child.id)) return true;
    if (!child.url && hasNonExcludedDescendant(child, excludeIds)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Structural snapshot / diff
// ---------------------------------------------------------------------------

/** Serialize a bookmark node to a minimal shape: title + url OR title + children. */
function serialize(node) {
  if (node.url) return { t: node.title, u: node.url };
  return { t: node.title, c: (node.children || []).map(serialize) };
}

/** Snapshot the children of a folder as a plain array (ignores IDs/favicons). */
async function snapshotChildren(folderId) {
  const [node] = await chrome.bookmarks.getSubTree(folderId);
  return (node.children || []).map(serialize);
}

/**
 * Snapshot the children of a folder, recursively dropping any descendant
 * (at any depth) whose ID is in `excludeIds`. A folder whose ID is in
 * `excludeIds` is dropped entirely; a folder not in the set is kept and its
 * children are filtered recursively.
 */
async function snapshotChildrenExcluding(folderId, excludeIds) {
  const [node] = await chrome.bookmarks.getSubTree(folderId);
  return (node.children || [])
    .filter(c => keepUnderExclusion(c, excludeIds))
    .map(c => serializeExcluding(c, excludeIds));
}

function serializeExcluding(node, excludeIds) {
  if (node.url) return { t: node.title, u: node.url };
  return {
    t: node.title,
    c: (node.children || [])
      .filter(c => keepUnderExclusion(c, excludeIds))
      .map(c => serializeExcluding(c, excludeIds)),
  };
}

/**
 * Whether to keep `node` when snapshotting under exclusion.
 * Drop excluded URLs outright. Keep excluded folders only if they still
 * contain a non-excluded descendant (so user-added contents in a common-origin
 * folder survive the save / dirty-comparison).
 */
function keepUnderExclusion(node, excludeIds) {
  if (node.url) return !excludeIds.has(node.id);
  if (!excludeIds.has(node.id)) return true;
  return hasNonExcludedDescendant(node, excludeIds);
}

/** True if two snapshots are structurally identical. */
function snapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Loaded-set marker (per-PC, local only)
// ---------------------------------------------------------------------------

/** Read the per-PC loaded-set marker, validated against the container. */
export async function getLoadedSet() {
  const result = await chrome.storage.local.get(LOCAL_LOADED_SET);
  const stored = result[LOCAL_LOADED_SET];
  if (!stored?.id) return null;
  try {
    const [node] = await chrome.bookmarks.get(stored.id);
    const containerId = await getContainerId();
    if (node && !node.url && node.parentId === containerId) {
      return { id: node.id, title: node.title, loadedAt: stored.loadedAt };
    }
  } catch {}
  return null;
}

/** Write the per-PC loaded-set marker. */
async function setLoadedSet(folder) {
  await chrome.storage.local.set({
    [LOCAL_LOADED_SET]: { id: folder.id, title: folder.title, loadedAt: Date.now() },
  });
}

/** Clear the per-PC loaded-set marker. */
async function clearLoadedSet() {
  await chrome.storage.local.remove(LOCAL_LOADED_SET);
}

// ---------------------------------------------------------------------------
// Common bar flag + per-bar common selection + live-bar common-origin tracking
// ---------------------------------------------------------------------------

/**
 * A "common" bar is a regular set folder whose contents can be prepended to
 * any other bar that opts into using it. Multiple bars may be flagged common.
 * Each non-common bar carries an ordered list of common IDs it uses (empty by
 * default for newly created bars).
 *
 * Storage shape:
 *   commonBars:  string[]                - bar IDs flagged as common
 *   barCommons:  { [barId]: string[] }   - per-bar ordered selection
 *
 * Both are sanitized on every read so stale IDs (deleted bars, demoted
 * commons) never leak into the merge logic.
 */

/** Return the set of bar IDs currently flagged as common, validated against the container. */
export async function getCommonBarIds() {
  const result = await chrome.storage.local.get(LOCAL_COMMON_BARS);
  const raw = result[LOCAL_COMMON_BARS];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const bars = await getBarFolders();
  const valid = new Set(bars.map(b => b.id));
  const filtered = raw.filter(id => valid.has(id));
  if (filtered.length !== raw.length) {
    await chrome.storage.local.set({ [LOCAL_COMMON_BARS]: filtered });
  }
  return filtered;
}

/** Mark or unmark a bar as common.
 * When marking: clear this bar's own per-bar selection (commons-of-commons forbidden).
 * When unmarking: remove this id from every other bar's per-bar selection. */
export async function setCommonFlag(barId, isCommon) {
  const current = await getCommonBarIds();
  const set = new Set(current);
  if (isCommon) set.add(barId);
  else set.delete(barId);
  await chrome.storage.local.set({ [LOCAL_COMMON_BARS]: [...set] });

  const all = await getAllBarCommons();
  let changed = false;
  if (isCommon && all[barId]) {
    delete all[barId];
    changed = true;
  }
  if (!isCommon) {
    for (const key of Object.keys(all)) {
      const filtered = all[key].filter(id => id !== barId);
      if (filtered.length !== all[key].length) {
        all[key] = filtered;
        changed = true;
      }
    }
  }
  if (changed) await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
}

/** Read the full barCommons map (raw, unfiltered). Internal use. */
async function getAllBarCommons() {
  const result = await chrome.storage.local.get(LOCAL_BAR_COMMONS);
  const raw = result[LOCAL_BAR_COMMONS];
  return raw && typeof raw === "object" ? { ...raw } : {};
}

/** Return the ordered list of common IDs that bar `barId` uses, filtered to currently-valid commons. */
export async function getBarCommons(barId) {
  const all = await getAllBarCommons();
  const list = Array.isArray(all[barId]) ? all[barId] : [];
  if (list.length === 0) return [];
  const commonIds = new Set(await getCommonBarIds());
  return list.filter(id => commonIds.has(id) && id !== barId);
}

/** Save the ordered common-selection for bar `barId`. Filters to valid commons. */
export async function setBarCommons(barId, orderedCommonIds) {
  const valid = new Set(await getCommonBarIds());
  const clean = (orderedCommonIds || []).filter(id => valid.has(id) && id !== barId);
  const all = await getAllBarCommons();
  if (clean.length === 0) {
    delete all[barId];
  } else {
    all[barId] = clean;
  }
  await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
}

/**
 * Append `commonId` to every non-common bar's picker selection (at the end if
 * not already present). Returns the array of bar IDs whose selection changed
 * - caller passes it to `maybeRemergeAffected` to refresh those bars.
 */
export async function addCommonToAllBars(commonId) {
  const commonIdSet = new Set(await getCommonBarIds());
  if (!commonIdSet.has(commonId)) return [];
  const all = await getAllBarCommons();
  const bars = await getBarFolders();
  const changed = [];
  for (const bar of bars) {
    if (commonIdSet.has(bar.id)) continue; // common bars don't use commons
    const current = Array.isArray(all[bar.id]) ? all[bar.id] : [];
    if (current.includes(commonId)) continue;
    all[bar.id] = [...current, commonId];
    changed.push(bar.id);
  }
  if (changed.length > 0) {
    await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
  }
  return changed;
}

/**
 * Remove `commonId` from every bar's picker selection.
 * Returns the array of bar IDs whose selection changed.
 */
export async function removeCommonFromAllBars(commonId) {
  const all = await getAllBarCommons();
  const changed = [];
  for (const [barId, list] of Object.entries(all)) {
    if (!Array.isArray(list) || !list.includes(commonId)) continue;
    const filtered = list.filter(id => id !== commonId);
    if (filtered.length === 0) delete all[barId];
    else all[barId] = filtered;
    changed.push(barId);
  }
  if (changed.length > 0) {
    await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
  }
  return changed;
}

/** Drop a bar's record from every storage shape touching it. Called on removeBar. */
async function purgeBarReferences(barId) {
  // Drop from commonBars flag
  const commons = await getCommonBarIds();
  if (commons.includes(barId)) {
    await setCommonFlag(barId, false); // cascades into barCommons
  }
  // Drop the bar's own per-bar selection
  const all = await getAllBarCommons();
  if (all[barId]) {
    delete all[barId];
    await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
  }
}

/** Read the set of live-bar IDs (recursive) that came from any common at last switch. */
async function getCommonOriginIds() {
  const result = await chrome.storage.local.get(LOCAL_COMMON_IDS);
  const arr = result[LOCAL_COMMON_IDS];
  return new Set(Array.isArray(arr) ? arr : []);
}

async function setCommonOriginIds(ids) {
  await chrome.storage.local.set({ [LOCAL_COMMON_IDS]: ids });
}

async function clearCommonOriginIds() {
  await chrome.storage.local.remove(LOCAL_COMMON_IDS);
}

/**
 * Migrate the legacy single-common shape to the new multi-common shape:
 *   commonBar: {id} → commonBars: [id]
 * Every existing non-common bar opts into [id] so its merge behavior is
 * preserved (the legacy model implicitly merged every non-common bar with
 * the one common bar).
 */
async function migrateLegacyCommon() {
  const result = await chrome.storage.local.get(LOCAL_COMMON_BAR_LEGACY);
  const stored = result[LOCAL_COMMON_BAR_LEGACY];
  if (!stored?.id) return;
  const containerId = await getContainerId();
  try {
    const [node] = await chrome.bookmarks.get(stored.id);
    if (node && !node.url && node.parentId === containerId) {
      await chrome.storage.local.set({ [LOCAL_COMMON_BARS]: [stored.id] });
      const bars = await getBarFolders();
      const all = await getAllBarCommons();
      for (const b of bars) {
        if (b.id === stored.id) continue;
        if (!Array.isArray(all[b.id]) || all[b.id].length === 0) {
          all[b.id] = [stored.id];
        }
      }
      await chrome.storage.local.set({ [LOCAL_BAR_COMMONS]: all });
    }
  } catch {}
  await chrome.storage.local.remove(LOCAL_COMMON_BAR_LEGACY);
}

// ---------------------------------------------------------------------------
// Dirty detection / match-finding
// ---------------------------------------------------------------------------

/**
 * True if the visible bar differs structurally from the loaded set.
 * Returns false when there is no loaded set (unknown baseline → not "dirty").
 *
 * Common-aware: if the loaded set is not itself the common bar, common-origin
 * items in the live bar are filtered out before the comparison.
 */
export async function isBarDirty() {
  const loaded = await getLoadedSet();
  if (!loaded) return false;
  const barId = await getBookmarkBarId();
  const commonIds = await getCommonOriginIds();
  const barSnap = await snapshotChildrenExcluding(barId, commonIds);
  const setSnap = await snapshotChildren(loaded.id);
  return !snapshotsEqual(barSnap, setSnap);
}

/** Find a set whose contents exactly match the visible bar (filtered by common-origin IDs), if any. */
async function findSetMatchingBar() {
  const barId = await getBookmarkBarId();
  const commonIds = await getCommonOriginIds();
  const barSnap = await snapshotChildrenExcluding(barId, commonIds);
  const barJson = JSON.stringify(barSnap);
  const sets = await getBarFolders();
  const commonFlagIds = new Set(await getCommonBarIds());
  for (const set of sets) {
    if (commonFlagIds.has(set.id)) continue;
    const setSnap = await snapshotChildren(set.id);
    if (JSON.stringify(setSnap) === barJson) return set;
  }
  return null;
}

/**
 * Reconcile the loaded-set marker against the current bar contents.
 *
 * If the bar exactly matches a known set, mark that set as loaded (clean state).
 * If nothing matches and no marker exists, leave it null - switching later will
 * treat it as "no baseline" and skip the save prompt.
 */
export async function autoDetectLoadedSet() {
  const match = await findSetMatchingBar();
  if (match) {
    const loaded = await getLoadedSet();
    if (!loaded || loaded.id !== match.id) {
      await setLoadedSet(match);
    }
    return match;
  }
  return await getLoadedSet();
}

/**
 * Single optimized pass that returns everything the popup needs to render.
 *
 * Fast path (common case): bar still matches the currently loaded set.
 *   → 2 snapshots total (bar + loaded set), no walk over every set.
 * Slow path: bar differs from the loaded set.
 *   → walks remaining sets looking for a match, else flags as dirty.
 */
export async function getBarState() {
  let bars = await getBarFolders();
  if (bars.length === 0) {
    // First install race: background hasn't initialised yet. init() here is
    // cheap because there's nothing to snapshot.
    await init();
    bars = await getBarFolders();
  }
  const barId = await getBookmarkBarId();
  const commonBarIds = await getCommonBarIds();
  const loaded = await getLoadedSet();
  const commonIds = await getCommonOriginIds();
  const barSnap = await snapshotChildrenExcluding(barId, commonIds);
  const barJson = JSON.stringify(barSnap);

  // Fast path: loaded set still matches the (filtered) bar
  if (loaded) {
    const loadedSnap = await snapshotChildren(loaded.id);
    if (JSON.stringify(loadedSnap) === barJson) {
      return { bars, loaded, dirty: false, commonBarIds };
    }
  }

  // Slow path: find another (non-common) set whose contents match
  const commonFlagSet = new Set(commonBarIds);
  for (const set of bars) {
    if (loaded && set.id === loaded.id) continue;
    if (commonFlagSet.has(set.id)) continue;
    const setSnap = await snapshotChildren(set.id);
    if (JSON.stringify(setSnap) === barJson) {
      await setLoadedSet(set);
      return { bars, loaded: set, dirty: false, commonBarIds };
    }
  }

  return { bars, loaded, dirty: !!loaded, commonBarIds };
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Replace the visible bar with a copy of the target set. Destroys current bar
 * contents - the caller is responsible for saving first if needed.
 */
// ⚠ CLAUDE: single-flight — never let two switches run concurrently. Two
// overlapping switches both wipe + rewrite the SAME toolbar (and on Firefox
// collide with Sync mid-upload), which duplicates / scrambles bookmarks — the
// exact "switch again before the first finished = mess" failure. A switch
// requested while one is in flight WAITS its turn, so every bookmark write is
// strictly sequential. Do NOT remove this serialization.
let _switchQueue = Promise.resolve();
export function switchToBar(targetId) {
  const run = _switchQueue.then(() => _switchToBar(targetId));
  _switchQueue = run.catch(() => {});   // keep the chain alive past a rejection
  return run;
}

async function _switchToBar(targetId) {
  const barId = await getBookmarkBarId();
  const [target] = await chrome.bookmarks.get(targetId);
  if (!target || target.url) return;
  await wipeChildren(barId);

  const commonIds = new Set();
  const allCommons = new Set(await getCommonBarIds());
  // Common bars never opt into other commons (forbidden by design). Use the
  // target's selection only if the target is not itself common.
  const selection = allCommons.has(target.id) ? [] : await getBarCommons(target.id);

  for (const commonId of selection) {
    if (commonId === target.id) continue;
    if (!allCommons.has(commonId)) continue;
    await copyChildrenMerging(commonId, barId, commonIds, "common");
  }
  await copyChildrenMerging(target.id, barId, commonIds, "x");

  if (commonIds.size > 0) {
    await setCommonOriginIds([...commonIds]);
  } else {
    await clearCommonOriginIds();
  }
  await setLoadedSet(target);
}

/**
 * Overwrite a set's contents with a copy of the visible bar.
 *
 * Common-aware: if the saved set is not itself the common bar, common-origin
 * items in the live bar are stripped before copying (they belong to common,
 * not to this set).
 */
export async function saveBarToSet(setId) {
  const barId = await getBookmarkBarId();
  const [set] = await chrome.bookmarks.get(setId);
  if (!set || set.url) return;
  await wipeChildren(set.id);
  const commonIds = await getCommonOriginIds();
  if (commonIds.size > 0) {
    await copyChildrenIntoExcludingRecursive(barId, set.id, commonIds);
  } else {
    await copyChildrenInto(barId, set.id);
  }
  await setLoadedSet(set); // refresh loadedAt, clears dirty state
}

/** Save the bar back into the currently loaded set. No-op if nothing is loaded. */
export async function saveBarToLoadedSet() {
  const loaded = await getLoadedSet();
  if (!loaded) return null;
  await saveBarToSet(loaded.id);
  return loaded;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

const EXPORT_VERSION = 2;

/** Readable serialization used for export files (keys: title, url, children). */
function serializeFull(node) {
  if (node.url) return { title: node.title, url: node.url };
  return { title: node.title, children: (node.children || []).map(serializeFull) };
}

async function snapshotChildrenFull(folderId) {
  const [node] = await chrome.bookmarks.getSubTree(folderId);
  return (node.children || []).map(serializeFull);
}

/** YYYY-MM-DD stamp from an export payload's ISO `exportedAt` (falls back to today). */
function exportDateStamp(exportedAt) {
  const iso = typeof exportedAt === "string" ? exportedAt : "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

/**
 * Build an export payload for a single set: one `sets` entry, plus a `bars`
 * map scoped to this one bar's common-bar config (if any). This is the only
 * export path - each bar is exported on its own and restored via
 * importSetsAsNewBars() as a new dated copy.
 */
export async function exportSingleSet(setId) {
  const [node] = await chrome.bookmarks.get(setId);
  if (!node || node.url) throw new Error("Set not found");

  const sets = await getBarFolders();
  const idToTitle = new Map(sets.map(b => [b.id, b.title]));
  const commonIds = new Set(await getCommonBarIds());
  const bars = {};
  if (commonIds.has(setId)) {
    bars[node.title] = [];
  } else {
    const selection = await getBarCommons(setId);
    const titles = selection.map(id => idToTitle.get(id)).filter(t => typeof t === "string");
    if (titles.length > 0) bars[node.title] = titles;
  }

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    bars,
    sets: [{
      title: node.title,
      children: await snapshotChildrenFull(setId),
    }],
  };
}

/** Recursively create a bookmark node from export-format data under `parentId`. */
async function createFromData(node, parentId) {
  if (!node || typeof node !== "object") return;
  if (typeof node.url === "string") {
    await chrome.bookmarks.create({
      parentId,
      title: typeof node.title === "string" ? node.title : "",
      url: node.url,
    });
    return;
  }
  if (typeof node.title === "string") {
    const folder = await chrome.bookmarks.create({ parentId, title: node.title });
    for (const child of node.children || []) {
      await createFromData(child, folder.id);
    }
  }
}

/**
 * Import every set in an export payload as a NEW bar - never replaces, wipes,
 * or reorders an existing bar. Each new bar is named "<original title> (<date>)"
 * where <date> is the export's own date (YYYY-MM-DD), so a restored backup sits
 * beside the original for inspection instead of overwriting it. The visible
 * bookmark bar and the loaded-set marker are untouched.
 *
 * Common-bar config from the `bars` map is applied conservatively:
 * - A standard bar (non-empty title list) gets its common-picker links
 *   restored, but only to commons that STILL EXIST (matched by title); missing
 *   ones are silently dropped. This re-links a restored bar to its commons.
 * - A bar exported as common itself (empty list) is NOT re-flagged common - the
 *   imported copy is a plain inspection bar the user promotes by hand.
 *
 * Returns the array of created set nodes. Throws on a malformed payload.
 */
export async function importSetsAsNewBars(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.sets)) {
    throw new Error("Invalid import file: missing 'sets' array");
  }
  const date = exportDateStamp(data.exportedAt);
  const barsMap = (data.bars && typeof data.bars === "object" && !Array.isArray(data.bars))
    ? data.bars
    : {};
  const containerId = await getContainerId();

  // Currently-common bars indexed by title, so a restored standard bar can
  // re-link to commons that still exist (matched by title; missing → dropped).
  const commonIds = new Set(await getCommonBarIds());
  const commonTitleToId = new Map();
  for (const b of await getBarFolders()) {
    if (commonIds.has(b.id) && !commonTitleToId.has(b.title)) commonTitleToId.set(b.title, b.id);
  }

  const created = [];
  for (const setData of data.sets) {
    if (!setData || typeof setData.title !== "string") continue;
    const set = await chrome.bookmarks.create({
      parentId: containerId,
      title: `${setData.title} (${date})`,
    });
    for (const child of setData.children || []) {
      await createFromData(child, set.id);
    }
    created.push(set);

    // Restore common-picker links for a standard bar (non-empty title list).
    const roles = barsMap[setData.title];
    if (Array.isArray(roles) && roles.length > 0) {
      const ids = roles.map(t => commonTitleToId.get(t)).filter(id => typeof id === "string");
      if (ids.length > 0) await setBarCommons(set.id, ids);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Bootstrap the container and loaded-set marker.
 *
 * - No container yet → create it.
 * - Container has no sets yet → create a default set seeded from whatever the
 *   user currently has in the bar (preserves pre-install bookmarks).
 * - Container has sets → try to auto-detect which one is currently loaded.
 */
export async function init() {
  await getContainerId();
  const bars = await getBarFolders();
  if (bars.length === 0) {
    const containerId = await getContainerId();
    const barId = await getBookmarkBarId();
    const defaultSet = await chrome.bookmarks.create({
      parentId: containerId,
      title: DEFAULT_BAR_NAME,
    });
    await copyChildrenInto(barId, defaultSet.id);
    await setLoadedSet(defaultSet);
    return defaultSet;
  }
  await migrateLegacyCommon();
  return await autoDetectLoadedSet();
}

// ── Safe icon insertion (no innerHTML) ──────────────────────
// Turn a TRUSTED, STATIC SVG-markup constant into a DOM node without innerHTML.
// Firefox AMO flags every `innerHTML =` assignment (its linter can't tell a
// hardcoded constant from a dynamic value) and a reviewer may reject over it.
// DOMParser("text/html") yields a correctly SVG-namespaced, inert node (no
// scripts run); cache per markup and hand back a fresh clone each call.
const _iconCache = new Map();
function svgIcon(markup) {
  let node = _iconCache.get(markup);
  if (!node) {
    node = new DOMParser().parseFromString(markup, "text/html").body.firstElementChild;
    _iconCache.set(markup, node);
  }
  return node.cloneNode(true);
}
export function setIcon(el, markup) { el.replaceChildren(svgIcon(markup)); }

// ---------------------------------------------------------------------------
// Favicon refresh
// ---------------------------------------------------------------------------
//
// ⚠ CLAUDE: there is NO API to refresh a bookmark's icon. Chrome keeps favicons
// in its own cache; chrome.bookmarks has no icon field, and the _favicon/
// endpoint below only READS that cache. The cache is written in exactly one
// situation — Chrome loading the page. So the only way to refresh an icon is to
// make Chrome visit the URL: open a background tab, wait for the load, close it.
// Everything here exists to do that to as few URLs as possible.

const FAVICON_CONCURRENCY = 4;      // background tabs open at once
const FAVICON_TIMEOUT_MS  = 15000;  // give up waiting on one page
const FAVICON_POLL_MS     = 300;    // how often to ask "has the icon arrived yet?"

/**
 * Every http(s) URL currently on the bookmark bar, depth-first, deduplicated.
 * Other schemes are skipped: chrome://, file:// and javascript: bookmarks either
 * refuse to open in a tab or have no favicon to fetch.
 */
export async function collectBarUrls() {
  const [tree] = await chrome.bookmarks.getSubTree(await getBookmarkBarId());
  const urls = new Set();
  const walk = (node) => {
    if (node.url) { if (/^https?:/iu.test(node.url)) urls.add(node.url); }
    else for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return [...urls];
}

// `.invalid` is reserved (RFC 2606) and never resolves, so Chrome cannot hold a
// cached icon for either of these and answers with its placeholder. TWO of them,
// not one, because the whole filter rests on an assumption that has to be TESTED
// rather than believed: that Chrome serves ONE shared default for every icon-less
// URL. If it instead draws a per-URL placeholder, these two probes disagree, no
// real bookmark can ever match a baseline, and the filter is not fixable by
// tweaking — it needs a different signal. Calibrating says which world we are in
// instead of guessing, which is what the two previous attempts did.
const NO_ICON_PROBES = ["https://no-favicon-a.invalid/", "https://no-favicon-b.invalid/"];
let _noIconHash;   // undefined = not calibrated, null = no usable baseline

async function faviconBytes(pageUrl) {
  const url = new URL(chrome.runtime.getURL("_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", "32");
  // ⚠ no-store is load-bearing: this is polled in a loop to watch for the icon
  // CHANGING, and a cached response would report the old bytes forever, so the
  // wait would always run to the timeout and the icon would look like a failure.
  const res = await fetch(url, { cache: "no-store" });
  return new Uint8Array(await res.arrayBuffer());
}

async function hashOf(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** What Chrome currently has cached for `pageUrl`: { hash, size }, or null if unreadable. */
async function faviconProbe(pageUrl) {
  try {
    const bytes = await faviconBytes(pageUrl);
    return { hash: await hashOf(bytes), size: bytes.length };
  } catch { return null; }
}

async function faviconHash(pageUrl) {
  return (await faviconProbe(pageUrl))?.hash ?? null;
}

/**
 * Fingerprint of "Chrome has no icon for this URL", or null when the cache can't
 * be read at all — Firefox has no _favicon/ endpoint and no equivalent, so there
 * the missing-only filter doesn't apply and the wait falls back to a fixed delay.
 */
/**
 * The "Chrome has no icon for this URL" fingerprint, or null when there isn't one.
 * Null means the missing-only filter cannot work and callers must refresh everything.
 */
async function noIconHash() {
  if (_noIconHash !== undefined) return _noIconHash;
  const [a, b] = await Promise.all(NO_ICON_PROBES.map(faviconProbe));
  if (!a || !b) {
    _noIconHash = null;
    console.warn("[BBS] favicon filter UNUSABLE: no readable _favicon/ endpoint (Firefox?) — refreshing every bookmark");
  } else if (a.hash !== b.hash) {
    _noIconHash = null;
    console.warn("[BBS] favicon filter UNUSABLE: Chrome returns a DIFFERENT placeholder per URL " +
                 `(${a.hash.slice(0, 12)}/${a.size}B vs ${b.hash.slice(0, 12)}/${b.size}B), ` +
                 "so \"no icon\" cannot be recognised by comparison — refreshing every bookmark");
  } else {
    _noIconHash = a.hash;
    console.log(`[BBS] favicon filter usable: shared no-icon default ${a.hash.slice(0, 12)} (${a.size}B)`);
  }
  return _noIconHash;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Open `url` in a background tab and keep it open until Chrome's cached icon
 * STOPS matching `before` — then close it. Resolves true if the icon changed.
 *
 * ⚠ CLAUDE: the stop condition is the GOAL ("did the icon arrive?"), never a
 * proxy, and that distinction is the whole fix. The first version waited for
 * tabs.onUpdated `status: "complete"` plus a fixed 600 ms and then closed the
 * tab — which refreshed roughly half a bar. A favicon is fetched at low priority
 * and, on plenty of sites, only after the document is "complete" (SPAs inject
 * their <link rel="icon"> from script), so the tab was routinely closed while
 * the icon was still in flight. Polling the cache instead means a fast site
 * finishes in ~300 ms and a slow one gets the full timeout, with no guessing.
 *
 * `before` is null only where the cache is unreadable (Firefox); there we cannot
 * observe arrival at all, so fall back to a plain wait.
 */
async function visitUntilIconArrives(url, before) {
  let tab;
  try { tab = await chrome.tabs.create({ url, active: false }); }
  catch { return false; }   // a URL Chrome refuses to open must not stall the run
  const deadline = Date.now() + FAVICON_TIMEOUT_MS;
  let changed = false;
  try {
    if (before === null) {
      await sleep(FAVICON_TIMEOUT_MS);
    } else {
      while (Date.now() < deadline) {
        await sleep(FAVICON_POLL_MS);
        const now = await faviconHash(url);
        if (now && now !== before) { changed = true; break; }
      }
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});   // already closed by the user: fine
  }
  return changed;
}

/**
 * Re-fetch the favicons of the bookmarks currently on the bar.
 *
 * `onlyMissing` (the default) first asks Chrome's cache which URLs have no icon
 * and visits just those — usually a handful instead of the whole bar. Pass false
 * to visit everything, which is what you want when a site CHANGED its icon: that
 * bookmark has a cached icon, it's simply the old one, so the filter skips it.
 *
 * ⚠ Call this from the SERVICE WORKER, never the popup — a popup's script is
 * killed the instant the popup closes, which would strand every tab it opened.
 *
 * Returns { visited, total, fixed, failed, filtered } where `failed` is the list
 * of URLs whose icon never arrived. Reporting that list is deliberate: "it only
 * worked for half of them" has to be answerable with the actual half.
 */
export async function refreshBarFavicons({ onlyMissing = true, onProgress } = {}) {
  const all = await collectBarUrls();
  onProgress?.(0, all.length);   // total known: the probe phase below is not instant
  const baseline = await noIconHash();
  const filtered = onlyMissing && baseline !== null;

  // One probe per URL up front: it is the "before" every visit watches for a
  // change against, and (when filtering) it decides who gets visited at all.
  const before = new Map();
  for (const url of all) before.set(url, baseline === null ? null : await faviconHash(url));

  // ⚠ CLAUDE: this table is the DIAGNOSTIC for the missing-only filter. Keep it.
  // The filter selected only 3 URLs on a bar with far more blank icons
  // (2026-08-05), so when it under-selects again this is what says why: per URL,
  // the cached icon's hash + byte size and whether it matched the calibrated
  // no-icon default. Diagnose from the table, never from a theory.
  if (baseline !== null) {
    const probes = await Promise.all(all.map(async url => {
      const p = await faviconProbe(url);
      return { url, hash: p?.hash?.slice(0, 12) ?? "(unreadable)", bytes: p?.size ?? 0,
               matchesNoIcon: (p?.hash ?? baseline) === baseline };
    }));
    console.log(`[BBS] favicon probe — baseline(no-icon) ${baseline.slice(0, 12)}, ${all.length} url(s), ` +
                `${probes.filter(p => p.matchesNoIcon).length} look icon-less`);
    console.table(probes);
  }

  const urls = filtered ? all.filter(u => (before.get(u) ?? baseline) === baseline) : all;

  let done = 0;
  const failed = [];
  onProgress?.(0, urls.length);
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      if (!await visitUntilIconArrives(url, before.get(url))) failed.push(url);
      onProgress?.(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FAVICON_CONCURRENCY, queue.length) }, worker));

  if (failed.length) {
    console.warn(`[BBS] ${failed.length} of ${urls.length} icon(s) never arrived:`, failed);
  }
  return { visited: urls.length, total: all.length, fixed: urls.length - failed.length, failed, filtered };
}
