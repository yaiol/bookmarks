/**
 * Bookmark Bar Switcher - background service worker
 *
 * Copy-based architecture (see ../core.js for the full rationale).
 * Background responsibilities:
 *   - Run init() on install / startup so the container and loaded-set marker
 *     are consistent with what's currently in the bar.
 *   - Handle keyboard command switching. A hotkey has no UI to ask with, so it
 *     protects the bar in the only two ways available: it auto-saves edits back
 *     into the loaded set when there IS a baseline, and when there is NONE (the
 *     bar matches no set, so nothing on it is stored anywhere) it REFUSES to
 *     switch and raises a badge, because switching would erase the only copy.
 *     The popup is where that case gets a real choice.
 */

import {
  init,
  getBarFolders,
  getLoadedSet,
  switchToBar,
  saveBarToLoadedSet,
  isBarDirty,
  isBarUnrecognised,
  refreshBarFavicons,
} from "../core.js";
import * as i18n from "../lib/i18n.js";

const DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Badge — the worker's only way to say something
// ---------------------------------------------------------------------------

/**
 * Flag a switch the hotkey refused to perform. The popup clears it on open,
 * where the same situation is explained in full and the user gets a choice.
 */
async function flagRefusedSwitch() {
  try {
    await i18n.init();   // no DOM in a worker; the loader tolerates that
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    await chrome.action.setTitle({ title: i18n.t("badgeUnknownBar") });
  } catch (e) {
    console.warn("[BBS] could not raise the badge:", e);
  }
}

// ---------------------------------------------------------------------------
// Keyboard command handling
// ---------------------------------------------------------------------------

/**
 * Switch the visible bar via keyboard command.
 * Auto-saves any pending edits back into the loaded set first.
 */
async function handleCommand(command) {
  const bars = await getBarFolders();
  if (bars.length === 0) return;

  // Resolve target
  let target;
  if (/^switch-to-\d+$/u.test(command)) {
    const index = Number(command.split("-")[2]) - 1;
    target = bars[index] ?? bars[0];
  } else {
    const loaded = await getLoadedSet();
    const currentIndex = loaded ? bars.findIndex(b => b.id === loaded.id) : -1;
    if (command === "next-bar") {
      target = bars[currentIndex + 1] ?? bars[0];
    } else if (command === "previous-bar") {
      target = bars[currentIndex - 1] ?? bars.at(-1);
    }
  }

  if (!target) return;

  // Auto-save before switching away if the bar has unsaved edits.
  if (await isBarDirty()) {
    await saveBarToLoadedSet();
  } else if (await isBarUnrecognised()) {
    // No baseline: the toolbar's contents are in no set, so there is nothing to
    // auto-save them INTO and switchToBar would erase the only copy. A hotkey
    // cannot ask, and inventing a set behind the user's back is not ours to do
    // — so refuse, and say so on the badge. Recoverable and visible; a wipe is
    // neither.
    await flagRefusedSwitch();
    return;
  }

  const loaded = await getLoadedSet();
  if (loaded && loaded.id === target.id) return; // already there

  await switchToBar(target.id);
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await fn(...args);
      timer = undefined;
    }, ms);
  };
}

const onCommand = debounce(handleCommand, DEBOUNCE_MS);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function onInstalled() {
  try {
    await init();
  } catch (e) {
    console.error("[BBS] init failed:", e);
  }
}

async function onStartup() {
  try {
    await init();
  } catch (e) {
    console.error("[BBS] init failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Favicon refresh (popup -> worker)
// ---------------------------------------------------------------------------

// ⚠ This runs HERE and not in the popup on purpose: the popup's script is killed
// the moment the popup closes, and a half-finished run would leave every tab it
// had opened behind. Progress is pushed back as a runtime message — the popup
// picks it up if it is still open, and nothing breaks if it isn't.
// Live state of a refresh run, so a popup that was closed (or never open) can
// reopen mid-run and still show where it is. The worker is the only owner; the
// popup never tracks progress itself.
let refreshState = { running: false, done: 0, total: 0 };

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});   // popup closed: expected
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "bbs:refresh-state") {
    sendResponse(refreshState);
    return undefined;
  }
  if (msg?.type !== "bbs:refresh-favicons") return undefined;
  if (refreshState.running) {
    sendResponse({ ok: false, busy: true });
    return undefined;
  }

  refreshState = { running: true, done: 0, total: 0 };
  refreshBarFavicons({
    onlyMissing: msg.onlyMissing === true,
    onProgress: (done, total) => {
      refreshState = { running: true, done, total };
      broadcast({ type: "bbs:refresh-favicons-progress", done, total });
    },
  })
    .then((result) => {
      refreshState = { running: false, done: 0, total: 0 };
      broadcast({ type: "bbs:refresh-favicons-done", ...result });
      sendResponse({ ok: true, ...result });
    })
    .catch((e) => {
      refreshState = { running: false, done: 0, total: 0 };
      broadcast({ type: "bbs:refresh-favicons-done", ok: false });
      sendResponse({ ok: false, error: String(e) });
    });
  return true;   // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(onInstalled);
chrome.runtime.onStartup.addListener(onStartup);
chrome.commands.onCommand.addListener(onCommand);
