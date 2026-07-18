/**
 * Bookmark Bar Switcher - Popup (switcher only)
 *
 * The popup is purely the fast-switch surface:
 *   - list of bars
 *   - click a row to switch (with dirty prompt if needed)
 *   - dirty indicator + save-in-place button on the loaded row
 *   - gear icon in the footer opens the settings page
 *
 * All configuration (rename, delete, common flag, per-bar common selection,
 * import/export, drag-reorder) lives on the settings page.
 */

import {
  getBarState,
  getLoadedSet,
  switchToBar,
  saveBarToLoadedSet,
  setIcon,
} from "../core.js";
import * as i18n from "../lib/i18n.js";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const SVG_ATTRS = `width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
const ICON_SAVE         = `<svg data-icon="lucide:save" ${SVG_ATTRS}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
const ICON_COMMON_FILLED = `<svg ${SVG_ATTRS} fill="currentColor"><rect x="4" y="4" width="12" height="12"/><path d="M16 8 H20 V20 H8 V16 H16 Z"/></svg>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PREF_SHOW_COMMONS = "showCommonsInPopup";

let bars = [];
let loadedSetId = null;
let commonBarIds = new Set();
let dirty = false;
let showCommons = false;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const barList = document.getElementById("bar-list");
const settingsBtn = document.getElementById("settings-btn");
const showCommonsCb = document.getElementById("show-commons-cb");

const dirtyModal = document.getElementById("dirty-modal");
const dirtyMessage = document.getElementById("dirty-message");
const dirtyCancel = document.getElementById("dirty-cancel");
const dirtyDiscard = document.getElementById("dirty-discard");
const dirtySave = document.getElementById("dirty-save");

// ---------------------------------------------------------------------------
// Dirty-switch prompt
// ---------------------------------------------------------------------------

let pendingDirtyChoice = null;

function promptDirty(loadedTitle, targetTitle) {
  dirtyMessage.textContent = targetTitle
    ? i18n.t("popupDirtySwitch", { loaded: loadedTitle, target: targetTitle })
    : i18n.t("popupDirtySave", { loaded: loadedTitle });
  dirtyModal.classList.remove("hidden");
  return new Promise((resolve) => {
    pendingDirtyChoice = resolve;
  });
}

function resolveDirty(choice) {
  dirtyModal.classList.add("hidden");
  if (pendingDirtyChoice) {
    const resolve = pendingDirtyChoice;
    pendingDirtyChoice = null;
    resolve(choice);
  }
}

dirtyCancel.addEventListener("click", () => resolveDirty("cancel"));
dirtyDiscard.addEventListener("click", () => resolveDirty("discard"));
dirtySave.addEventListener("click", () => resolveDirty("save"));

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  barList.replaceChildren();
  const visibleBars = bars.filter(b => showCommons || !commonBarIds.has(b.id));

  visibleBars.forEach((bar) => {
    const row = document.createElement("div");
    row.className = "bar-row";

    const isLoaded = bar.id === loadedSetId;
    const isCommon = commonBarIds.has(bar.id);
    const showDirty = isLoaded && dirty;

    const nameBtn = document.createElement("button");
    nameBtn.className = "bar-name" + (isLoaded ? " active" : "") + (isCommon ? " common" : "");
    nameBtn.title = isLoaded ? i18n.t("popupRowLoaded") : i18n.t("popupRowSwitch");

    if (showDirty) {
      const dot = document.createElement("span");
      dot.className = "dirty-dot";
      dot.textContent = "●";
      dot.title = i18n.t("popupUnsavedChanges");
      nameBtn.appendChild(dot);
    }
    if (isCommon) {
      const star = document.createElement("span");
      star.className = "common-star";
      setIcon(star, ICON_COMMON_FILLED);
      star.title = i18n.t("popupCommonBar");
      nameBtn.appendChild(star);
    }
    nameBtn.appendChild(document.createTextNode(bar.title));

    nameBtn.addEventListener("click", async () => {
      if (bar.id === loadedSetId) return;
      nameBtn.disabled = true;
      await handleSwitch(bar);
    });

    row.appendChild(nameBtn);

    // Save-in-place button - only on the loaded row when dirty
    if (showDirty) {
      const saveBtn = document.createElement("button");
      saveBtn.className = "ya-btn ya-btn-primary ya-btn-icon";
      setIcon(saveBtn, ICON_SAVE);
      saveBtn.title = i18n.t("popupSaveInPlace");
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        await saveBarToLoadedSet();
        await refresh();
      });
      row.appendChild(saveBtn);
    }

    barList.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Switch flow with dirty prompt
// ---------------------------------------------------------------------------

async function handleSwitch(target) {
  const loaded = await getLoadedSet();
  if (loaded && dirty) {
    const choice = await promptDirty(loaded.title, target.title);
    if (choice === "cancel") {
      await refresh();
      return;
    }
    if (choice === "save") {
      await saveBarToLoadedSet();
    }
  }
  await switchToBar(target.id);
  await refresh();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refresh() {
  const state = await getBarState();
  bars = state.bars;
  loadedSetId = state.loaded?.id ?? null;
  commonBarIds = new Set(state.commonBarIds || []);
  dirty = state.dirty;
  const pref = await chrome.storage.local.get(PREF_SHOW_COMMONS);
  showCommons = !!pref[PREF_SHOW_COMMONS];
  showCommonsCb.checked = showCommons;
  render();
}

showCommonsCb.addEventListener("change", async () => {
  showCommons = showCommonsCb.checked;
  await chrome.storage.local.set({ [PREF_SHOW_COMMONS]: showCommons });
  render();
});

// ---------------------------------------------------------------------------
// Settings link
// ---------------------------------------------------------------------------

settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("options/index.html"));
  }
});

// React to background changes (hotkey switch, settings page changes)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.loadedSet || changes.commonBars || changes.barCommons)) {
    refresh();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

{
  const manifest = chrome.runtime.getManifest();
  const nameEl = document.getElementById("app-name");
  if (nameEl) nameEl.textContent = manifest.name;
  document.title = manifest.name;
  document.getElementById("app-version").textContent = `v${manifest.version}`;
}

// Load translations, apply declarative data-i18n bindings, then render.
(async () => {
  await i18n.init();
  i18n.applyDom();

  // Help → the selected extension language. The help site falls back to EN
  // for languages it doesn't publish, so any code is safe to send.
  const helpLink = document.getElementById("help-link");
  if (helpLink) {
    const lang = (i18n.getLang() || "en").replace(/_/g, "-"); // full BCP47 tag, hyphen form; nginx falls back region→base→en
    if (lang && lang !== "en") helpLink.href = helpLink.href.replace("/en/p/", `/${lang}/p/`);
  }

  await refresh();
})();
