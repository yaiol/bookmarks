/**
 * Bookmark Bar Switcher - Settings page
 *
 * Hosts all configuration that is rare relative to switching:
 *   - drag-reorder of bars
 *   - rename / delete
 *   - mark / unmark a bar as common
 *   - per-bar ordered common-picker (for non-common bars)
 *   - import / export
 *
 * When a change would affect the currently-loaded merge, the page checks
 * isBarDirty() and either re-merges immediately (clean) or prompts the user
 * to save / discard / cancel (dirty), reusing the existing dirty-switch
 * machinery.
 */

import {
  getBarState,
  getLoadedSet,
  isBarDirty,
  switchToBar,
  createBar,
  renameBar,
  removeBar,
  reorderBar,
  saveBarToLoadedSet,
  getCommonBarIds,
  setCommonFlag,
  getBarCommons,
  setBarCommons,
  addCommonToAllBars,
  removeCommonFromAllBars,
  exportSingleSet,
  importSetsAsNewBars,
} from "../core.js";
import * as i18n from "../lib/i18n.js";

// ---------------------------------------------------------------------------
// Icons (Lucide-style monochrome SVGs, render in currentColor)
// ---------------------------------------------------------------------------

const SVG_ATTRS = `width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
const ICON_TRASH        = `<svg data-icon="lucide:trash-2" ${SVG_ATTRS}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
const ICON_COMMON_OUTLINE = `<svg ${SVG_ATTRS}><rect x="4" y="4" width="12" height="12"/><path d="M16 8 H20 V20 H8 V16 H16"/></svg>`;
const ICON_COMMON_FILLED  = `<svg ${SVG_ATTRS} fill="currentColor"><rect x="4" y="4" width="12" height="12"/><path d="M16 8 H20 V20 H8 V16 H16 Z"/></svg>`;
const ICON_UPLOAD       = `<svg data-icon="lucide:upload" ${SVG_ATTRS}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const ICON_PLUS         = `<svg data-icon="lucide:plus" ${SVG_ATTRS}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_MINUS        = `<svg data-icon="lucide:minus" ${SVG_ATTRS}><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let bars = [];
let loadedSetId = null;
let commonBarIds = new Set();
let barCommonsByBar = new Map(); // barId → ordered string[]

// Drag tracking
let dragBarFrom = null;
let dragBarTo = null;
const barPlaceholder = document.createElement("div");
barPlaceholder.className = "bar-card-placeholder";

// Pending re-merge after a config change
let pendingRemerge = null; // function | null
let pendingRemergeMsg = null;

// Delete confirmation
let removeCandidate = null;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const barList = document.getElementById("bar-list");
const createInput = document.getElementById("create-input");
const createBtn = document.getElementById("create-btn");

const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");

const deleteModal = document.getElementById("delete-modal");
const deleteCancel = document.getElementById("delete-cancel");
const deleteConfirm = document.getElementById("delete-confirm");

const dirtyModal = document.getElementById("dirty-modal");
const dirtyMessage = document.getElementById("dirty-message");
const dirtyCancel = document.getElementById("dirty-cancel");
const dirtyDiscard = document.getElementById("dirty-discard");
const dirtySave = document.getElementById("dirty-save");

// ---------------------------------------------------------------------------
// Re-merge helper: call after any change that may have invalidated the live
// bar's merge. If clean → switch to loaded again to re-merge. If dirty →
// prompt the user via the dirty modal.
// ---------------------------------------------------------------------------

async function maybeRemergeAffected(affectedBarIds) {
  const loaded = await getLoadedSet();
  if (!loaded) return;
  // Affected if loaded itself changed, or one of its selected commons changed,
  // or the set of common bars (which may demote a previously-used common) changed.
  const loadedSelection = await getBarCommons(loaded.id);
  const affectsLoaded =
    affectedBarIds.includes(loaded.id) ||
    affectedBarIds.some(id => loadedSelection.includes(id)) ||
    affectedBarIds.some(id => commonBarIds.has(id));
  if (!affectsLoaded) return;

  if (await isBarDirty()) {
    pendingRemerge = () => switchToBar(loaded.id);
    pendingRemergeMsg = i18n.t("optionsRemergeDirty", { title: loaded.title });
    dirtyMessage.textContent = pendingRemergeMsg;
    dirtyModal.classList.remove("hidden");
  } else {
    await switchToBar(loaded.id);
  }
}

dirtyCancel.addEventListener("click", () => {
  pendingRemerge = null;
  dirtyModal.classList.add("hidden");
});
dirtyDiscard.addEventListener("click", async () => {
  dirtyModal.classList.add("hidden");
  if (pendingRemerge) {
    await pendingRemerge();
    pendingRemerge = null;
  }
  await refresh();
});
dirtySave.addEventListener("click", async () => {
  dirtyModal.classList.add("hidden");
  await saveBarToLoadedSet();
  if (pendingRemerge) {
    await pendingRemerge();
    pendingRemerge = null;
  }
  await refresh();
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  barList.innerHTML = "";
  bars.forEach((bar, index) => {
    barList.appendChild(renderBarCard(bar, index));
  });
}

function renderBarCard(bar, index) {
  const card = document.createElement("div");
  card.className = "bar-card" + (commonBarIds.has(bar.id) ? " common" : "");
  card.dataset.id = bar.id;
  card.dataset.index = index;
  card.draggable = true;

  // Drag for bar reorder
  card.addEventListener("dragstart", (e) => {
    dragBarFrom = index;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "bar");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    dragBarFrom = null;
    clearBarPlaceholder();
  });
  card.addEventListener("dragover", (e) => {
    if (dragBarFrom === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = card.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    const insertIdx = after ? index + 1 : index;
    if (dragBarTo === insertIdx) return;
    dragBarTo = insertIdx;
    if (after) card.after(barPlaceholder);
    else card.before(barPlaceholder);
  });

  // Header row
  const head = document.createElement("div");
  head.className = "bar-head";

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.setAttribute("aria-hidden", "true");
  grip.textContent = "⋮⋮";
  grip.title = i18n.t("optionsGripTitle");
  head.appendChild(grip);

  const nameInput = document.createElement("input");
  nameInput.className = "bar-name-input";
  nameInput.type = "text";
  nameInput.value = bar.title;
  nameInput.spellcheck = false;
  let renameTimer = null;
  const commitRename = async () => {
    const next = nameInput.value.trim();
    if (!next || next === bar.title) {
      nameInput.value = bar.title;
      return;
    }
    await renameBar(bar.id, next);
    await refresh();
  };
  nameInput.addEventListener("blur", commitRename);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
    if (e.key === "Escape") {
      nameInput.value = bar.title;
      nameInput.blur();
    }
  });
  head.appendChild(nameInput);

  if (bar.id === loadedSetId) {
    const tag = document.createElement("span");
    tag.className = "bar-loaded-tag";
    tag.textContent = i18n.t("optionsLoadedTag");
    head.appendChild(tag);
  }

  const isCommon = commonBarIds.has(bar.id);
  const commonBtn = document.createElement("button");
  commonBtn.className = "ya-btn ya-btn-secondary ya-btn-icon btn-common" + (isCommon ? " active" : "");
  commonBtn.innerHTML = isCommon ? ICON_COMMON_FILLED : ICON_COMMON_OUTLINE;
  commonBtn.title = isCommon
    ? i18n.t("optionsCommonUnset")
    : i18n.t("optionsCommonSet");
  commonBtn.addEventListener("click", async () => {
    await setCommonFlag(bar.id, !isCommon);
    await maybeRemergeAffected([bar.id]);
    await refresh();
  });
  head.appendChild(commonBtn);

  if (isCommon) {
    const addAllBtn = document.createElement("button");
    addAllBtn.className = "ya-btn ya-btn-secondary ya-btn-icon";
    addAllBtn.innerHTML = ICON_PLUS;
    addAllBtn.title = i18n.t("optionsAddToAll");
    addAllBtn.addEventListener("click", async () => {
      addAllBtn.disabled = true;
      const changed = await addCommonToAllBars(bar.id);
      if (changed.length > 0) await maybeRemergeAffected(changed);
      await refresh();
    });
    head.appendChild(addAllBtn);

    const removeAllBtn = document.createElement("button");
    removeAllBtn.className = "ya-btn ya-btn-secondary ya-btn-icon";
    removeAllBtn.innerHTML = ICON_MINUS;
    removeAllBtn.title = i18n.t("optionsRemoveFromAll");
    removeAllBtn.addEventListener("click", async () => {
      removeAllBtn.disabled = true;
      const changed = await removeCommonFromAllBars(bar.id);
      if (changed.length > 0) await maybeRemergeAffected(changed);
      await refresh();
    });
    head.appendChild(removeAllBtn);
  }

  const exportOneBtn = document.createElement("button");
  exportOneBtn.className = "ya-btn ya-btn-secondary ya-btn-icon";
  exportOneBtn.innerHTML = ICON_UPLOAD;
  exportOneBtn.title = i18n.t("optionsExportOne");
  exportOneBtn.addEventListener("click", async () => {
    try {
      const data = await exportSingleSet(bar.id);
      const date = new Date().toISOString().slice(0, 10);
      const safe = bar.title.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "bar";
      downloadJson(data, `bookmark-bar-${safe}-${date}.json`);
    } catch (e) {
      console.error("[BBS] single-bar export failed:", e);
      alert(i18n.t("optionsExportFailed") + e.message);
    }
  });
  head.appendChild(exportOneBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "ya-btn ya-btn-danger ya-btn-icon";
  delBtn.innerHTML = ICON_TRASH;
  delBtn.title = i18n.t("optionsDeleteBar");
  if (bars.length <= 1) {
    delBtn.disabled = true;
    delBtn.title = i18n.t("optionsCannotDeleteLast");
  }
  delBtn.addEventListener("click", () => {
    removeCandidate = bar;
    deleteModal.classList.remove("hidden");
  });
  head.appendChild(delBtn);

  card.appendChild(head);

  // Per-bar commons picker (only for non-common bars)
  card.appendChild(renderCommonsPicker(bar));

  return card;
}

function renderCommonsPicker(bar) {
  const wrap = document.createElement("div");
  wrap.className = "commons-picker";

  if (commonBarIds.has(bar.id)) return wrap;

  const allCommonIds = [...commonBarIds].filter(id => id !== bar.id);
  if (allCommonIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "commons-empty";
    empty.textContent = i18n.t("optionsNoCommons");
    wrap.appendChild(empty);
    return wrap;
  }

  const label = document.createElement("div");
  label.className = "commons-label";
  label.textContent = i18n.t("optionsCommonsLabel");
  wrap.appendChild(label);

  const selected = barCommonsByBar.get(bar.id) || [];
  const list = document.createElement("div");
  list.className = "commons-list";

  // Drop placeholder for common picker (per-card)
  const pickPlaceholder = document.createElement("div");
  pickPlaceholder.className = "common-pick-placeholder";
  let dragPickFrom = null;
  let dragPickTo = null;

  const clearPickPlaceholder = () => {
    pickPlaceholder.parentNode?.removeChild(pickPlaceholder);
    dragPickTo = null;
  };

  selected.forEach((commonId, idx) => {
    const commonBar = bars.find(b => b.id === commonId);
    if (!commonBar) return;
    const row = document.createElement("div");
    row.className = "common-pick";
    row.draggable = true;
    row.dataset.idx = idx;

    row.addEventListener("dragstart", (e) => {
      dragPickFrom = idx;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "pick");
      e.stopPropagation();
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragPickFrom = null;
      clearPickPlaceholder();
    });
    row.addEventListener("dragover", (e) => {
      if (dragPickFrom === null) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      const insertIdx = after ? idx + 1 : idx;
      if (dragPickTo === insertIdx) return;
      dragPickTo = insertIdx;
      if (after) row.after(pickPlaceholder);
      else row.before(pickPlaceholder);
    });

    const g = document.createElement("span");
    g.className = "grip";
    g.textContent = "⋮⋮";
    row.appendChild(g);

    const name = document.createElement("span");
    name.className = "common-name";
    name.textContent = commonBar.title;
    row.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "remove-btn";
    rm.textContent = "✕";
    rm.title = i18n.t("optionsRemoveFromBar");
    rm.addEventListener("click", async () => {
      const next = selected.filter((_, i) => i !== idx);
      await setBarCommons(bar.id, next);
      await maybeRemergeAffected([bar.id]);
      await refresh();
    });
    row.appendChild(rm);

    list.appendChild(row);
  });

  list.addEventListener("dragover", (e) => {
    if (dragPickFrom !== null) e.preventDefault();
  });
  list.addEventListener("drop", async (e) => {
    if (dragPickFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    const src = dragPickFrom;
    const target = dragPickTo;
    clearPickPlaceholder();
    if (src === null || target === null) return;
    let newIdx = target;
    if (src < newIdx) newIdx -= 1;
    if (newIdx === src) return;
    const next = [...selected];
    const [moved] = next.splice(src, 1);
    next.splice(newIdx, 0, moved);
    await setBarCommons(bar.id, next);
    await maybeRemergeAffected([bar.id]);
    await refresh();
  });

  wrap.appendChild(list);

  // Add-common row
  const unused = allCommonIds.filter(id => !selected.includes(id));
  if (unused.length > 0) {
    const adder = document.createElement("div");
    adder.className = "add-common";
    const sel = document.createElement("select");
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = i18n.t("optionsAddCommonOption");
    sel.appendChild(placeholderOpt);
    for (const id of unused) {
      const b = bars.find(x => x.id === id);
      if (!b) continue;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = b.title;
      sel.appendChild(opt);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "ya-btn ya-btn-secondary";
    addBtn.textContent = i18n.t("optionsAddCommonBtn");
    addBtn.addEventListener("click", async () => {
      const id = sel.value;
      if (!id) return;
      const next = [...selected, id];
      await setBarCommons(bar.id, next);
      await maybeRemergeAffected([bar.id]);
      await refresh();
    });
    adder.appendChild(sel);
    adder.appendChild(addBtn);
    wrap.appendChild(adder);
  }

  return wrap;
}

function clearBarPlaceholder() {
  barPlaceholder.parentNode?.removeChild(barPlaceholder);
  dragBarTo = null;
}

// Bar-list drop handling
barList.addEventListener("dragover", (e) => {
  if (dragBarFrom !== null) e.preventDefault();
});
barList.addEventListener("drop", async (e) => {
  if (dragBarFrom === null) return;
  e.preventDefault();
  const src = dragBarFrom;
  const target = dragBarTo;
  clearBarPlaceholder();
  if (src === null || target === null) return;
  let newIndex = target;
  if (src < newIndex) newIndex -= 1;
  if (newIndex === src) return;
  await reorderBar(bars[src].id, newIndex);
  await refresh();
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refresh() {
  const state = await getBarState();
  bars = state.bars;
  loadedSetId = state.loaded?.id ?? null;
  commonBarIds = new Set(state.commonBarIds || []);
  // Load each bar's selection in parallel
  barCommonsByBar = new Map();
  await Promise.all(bars.map(async (b) => {
    barCommonsByBar.set(b.id, await getBarCommons(b.id));
  }));
  render();
}

// ---------------------------------------------------------------------------
// Create / delete
// ---------------------------------------------------------------------------

async function handleCreate() {
  const name = createInput.value.trim();
  if (!name) return;
  await createBar(name);
  createInput.value = "";
  await refresh();
}

createBtn.addEventListener("click", handleCreate);
createInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleCreate();
});

deleteCancel.addEventListener("click", () => {
  removeCandidate = null;
  deleteModal.classList.add("hidden");
});
deleteConfirm.addEventListener("click", async () => {
  if (!removeCandidate) return;
  deleteModal.classList.add("hidden");
  const removedId = removeCandidate.id;
  await removeBar(removedId);
  removeCandidate = null;
  await maybeRemergeAffected([removedId]);
  await refresh();
});

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

function downloadJson(data, filename) {
  // Escape every non-ASCII codepoint as \uXXXX so the file is byte-identical
  // under UTF-8, Latin-1, or cp1252 - survives a round-trip through any
  // editor that might re-save it with the system codepage.
  const json = JSON.stringify(data, null, 2).replace(
    /[-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readJsonFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sets)) {
    throw new Error(i18n.t("errorMissingSets"));
  }
  return data;
}

// Import always ADDS: every bar in the file becomes a new "<name> (<date>)"
// bar beside the existing ones - it never replaces or wipes a bar, so a backup
// can be inspected before the original is deleted, and nothing is lost by
// mistake. The visible bar and the loaded set are left untouched.
importBtn.addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    if (data.sets.length === 0) throw new Error(i18n.t("errorNoBars"));
    await importSetsAsNewBars(data);
    await refresh();
  } catch (e) {
    console.error("[BBS] import failed:", e);
    alert(i18n.t("optionsImportFailed") + e.message);
  }
});

// React to background changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.loadedSet || changes.commonBars || changes.barCommons)) {
    refresh();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const manifest = chrome.runtime.getManifest();

function applyChrome() {
  const nameEl = document.getElementById("app-name");
  if (nameEl) nameEl.textContent = manifest.name;
  document.title = `${manifest.name} ${i18n.t("optionsHeaderSuffix")}`;
  document.getElementById("app-version").textContent = `v${manifest.version}`;

  // Help → the selected extension language. The help site falls back to EN
  // for languages it doesn't publish, so any code is safe to send.
  const helpLink = document.getElementById("help-link");
  if (helpLink) {
    const base = "https://apps.yaiol.com/en/p/bookmarks/help/";
    const lang = (i18n.getLang() || "en").replace(/_/g, "-"); // full BCP47 tag, hyphen form; nginx falls back region→base→en
    helpLink.href = lang && lang !== "en" ? base.replace("/en/p/", `/${lang}/p/`) : base;
  }
}

// ---------------------------------------------------------------------------
// Language picker
// ---------------------------------------------------------------------------

async function setupLanguagePicker() {
  const sel = document.getElementById("lang-select");
  if (!sel) return;
  sel.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = i18n.t("optionsLanguageAuto");
  sel.appendChild(auto);

  for (const code of i18n.SUPPORTED) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = i18n.NAMES[code] || code;
    sel.appendChild(opt);
  }

  // Show the user's stored choice (e.g. "auto"), not the resolved language.
  const stored = await i18n.getStored();
  sel.value = i18n.SUPPORTED.includes(stored) || stored === "auto" ? stored : "auto";

  sel.addEventListener("change", async () => {
    await i18n.setLang(sel.value);
    // Re-init this page in the new language so every translated string and
    // the auto-label refresh without a manual reload.
    await i18n.init();
    i18n.applyDom();
    auto.textContent = i18n.t("optionsLanguageAuto");
    applyChrome();
    await refresh();
  });
}

(async () => {
  await i18n.init();
  i18n.applyDom();
  applyChrome();
  await setupLanguagePicker();
  await refresh();
})();
