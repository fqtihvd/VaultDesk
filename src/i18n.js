'use strict';

/* Dil motoru. Ceviriler locales/<kod>.json dosyalaridir (her dilde ayni anahtarlar,
 * ayni {yer_tutucu} bicimi). Eksik anahtar once Ingilizceye, sonra anahtarin kendisine duser. */

const LANGUAGES = [
  ['en', 'English'], ['tr', 'Türkçe'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'],
  ['pt_br', 'Português (Brasil)'], ['ru', 'Русский'], ['ja', '日本語'], ['zh_cn', '中文（简体）'],
];
const DEFAULT_LANG = 'en';

const i18n = { lang: DEFAULT_LANG, strings: {}, fallback: {} };

async function fetchLocale(code) {
  try {
    const res = await fetch(`locales/${code}.json`);
    return await res.json();
  } catch {
    return {};
  }
}

async function setLanguage(code) {
  if (!LANGUAGES.some(([c]) => c === code)) code = DEFAULT_LANG;
  if (!Object.keys(i18n.fallback).length) i18n.fallback = await fetchLocale(DEFAULT_LANG);
  i18n.strings = code === DEFAULT_LANG ? i18n.fallback : await fetchLocale(code);
  i18n.lang = code;
  document.documentElement.lang = code.replace('_', '-');
}

function t(key, params) {
  let s = i18n.strings[key];
  if (s === undefined) s = i18n.fallback[key];
  if (s === undefined) s = key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}

/**
 * Sayiya gore cogul bicim (Intl.PluralRules): once "<taban>_<one|few|many|other>" anahtari aranir
 * (or. Rusca: 1 запись / 2 записи / 5 записей), yoksa eski "<taban>_one" / "<taban>_count" ciftine duser.
 */
function tPlural(base, n, params = {}) {
  let cat = 'other';
  try { cat = new Intl.PluralRules(i18n.lang.replace('_', '-')).select(n); } catch {}
  const key = `${base}_${cat}`;
  const vars = { count: n, ...params };
  if (key in i18n.strings) return t(key, vars);
  return t(n === 1 ? `${base}_one` : `${base}_count`, vars);
}

function applyStaticTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}
