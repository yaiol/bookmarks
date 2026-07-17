/**
 * Bookmark Bar Switcher - background service worker
 *
 * Copy-based architecture (see ../core.js for the full rationale).
 * Background responsibilities:
 *   - Run init() on install / startup so the container and loaded-set marker
 *     are consistent with what's currently in the bar.
 *   - Handle keyboard command switching. Keyboard switches auto-save the bar
 *     back into the currently loaded set first, so a hotkey press can never
 *     silently lose unsaved edits. The popup has the explicit save prompt.
 */

import {
  init,
  getBarFolders,
  getLoadedSet,
  switchToBar,
  saveBarToLoadedSet,
  isBarDirty,
} from "../core.js";

const DEBOUNCE_MS = 100;

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

  // Auto-save before switching away if the bar has unsaved edits
  if (await isBarDirty()) {
    await saveBarToLoadedSet();
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

chrome.runtime.onInstalled.addListener(onInstalled);
chrome.runtime.onStartup.addListener(onStartup);
chrome.commands.onCommand.addListener(onCommand);
