// Bookmark Bar Switcher - runtime i18n loader (ES module).
//
// Why a custom layer instead of chrome.i18n.getMessage()?
//   chrome.i18n.getMessage() is hard-bound to the browser's UI language -
//   Chrome offers no API to override it at runtime. We want users to pick
//   the extension language independently (the Settings → Language picker),
//   so this loader fetches the selected _locales/<lang>/messages.json
//   directly and exposes t() / applyDom().
//
// The manifest name stays a literal ("Bookmark Bar Switcher" - a brand mark,
// not translated). Only `__MSG_*__` keys (store description, command
// descriptions) stay resolved by Chrome against the browser language.

// Folder names match Chrome's locale convention (underscore, region capitals).
export const SUPPORTED = [
  "ar", "cs", "da", "de", "en", "es", "fi", "fr", "hi", "hu", "id", "it",
  "ja", "ko", "nb", "nl", "pl", "pt_BR", "pt_PT", "ru", "sv", "th", "tr",
  "uk", "vi", "zh_CN", "zh_TW",
];

// Native names - shown in the language picker so a user who can't read the
// current UI can still find their language.
export const NAMES = {
  ar:    "العربية",
  cs:    "Čeština",
  da:    "Dansk",
  de:    "Deutsch",
  en:    "English",
  es:    "Español",
  fi:    "Suomi",
  fr:    "Français",
  hi:    "हिन्दी",
  hu:    "Magyar",
  id:    "Indonesia",
  it:    "Italiano",
  ja:    "日本語",
  ko:    "한국어",
  nb:    "Norsk",
  nl:    "Nederlands",
  pl:    "Polski",
  pt_BR: "Português (BR)",
  pt_PT: "Português (PT)",
  ru:    "Русский",
  sv:    "Svenska",
  th:    "ไทย",
  tr:    "Türkçe",
  uk:    "Українська",
  vi:    "Tiếng Việt",
  zh_CN: "简体中文",
  zh_TW: "繁體中文",
};

export const STORAGE_KEY = "bbs_lang"; // value: "auto" or a code from SUPPORTED

// Languages whose script is written right-to-left. Short on purpose - only
// those we ship. Extend if a new RTL locale is added.
const RTL = new Set(["ar", "he", "fa", "ur"]);

let cache = {};
let currentLang = "en";

function normalize(code) {
  if (!code) return null;
  const c = String(code).replace("-", "_");
  if (SUPPORTED.includes(c)) return c;
  const base = c.split("_")[0];
  return SUPPORTED.find(s => s === base || s.startsWith(base + "_")) || null;
}

function detectAuto() {
  try { return normalize(chrome.i18n.getUILanguage()) || "en"; }
  catch { return "en"; }
}

export function getStored() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([STORAGE_KEY], r => resolve(r?.[STORAGE_KEY] || "auto"));
    } catch { resolve("auto"); }
  });
}

export function setLang(value) {
  return new Promise(resolve => {
    try { chrome.storage.local.set({ [STORAGE_KEY]: value }, () => resolve()); }
    catch { resolve(); }
  });
}

async function loadMessages(lang) {
  const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
  const res = await fetch(url);
  if (!res.ok) throw new Error("messages.json fetch failed: " + lang);
  return res.json();
}

function applyDir(lang) {
  try {
    document.documentElement.setAttribute("dir", RTL.has(lang) ? "rtl" : "ltr");
    document.documentElement.setAttribute("lang", lang.replace("_", "-"));
  } catch {}
}

export async function init() {
  const stored = await getStored();
  const lang = stored === "auto" ? detectAuto() : (normalize(stored) || "en");
  try {
    cache = await loadMessages(lang);
    currentLang = lang;
  } catch {
    // Fall back to EN - the English file is always present.
    cache = await loadMessages("en");
    currentLang = "en";
  }
  applyDir(currentLang);
  return currentLang;
}

export function t(key, params) {
  let msg = cache[key]?.message ?? key;
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.split("{" + k + "}").join(String(v));
    }
  }
  return msg;
}

// Apply translations to elements declaratively:
//   <h2 data-i18n="optionsBarsHeading"></h2>          → textContent
//   <button data-i18n-title="tooltipSettings">        → title + aria-label
//   <input data-i18n-placeholder="optionsNewBar">     → placeholder
export function applyDom(root) {
  const r = root || document;
  for (const el of r.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of r.querySelectorAll("[data-i18n-title]")) {
    const v = t(el.dataset.i18nTitle);
    el.title = v;
    el.setAttribute("aria-label", v);
  }
  for (const el of r.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

export function getLang() { return currentLang; }
