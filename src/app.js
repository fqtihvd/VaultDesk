'use strict';

/* =====================================================================
 * VaultDesk Pro — renderer.
 * Sifreleme ve dosya islemleri ana surectedir (main.js); burasi yalnizca
 * cozulmus kasa verisini (state.data) gosterir ve her degisiklikte
 * window.vd.save() ile ana surece gonderir.
 * Veri yapisi (tum VaultDesk surumlerinde ayni):
 *   { categories: [{id, name, color, icon}], entries: { <catId>: [{id, site, kullanici, eposta, sifre, ek_bilgi}] } }
 * ===================================================================== */

// `vd` = preload'un contextBridge ile verdigi API (global; yeniden bildirilmemeli).
const THEMES = [
  { id: 'light', icon: '☀️' },
  { id: 'dark', icon: '🌙' },
  { id: 'violet', icon: '✦' },
];
const PALETTE = ['#5B8CFF', '#8B5CF6', '#EC4899', '#F0576B', '#F97316', '#F59E0B', '#22C55E', '#14B8A6', '#06B6D4', '#64748B'];
const DEFAULT_CATEGORIES = [
  { id: 'sosyal_medya', key: 'default_cat_social', color: '#3B6EF6', icon: '📱' },
  { id: 'karisik', key: 'default_cat_misc', color: '#8B5CF6', icon: '🌐' },
  { id: 'gamedesign', key: 'default_cat_gamedesign', color: '#F0576B', icon: '🎮' },
  { id: 'yapay_zeka', key: 'default_cat_ai', color: '#22C55E', icon: '🤖' },
  { id: 'yemek_alisveris', key: 'default_cat_shopping', color: '#F59E0B', icon: '🛒' },
];
const IMPORT_SOURCES = [
  ['chrome', 'import_source_chrome'], ['bitwarden', 'import_source_bitwarden'],
  ['1password', 'import_source_1password'], ['generic', 'import_source_generic'],
];
const PALETTE_MAX = 120;

const state = {
  settings: {},
  autolockChoices: [1, 5, 15, 30, 0],
  vaultExists: false,
  legacyVault: null,
  licenseRequired: false,
  data: null,
  view: { name: 'home' },
  query: '',
  openIds: new Set(),
  pwVisible: new Set(),
  copiedId: null,
};

// ---------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#5B8CFF');
const newId = () => crypto.randomUUID().replace(/-/g, '');
const recCount = (n) => tPlural('records', n);
const fold = (s) => String(s || '').toLocaleLowerCase();
function debounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
function showScreen(id) {
  for (const s of ['screen-license', 'screen-auth', 'screen-main']) $('#' + s).classList.toggle('hidden', s !== id);
}
const persist = () => vd.save(state.data);

// ---------------------------------------------------------------------
// Kayit ikonlari: kullanicinin sectigi emoji > site ikonu (favicon) > renkli bas harf.
// Ikonlar ana surecten gelir (arayuz internete cikmaz); burada yalnizca bellekte tutulur ve
// kilitlenince silinir. Ikon geldiginde ilgili ogeler yerinde guncellenir (listenin tamami cizilmez).
// ---------------------------------------------------------------------
const icons = new Map(); // alan adi -> data URL | null (ikon yok)
const iconWanted = new Set();
let iconFlush = null;
const DATA_IMAGE_RE = /^data:image\/(png|x-icon|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const iconsEnabled = () => state.settings.fetch_icons !== false;
const initialOf = (text) => esc(String(text || '').trim().charAt(0).toLocaleUpperCase() || '•');

/** cls: "avatar" (kayit) ya da "cmdk-item-icon" (palet); fallbackHtml: ikon yokken gosterilecek icerik. */
function entryIconHtml(entry, cls, fallbackHtml, style = '') {
  const st = style ? ` style="${style}"` : '';
  if (entry.icon) return `<div class="${cls} icon-emoji"${st}>${esc(entry.icon)}</div>`;
  const d = iconsEnabled() ? VaultDeskDomain.domainForEntry(entry) : null;
  if (d) {
    const data = icons.get(d);
    if (data) return `<div class="${cls} has-icon" data-domain="${esc(d)}"${st}><img src="${data}" alt="" draggable="false" /></div>`;
    if (data === undefined) wantIcon(d);
    return `<div class="${cls}" data-domain="${esc(d)}"${st}>${fallbackHtml}</div>`;
  }
  return `<div class="${cls}"${st}>${fallbackHtml}</div>`;
}

function wantIcon(d) {
  iconWanted.add(d);
  if (!iconFlush) iconFlush = setTimeout(flushIconRequests, 0);
}

async function flushIconRequests() {
  iconFlush = null;
  const list = [...iconWanted];
  iconWanted.clear();
  if (!list.length || !state.data) return;
  applyIcons((await vd.getIcons(list)) || {});
}

function applyIcons(map) {
  if (!state.data) return;
  for (const [d, raw] of Object.entries(map)) {
    const data = typeof raw === 'string' && DATA_IMAGE_RE.test(raw) ? raw : null;
    icons.set(d, data);
    if (!data) continue;
    document.querySelectorAll(`[data-domain="${CSS.escape(d)}"]:not(.has-icon)`).forEach((n) => {
      const img = new Image();
      img.src = data;
      img.alt = '';
      img.draggable = false;
      n.classList.add('has-icon');
      n.replaceChildren(img);
    });
  }
}
const catById = (id) => state.data.categories.find((c) => c.id === id);
const entriesOf = (id) => (state.data.entries[id] = state.data.entries[id] || []);

// ---------------------------------------------------------------------
// Tema: View Transitions API ile tek karede 0.3 sn capraz gecis (parlama yok)
// ---------------------------------------------------------------------
function applyTheme(id, { persistChoice = true, animate = true } = {}) {
  if (!THEMES.some((x) => x.id === id)) id = 'dark';
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== id) {
    const swap = () => { root.setAttribute('data-theme', id); renderThemeSwitches(); };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate && document.startViewTransition && !reduce) document.startViewTransition(swap);
    else swap();
  }
  try { localStorage.setItem('vaultdesk.theme', id); } catch {}
  renderThemeSwitches();
  if (persistChoice && state.settings.theme !== id) {
    state.settings.theme = id;
    vd.updateSettings({ theme: id });
  }
}

function renderThemeSwitches() {
  const current = document.documentElement.getAttribute('data-theme');
  document.querySelectorAll('.theme-switch').forEach((wrap) => {
    wrap.innerHTML = '';
    for (const th of THEMES) {
      const b = el('button', current === th.id ? 'active' : '', th.icon);
      b.type = 'button';
      b.title = t('theme_' + th.id);
      b.setAttribute('aria-pressed', String(current === th.id));
      b.onclick = () => applyTheme(th.id);
      wrap.appendChild(b);
    }
  });
  const cards = $('#settings-theme-cards');
  if (cards) {
    cards.querySelectorAll('.theme-card-option').forEach((c) => c.classList.toggle('active', c.dataset.theme === current));
  }
}

// ---------------------------------------------------------------------
// Dil
// ---------------------------------------------------------------------
function fillLanguageSelect(sel) {
  sel.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('');
  sel.value = i18n.lang;
}

async function changeLanguage(code) {
  await setLanguage(code);
  state.settings.language = i18n.lang;
  vd.updateSettings({ language: i18n.lang });
  applyStaticTranslations();
  renderThemeSwitches();
}

// ---------------------------------------------------------------------
// Modallar (arkasi bulanik overlay)
// ---------------------------------------------------------------------
const modalStack = [];

function openModal({ title, wide = false, onClose } = {}) {
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal' + (wide ? ' wide' : ''));
  if (title) box.appendChild(el('h2', null, title));
  overlay.appendChild(box);
  $('#modal-root').appendChild(overlay);
  const m = { overlay, box, closed: false };
  m.close = () => {
    if (m.closed) return;
    m.closed = true;
    const i = modalStack.indexOf(m);
    if (i >= 0) modalStack.splice(i, 1);
    overlay.remove();
    if (onClose) onClose();
  };
  modalStack.push(m);
  return m;
}

function closeAllModals() {
  while (modalStack.length) modalStack[modalStack.length - 1].close();
}

function actionsRow(box) {
  const row = el('div', 'modal-actions');
  box.appendChild(row);
  return row;
}

function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}

function infoDialog(title, message) {
  return new Promise((resolve) => {
    const m = openModal({ title, onClose: () => resolve() });
    m.box.classList.add('modal-small');
    m.box.appendChild(el('p', 'modal-text', message));
    const ok = button(t('btn_ok'), 'btn-primary', () => m.close());
    actionsRow(m.box).appendChild(ok);
    ok.focus();
  });
}

function confirmDialog(title, message, { danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({ title, onClose: () => resolve(result) });
    m.box.appendChild(el('p', 'modal-text', message));
    const row = actionsRow(m.box);
    row.appendChild(button(t('btn_no'), 'btn-secondary', () => m.close()));
    const yes = button(t('btn_yes'), danger ? 'btn-danger' : 'btn-primary', () => { result = true; m.close(); });
    row.appendChild(yes);
    yes.focus();
  });
}

function field(box, labelKey, input) {
  box.appendChild(el('label', 'field-label', t(labelKey)));
  box.appendChild(input);
  return input;
}

function textInput({ value = '', type = 'text', placeholder = '' } = {}) {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

// ---------------------------------------------------------------------
// Lisans kapisi
// ---------------------------------------------------------------------
function showLicense() {
  showScreen('screen-license');
  const input = $('#license-key');
  const status = $('#license-status');
  status.textContent = '';
  status.className = 'status-line';
  input.focus();
  $('#license-form').onsubmit = async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    const btn = $('#license-submit');
    btn.disabled = true;
    status.className = 'status-line';
    status.textContent = t('license_checking');
    const res = await vd.verifyLicense(key);
    btn.disabled = false;
    if (res.ok) {
      status.className = 'status-line ok';
      status.textContent = t('license_success');
      state.settings.license_verified = true;
      setTimeout(showAuth, 700);
    } else {
      status.className = 'status-line bad';
      status.textContent = t(res.status === 'network' ? 'license_error_network' : 'license_error_invalid');
    }
  };
}

// ---------------------------------------------------------------------
// Giris / kasa olusturma
// ---------------------------------------------------------------------
let authBusy = false;

function showAuth() {
  state.data = null;
  icons.clear();
  iconWanted.clear();
  state.openIds.clear();
  state.pwVisible.clear();
  state.query = '';
  closePalette();
  closeAllModals();
  $('#view').innerHTML = '';
  showScreen('screen-auth');
  const creating = !state.vaultExists;
  $('#auth-subtitle').textContent = t(creating ? 'login_setup_subtitle' : 'login_open_subtitle');
  $('#auth-password2').classList.toggle('hidden', !creating);
  $('#auth-warning').classList.toggle('hidden', !creating);
  $('#auth-import').classList.toggle('hidden', !creating);
  $('#auth-legacy').classList.toggle('hidden', !state.legacyVault);
  $('#auth-use-legacy').classList.toggle('hidden', !state.legacyVault);
  if (state.legacyVault) $('#auth-legacy').textContent = t('import_existing_found', { path: state.legacyVault });
  $('#auth-submit').textContent = t(creating ? 'btn_create_vault' : 'btn_open_vault');
  $('#auth-submit').disabled = false;
  $('#auth-error').classList.add('hidden');
  $('#auth-password').value = '';
  $('#auth-password2').value = '';
  fillLanguageSelect($('#auth-lang'));
  setTimeout(() => $('#auth-password').focus(), 30);
}

function authError(key) {
  const e = $('#auth-error');
  e.textContent = key ? t(key) : '';
  e.classList.toggle('hidden', !key);
}

async function onAuthSubmit(ev) {
  ev.preventDefault();
  if (authBusy) return;
  const p1 = $('#auth-password').value;
  const btn = $('#auth-submit');
  if (!state.vaultExists) {
    const p2 = $('#auth-password2').value;
    if (p1.length < 4) return authError('error_password_too_short');
    if (p1 !== p2) return authError('error_passwords_mismatch');
    authBusy = true;
    authError(null);
    btn.disabled = true;
    btn.textContent = t('btn_creating');
    const cats = DEFAULT_CATEGORIES.map((c) => ({ id: c.id, name: t(c.key), color: c.color, icon: c.icon }));
    const res = await vd.createVault(p1, cats);
    authBusy = false;
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = t('btn_create_vault');
      return authError(res.error === 'short' ? 'error_password_too_short' : null);
    }
    state.vaultExists = true;
    state.legacyVault = null;
    return enterVault(res.data);
  }
  if (!p1) return;
  authBusy = true;
  authError(null);
  btn.disabled = true;
  btn.textContent = t('btn_unlocking');
  const res = await vd.unlock(p1);
  authBusy = false;
  btn.disabled = false;
  btn.textContent = t('btn_open_vault');
  if (!res.ok) {
    $('#auth-password').value = '';
    $('#auth-password').focus();
    if (res.error === 'wrong') return authError('error_wrong_password');
    const e = $('#auth-error');
    e.textContent = res.message || 'Error';
    e.classList.remove('hidden');
    return;
  }
  enterVault(res.data);
}

async function importExisting(useLegacy) {
  const res = useLegacy ? await vd.useLegacyVault() : await vd.importExistingVault();
  if (res.canceled) return;
  if (!res.ok) return infoDialog(t('import_title'), t('import_existing_invalid'));
  const info = await vd.init();
  state.settings = info.settings;
  state.vaultExists = info.vaultExists;
  state.legacyVault = info.legacyVault;
  await setLanguage(info.settings.language);
  applyStaticTranslations();
  applyTheme(info.settings.theme, { persistChoice: false });
  showAuth();
  infoDialog(t('import_title'), t('import_existing_done'));
}

function enterVault(data) {
  state.data = data;
  state.view = { name: 'home' };
  showScreen('screen-main');
  renderView();
}

async function lockNow() {
  await vd.lock();
  showAuth();
}

// ---------------------------------------------------------------------
// Ana gorunum
// ---------------------------------------------------------------------
function renderView() {
  if (!state.data) return;
  if (state.view.name === 'category' && catById(state.view.id)) renderCategory();
  else { state.view = { name: 'home' }; renderHome(); }
}

function renderHome() {
  const v = $('#view');
  const total = Object.values(state.data.entries).reduce((n, list) => n + list.length, 0);
  let html = `<div class="view-head"><h2>${esc(t('dashboard_choose_category'))}</h2><span>${esc(recCount(total))}</span></div><div class="cat-grid">`;
  for (const c of state.data.categories) {
    const n = entriesOf(c.id).length;
    const pct = total ? Math.round((n / total) * 100) : 0;
    html += `<div class="cat-card" draggable="true" data-cat="${esc(c.id)}" style="--cat:${safeColor(c.color)}">
      <div class="cat-card-top"><div class="cat-icon">${esc(c.icon || '📁')}</div>
        <div class="cat-actions"><button type="button" class="icon-btn" data-act="cat-edit" title="${esc(t('btn_edit'))}">✎</button><button type="button" class="icon-btn danger" data-act="cat-delete" title="${esc(t('btn_delete'))}">✕</button></div></div>
      <div class="cat-name">${esc(c.name)}</div>
      <div class="cat-meta"><span>${esc(recCount(n))}</span><b>${pct}%</b></div>
      <div class="cat-bar"><span style="width:${pct}%"></span></div>
    </div>`;
  }
  html += `<button type="button" class="cat-card cat-add" data-act="cat-add"><span class="plus">+</span><span>${esc(t('btn_new_category').replace(/^\+\s*/, ''))}</span></button></div>`;
  v.innerHTML = html;
  v.scrollTop = 0;
}

function renderCategory() {
  const c = catById(state.view.id);
  const v = $('#view');
  const n = entriesOf(c.id).length;
  v.innerHTML = `<div class="cat-head">
      <button type="button" class="btn-secondary" data-act="back" aria-label="back">←</button>
      <div class="cat-icon" style="--cat:${safeColor(c.color)}">${esc(c.icon || '📁')}</div>
      <h2>${esc(c.name)}</h2><span class="count" id="cat-count">${esc(recCount(n))}</span>
      <div class="cat-tools">
        <input type="search" id="rec-search" placeholder="${esc(t('search_placeholder'))}" value="${esc(state.query)}" spellcheck="false" />
        <button type="button" class="btn-secondary" data-act="sort">${esc(t('btn_sort_az'))}</button>
        <button type="button" class="btn-secondary" data-act="cat-csv">↓ CSV</button>
        <button type="button" class="btn-primary" data-act="rec-add">+ ${esc(t('btn_add_record').replace(/^\+\s*/, ''))}</button>
      </div>
    </div>
    <div class="item-list" id="rec-list"></div>`;
  renderRecords();
}

function renderRecords() {
  const list = $('#rec-list');
  if (!list) return;
  const c = catById(state.view.id);
  const all = entriesOf(c.id);
  const q = fold(state.query.trim());
  const rows = q ? all.filter((e) => fold(e.site).includes(q) || fold(e.kullanici).includes(q) || fold(e.eposta).includes(q)) : all;
  list.classList.toggle('searching', !!q);
  const cnt = $('#cat-count');
  if (cnt) cnt.textContent = recCount(all.length);
  if (!rows.length) {
    list.innerHTML = `<p class="empty-hint">${esc(t(q ? 'palette_no_results' : 'category_no_records'))}</p>`;
    return;
  }
  const color = safeColor(c.color);
  const parts = [];
  for (const e of rows) {
    const idx = all.indexOf(e);
    const open = state.openIds.has(e.id);
    const site = e.site || '—';
    const sub = e.kullanici || e.eposta || '';
    parts.push(`<div class="rec${open ? ' open' : ''}" data-rec="${esc(e.id)}" draggable="${q ? 'false' : 'true'}" style="--cat:${color}">
      <div class="rec-row" data-act="rec-toggle">
        <span class="rec-drag" data-act="noop">⠿</span>
        <div class="rec-order"><button type="button" data-act="rec-up"${idx === 0 ? ' disabled' : ''}>▲</button><button type="button" data-act="rec-down"${idx === all.length - 1 ? ' disabled' : ''}>▼</button></div>
        ${entryIconHtml(e, 'avatar', initialOf(site))}
        <div class="rec-main"><span class="rec-site">${esc(site)}</span><span class="rec-sub">${esc(sub)}</span></div>
        <button type="button" class="rec-toggle" data-act="rec-toggle">${open ? '▴ ' + esc(t('btn_hide')) : '▾ ' + esc(t('btn_show'))}</button>
      </div>${open ? recordDetail(e) : ''}</div>`);
  }
  list.innerHTML = parts.join('');
}

function recordDetail(e) {
  const visible = state.pwVisible.has(e.id);
  const pw = e.sifre || '';
  const copied = state.copiedId === e.id;
  const rows = [['field_site', e.site], ['field_username', e.kullanici], ['field_email', e.eposta]];
  let dl = rows.map(([k, val]) => `<dt>${esc(t(k))}</dt><dd>${esc(val || '—')}</dd>`).join('');
  dl += `<dt>${esc(t('field_password'))}</dt><dd class="mono">${esc(visible ? pw : '•'.repeat(Math.max(pw.length, 8)))}</dd>`;
  if (e.ek_bilgi) dl += `<dt>${esc(t('field_notes'))}</dt><dd>${esc(e.ek_bilgi)}</dd>`;
  return `<div class="rec-detail"><dl class="rec-fields">${dl}</dl><div class="rec-actions">
    <button type="button" class="btn-secondary" data-act="rec-pw">${esc(t(visible ? 'btn_hide' : 'btn_show'))}</button>
    <button type="button" class="${copied ? 'btn-copied' : 'btn-secondary'}" data-act="rec-copy">${copied ? '✓ ' + esc(t('btn_copied')) : esc(t('btn_copy'))}</button>
    <button type="button" class="btn-primary" data-act="rec-edit">${esc(t('btn_edit'))}</button>
    <button type="button" class="btn-danger" data-act="rec-delete">${esc(t('btn_delete'))}</button>
  </div></div>`;
}

function openCategory(id) {
  state.view = { name: 'category', id };
  state.query = '';
  renderView();
  $('#view').scrollTop = 0;
}

/** Global aramadan gelindiginde: kaydi acar, gorunur alana kaydirir ve kisa sure vurgular. */
function revealRecord(catId, recId) {
  state.view = { name: 'category', id: catId };
  state.query = '';
  state.openIds.add(recId);
  renderView();
  const node = document.querySelector(`.rec[data-rec="${CSS.escape(recId)}"]`);
  if (node) {
    node.scrollIntoView({ block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1100);
  }
}

// ----- Gorunum olaylari (tek seferlik, delege) -----
function onViewClick(ev) {
  const actEl = ev.target.closest('[data-act]');
  const act = actEl ? actEl.dataset.act : null;
  const card = ev.target.closest('.cat-card[data-cat]');
  const rec = ev.target.closest('.rec[data-rec]');
  if (act === 'noop') return;
  if (act === 'cat-add') return openCategoryForm(null);
  if (card) {
    const cat = catById(card.dataset.cat);
    if (act === 'cat-edit') return openCategoryForm(cat);
    if (act === 'cat-delete') return deleteCategory(cat);
    return openCategory(cat.id);
  }
  if (act === 'back') return renderHomeFromCategory();
  if (act === 'sort') return sortRecords();
  if (act === 'cat-csv') return exportCategoryCsv();
  if (act === 'rec-add') return openEntryForm(state.view.id, null);
  if (!rec) return;
  const list = entriesOf(state.view.id);
  const entry = list.find((x) => x.id === rec.dataset.rec);
  if (!entry) return;
  if (act === 'rec-toggle') {
    if (state.openIds.has(entry.id)) { state.openIds.delete(entry.id); state.pwVisible.delete(entry.id); }
    else state.openIds.add(entry.id);
    return renderRecords();
  }
  if (act === 'rec-up' || act === 'rec-down') return moveRecord(entry, act === 'rec-up' ? -1 : 1);
  if (act === 'rec-pw') {
    state.pwVisible.has(entry.id) ? state.pwVisible.delete(entry.id) : state.pwVisible.add(entry.id);
    return renderRecords();
  }
  if (act === 'rec-copy') {
    vd.copy(entry.sifre || '');
    state.copiedId = entry.id;
    renderRecords();
    setTimeout(() => { if (state.copiedId === entry.id) { state.copiedId = null; renderRecords(); } }, 1300);
    return;
  }
  if (act === 'rec-edit') return openEntryForm(state.view.id, entry);
  if (act === 'rec-delete') return deleteRecord(entry);
}

function renderHomeFromCategory() {
  state.view = { name: 'home' };
  state.query = '';
  renderView();
}

// ----- Surukle-birak (kategoriler ve kayitlar) -----
let drag = null;
function onDragStart(ev) {
  const card = ev.target.closest('.cat-card[data-cat]');
  const rec = ev.target.closest('.rec[data-rec]');
  if (card) drag = { kind: 'cat', id: card.dataset.cat, node: card };
  else if (rec && !state.query.trim()) drag = { kind: 'rec', id: rec.dataset.rec, node: rec };
  else { ev.preventDefault(); return; }
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', drag.id);
  drag.node.classList.add('dragging');
}
function dragTarget(ev) {
  if (!drag) return null;
  return drag.kind === 'cat' ? ev.target.closest('.cat-card[data-cat]') : ev.target.closest('.rec[data-rec]');
}
function onDragOver(ev) {
  const tgt = dragTarget(ev);
  if (!tgt) return;
  ev.preventDefault();
  document.querySelectorAll('.drag-over').forEach((n) => n !== tgt && n.classList.remove('drag-over'));
  if (tgt !== drag.node) tgt.classList.add('drag-over');
}
function onDrop(ev) {
  const tgt = dragTarget(ev);
  if (!tgt || !drag) return;
  ev.preventDefault();
  const dstId = drag.kind === 'cat' ? tgt.dataset.cat : tgt.dataset.rec;
  if (dstId !== drag.id) {
    // kaynak, hedefin hemen onune yerlesir
    const list = drag.kind === 'cat' ? state.data.categories : entriesOf(state.view.id);
    const src = list.findIndex((x) => x.id === drag.id);
    const [item] = list.splice(src, 1);
    list.splice(list.findIndex((x) => x.id === dstId), 0, item);
    persist();
    drag.kind === 'cat' ? renderHome() : renderRecords();
  }
}
function onDragEnd() {
  document.querySelectorAll('.dragging, .drag-over').forEach((n) => n.classList.remove('dragging', 'drag-over'));
  drag = null;
}

// ----- Kayit islemleri -----
function moveRecord(entry, dir) {
  const list = entriesOf(state.view.id);
  const i = list.indexOf(entry);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  persist();
  renderRecords();
}

function sortRecords() {
  entriesOf(state.view.id).sort((a, b) => String(a.site || '').localeCompare(String(b.site || ''), undefined, { sensitivity: 'base' }));
  persist();
  renderRecords();
}

async function deleteRecord(entry) {
  if (!(await confirmDialog('VaultDesk Pro', t('confirm_delete_record', { site: entry.site || '' }), { danger: true }))) return;
  state.data.entries[state.view.id] = entriesOf(state.view.id).filter((x) => x.id !== entry.id);
  state.openIds.delete(entry.id);
  persist();
  renderRecords();
}

async function exportCategoryCsv() {
  const c = catById(state.view.id);
  if (!entriesOf(c.id).length) return infoDialog('VaultDesk Pro', t('export_category_empty'));
  if (!(await confirmDialog(t('export_csv_warning_title'), t('export_csv_warning_message')))) return;
  const res = await vd.exportCsv(state.data, c.id, `${c.name}.csv`);
  if (res.ok) infoDialog(t('settings_title'), t('export_success', { path: res.path }));
}

// ---------------------------------------------------------------------
// Sifre araclari (uretici + guc olcer)
// ---------------------------------------------------------------------
const POOLS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.<>?',
};
function randomIndex(n) {
  // sapmasiz rastgele sayi (reddetme ornekleme)
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}
function generatePassword(length, opts) {
  let pools = Object.keys(POOLS).filter((k) => opts[k]).map((k) => POOLS[k]);
  if (!pools.length) pools = [POOLS.lower];
  length = Math.max(length, pools.length);
  const all = pools.join('');
  const out = pools.map((p) => p[randomIndex(p.length)]);
  while (out.length < length) out.push(all[randomIndex(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
function passwordStrength(pw) {
  if (!pw) return [0, 'weak'];
  const lengthScore = Math.min(pw.length / 16, 1) * 40;
  let classes = 0;
  if (/\p{Ll}/u.test(pw)) classes++;
  if (/\p{Lu}/u.test(pw)) classes++;
  if (/\p{Nd}/u.test(pw)) classes++;
  if (/[^\p{L}\p{N}]/u.test(pw)) classes++;
  const score = Math.min(100, Math.floor(lengthScore + classes * 15));
  return [score, score < 35 ? 'weak' : score < 60 ? 'fair' : score < 85 ? 'good' : 'strong'];
}
const STRENGTH_COLOR = { weak: 'var(--danger)', fair: 'var(--warning)', good: 'var(--accent)', strong: 'var(--success)' };

// ---------------------------------------------------------------------
// Kayit formu
// ---------------------------------------------------------------------
function openEntryForm(catId, entry) {
  const m = openModal({ title: t(entry ? 'dlg_edit_record' : 'dlg_new_record') });
  const b = m.box;
  const site = field(b, 'field_site', textInput({ value: entry ? entry.site : '', placeholder: 'github.com' }));

  // Simge: Otomatik (site ikonu ya da bas harf) veya listeden emoji
  let iconChoice = entry && entry.icon ? entry.icon : '';
  b.appendChild(el('label', 'field-label', t('field_entry_icon')));
  const iconRow = el('div', 'entry-icon-row');
  const iconSlot = el('div', 'entry-icon-slot');
  iconSlot.style.setProperty('--cat', safeColor((catById(catId) || {}).color));
  const pickBtn = button(t('entry_icon_pick'), 'btn-secondary', () => openEmojiPicker((ch) => { iconChoice = ch; refreshIcon(); }));
  const autoBtn = button(t('entry_icon_auto'), 'btn-secondary', () => { iconChoice = ''; refreshIcon(); });
  iconRow.append(iconSlot, pickBtn, autoBtn);
  const iconHint = el('p', 'hint entry-icon-hint');
  b.append(iconRow, iconHint);
  let notes = null;
  function refreshIcon() {
    const probe = { site: site.value, ek_bilgi: notes ? notes.value : (entry ? entry.ek_bilgi : ''), icon: iconChoice };
    iconSlot.innerHTML = entryIconHtml(probe, 'avatar entry-icon-preview', initialOf(site.value));
    autoBtn.disabled = !iconChoice;
    const d = iconsEnabled() ? VaultDeskDomain.domainForEntry(probe) : null;
    iconHint.textContent = iconChoice ? '' : d ? t('entry_icon_hint_domain', { domain: d }) : t('entry_icon_hint');
  }
  site.addEventListener('input', debounce(refreshIcon, 350));

  const user = field(b, 'field_username', textInput({ value: entry ? entry.kullanici : '' }));
  const mail = field(b, 'field_email', textInput({ value: entry ? entry.eposta : '' }));

  b.appendChild(el('label', 'field-label', t('field_password')));
  const row = el('div', 'pw-row');
  const pw = textInput({ value: entry ? entry.sifre : '', type: 'password' });
  pw.classList.add('mono');
  const eye = button('👁', 'btn-secondary');
  eye.title = t('btn_show');
  eye.onclick = () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.classList.toggle('on', show);
    eye.title = t(show ? 'btn_hide' : 'btn_show');
  };
  const dice = button('🎲', 'btn-secondary', () => openGenerator(pw, updateMeter));
  dice.title = t('generator_title');
  row.append(pw, eye, dice);
  b.appendChild(row);
  const meter = el('div', 'meter');
  const bar = el('span');
  meter.appendChild(bar);
  const meterLabel = el('div', 'meter-label');
  b.append(meter, meterLabel);
  function updateMeter() {
    const [score, level] = passwordStrength(pw.value);
    bar.style.width = (pw.value ? score : 0) + '%';
    bar.style.backgroundColor = STRENGTH_COLOR[level];
    meterLabel.textContent = pw.value ? `${t('strength_label')}: ${t('strength_' + level)}` : '';
  }
  pw.addEventListener('input', updateMeter);
  updateMeter();

  notes = document.createElement('textarea');
  notes.value = entry ? entry.ek_bilgi || '' : '';
  notes.rows = 2;
  field(b, 'field_notes', notes);
  notes.addEventListener('input', debounce(refreshIcon, 350));
  refreshIcon();
  const err = el('p', 'error hidden');
  b.appendChild(err);

  const save = () => {
    const rec = { site: site.value.trim(), kullanici: user.value, eposta: mail.value, sifre: pw.value, ek_bilgi: notes.value };
    if (!rec.site) {
      err.textContent = t('error_site_required');
      err.classList.remove('hidden');
      site.focus();
      return;
    }
    if (iconChoice) rec.icon = iconChoice;
    if (entry) {
      Object.assign(entry, rec);
      if (!iconChoice) delete entry.icon;
      state.pwVisible.delete(entry.id);
    } else {
      entriesOf(catId).push({ id: newId(), ...rec });
    }
    persist();
    m.close();
    renderRecords();
  };
  const actions = actionsRow(b);
  actions.append(button(t('btn_cancel'), 'btn-secondary', () => m.close()), button(t('btn_save'), 'btn-primary', save));
  for (const inp of [site, user, mail, pw]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  site.focus();
}

function openGenerator(target, onUse) {
  const m = openModal({ title: t('generator_title') });
  const b = m.box;
  const opts = { upper: true, lower: true, digits: true, symbols: true };
  let length = 16;
  const lenLabel = el('label', 'field-label');
  const range = document.createElement('input');
  range.type = 'range';
  range.min = 8;
  range.max = 40;
  range.value = length;
  b.append(lenLabel, range);
  const preview = textInput();
  preview.classList.add('mono', 'gen-preview');
  const regen = () => {
    lenLabel.textContent = `${t('generator_length')}: ${length}`;
    preview.value = generatePassword(length, opts);
  };
  range.addEventListener('input', () => { length = Number(range.value); regen(); });
  for (const [k, key] of [['upper', 'generator_uppercase'], ['lower', 'generator_lowercase'], ['digits', 'generator_digits'], ['symbols', 'generator_symbols']]) {
    const lab = el('label', 'check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.onchange = () => { opts[k] = cb.checked; regen(); };
    lab.append(cb, document.createTextNode(t(key)));
    b.appendChild(lab);
  }
  b.appendChild(preview);
  const actions = actionsRow(b);
  actions.append(
    button(t('btn_generate'), 'btn-secondary', regen),
    button(t('btn_use_password'), 'btn-primary', () => {
      target.value = preview.value;
      target.dispatchEvent(new Event('input'));
      if (onUse) onUse();
      m.close();
    }),
  );
  regen();
}

// ---------------------------------------------------------------------
// Kategori formu + emoji secici
// ---------------------------------------------------------------------
function openCategoryForm(cat) {
  const m = openModal({ title: t(cat ? 'dlg_edit_category' : 'dlg_new_category') });
  const b = m.box;
  const st = { icon: cat ? cat.icon || '📁' : '📁', color: cat ? safeColor(cat.color) : PALETTE[0] };
  const name = field(b, 'field_category_name', textInput({ value: cat ? cat.name : '' }));

  b.appendChild(el('label', 'field-label', t('field_icon')));
  const iconRow = el('div', 'icon-pick');
  const iconBtn = button(st.icon, '', () => openEmojiPicker((ch) => { st.icon = ch; iconBtn.textContent = ch; }));
  iconRow.append(iconBtn, el('span', 'muted', t('emoji_picker_title') + ' →'));
  b.appendChild(iconRow);

  b.appendChild(el('label', 'field-label', t('field_color')));
  const sw = el('div', 'swatches');
  const custom = el('label', 'swatch swatch-custom', '+');
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.title = t('btn_pick_color');
  custom.appendChild(picker);
  const paint = () => {
    const inPalette = PALETTE.some((c) => c.toLowerCase() === st.color.toLowerCase());
    sw.querySelectorAll('.swatch[data-c]').forEach((s) => s.classList.toggle('sel', s.dataset.c.toLowerCase() === st.color.toLowerCase()));
    custom.classList.toggle('sel', !inPalette);
    custom.style.background = inPalette ? '' : st.color;
    picker.value = /^#[0-9a-f]{6}$/i.test(st.color) ? st.color : '#5b8cff';
  };
  for (const c of PALETTE) {
    const s = button('', 'swatch', () => { st.color = c; paint(); });
    s.dataset.c = c;
    s.style.background = c;
    sw.appendChild(s);
  }
  picker.addEventListener('input', () => { st.color = picker.value; paint(); });
  sw.appendChild(custom);
  b.appendChild(sw);
  paint();
  const err = el('p', 'error hidden');
  b.appendChild(err);

  const save = () => {
    const n = name.value.trim();
    if (!n) {
      err.textContent = t('error_category_name_required');
      err.classList.remove('hidden');
      return;
    }
    if (cat) Object.assign(cat, { name: n, icon: st.icon, color: st.color });
    else {
      const id = newId();
      state.data.categories.push({ id, name: n, icon: st.icon, color: st.color });
      state.data.entries[id] = [];
    }
    persist();
    m.close();
    renderView();
  };
  actionsRow(b).append(button(t('btn_cancel'), 'btn-secondary', () => m.close()), button(t('btn_save'), 'btn-primary', save));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  name.focus();
}

async function deleteCategory(cat) {
  if (entriesOf(cat.id).length) return infoDialog('VaultDesk Pro', t('error_category_not_empty', { name: cat.name }));
  if (!(await confirmDialog('VaultDesk Pro', t('confirm_delete_category', { name: cat.name }), { danger: true }))) return;
  state.data.categories = state.data.categories.filter((c) => c.id !== cat.id);
  delete state.data.entries[cat.id];
  persist();
  renderHome();
}

function openEmojiPicker(onPick) {
  const m = openModal({ title: t('emoji_picker_title') });
  const b = m.box;
  const search = textInput({ type: 'search', placeholder: t('emoji_search_placeholder') });
  const tabs = el('div', 'emoji-tabs');
  const grid = el('div', 'emoji-grid');
  const nameLine = el('div', 'emoji-name');
  b.append(search, tabs, grid, nameLine);
  let group = 0;
  const names = new Map();
  EMOJI_GROUPS.forEach((g) => g.items.forEach(([ch, nm]) => names.set(ch, nm)));
  function show(items) {
    grid.innerHTML = items.length
      ? items.map(([ch]) => `<button type="button" data-ch="${esc(ch)}">${esc(ch)}</button>`).join('')
      : `<p class="muted" style="grid-column:1/-1;text-align:center">${esc(t('emoji_no_results'))}</p>`;
    grid.scrollTop = 0;
  }
  function drawTabs() {
    tabs.innerHTML = EMOJI_GROUPS.map((g, i) => `<button type="button" data-g="${i}" class="${i === group && !search.value.trim() ? 'active' : ''}">${esc(g.tab)}</button>`).join('');
  }
  function run() {
    const q = search.value.trim().toLowerCase();
    drawTabs();
    if (!q) return show(EMOJI_GROUPS[group].items);
    // Win+. ile yapistirilan emoji dogrudan kabul edilir; aksi halde Unicode (Ingilizce) adinda aranir.
    const pasted = Array.from(search.value.trim()).filter((ch) => /\p{Extended_Pictographic}/u.test(ch));
    if (pasted.length) return show(pasted.map((ch) => [ch, names.get(ch) || '']));
    const hits = [];
    for (const g of EMOJI_GROUPS) for (const it of g.items) if (it[1].includes(q) && hits.length < 140) hits.push(it);
    show(hits);
  }
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-g]');
    if (!btn) return;
    group = Number(btn.dataset.g);
    search.value = '';
    run();
  });
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ch]');
    if (!btn) return;
    onPick(btn.dataset.ch);
    m.close();
  });
  grid.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-ch]');
    const nm = btn ? names.get(btn.dataset.ch) || '' : '';
    nameLine.textContent = btn ? `${btn.dataset.ch}  ${nm.replace(/\b\w/g, (c) => c.toUpperCase())}` : '';
  });
  search.addEventListener('input', debounce(run, 120));
  run();
  search.focus();
}

// ---------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------
function openSettings() {
  const m = openModal({ title: t('settings_title'), wide: true });
  const b = m.box;
  b.appendChild(el('label', 'field-label', t('settings_theme')));
  const cards = el('div', 'theme-cards');
  cards.id = 'settings-theme-cards';
  for (const th of THEMES) {
    const c = el('button', 'theme-card-option');
    c.type = 'button';
    c.dataset.theme = th.id;
    c.innerHTML = `<div class="theme-preview ${th.id}"><span></span><span></span><span></span></div><span>${esc(th.icon)} ${esc(t('theme_' + th.id))}</span>`;
    c.onclick = () => applyTheme(th.id);
    cards.appendChild(c);
  }
  b.appendChild(cards);

  const grid = el('div', 'settings-grid');
  const left = el('div');
  const right = el('div');
  grid.append(left, right);
  b.appendChild(grid);

  const lang = document.createElement('select');
  fillLanguageSelect(lang);
  lang.onchange = async () => {
    m.close();
    await changeLanguage(lang.value);
    renderView();
    openSettings();
  };
  field(left, 'settings_language', lang);

  const lock = document.createElement('select');
  lock.innerHTML = state.autolockChoices
    .map((n) => `<option value="${n}">${esc(n ? t('autolock_option_minutes', { n }) : t('autolock_never'))}</option>`).join('');
  lock.value = String(state.settings.autolock_minutes);
  lock.onchange = () => {
    state.settings.autolock_minutes = Number(lock.value);
    vd.updateSettings({ autolock_minutes: Number(lock.value) });
  };
  field(left, 'settings_autolock', lock);

  left.appendChild(el('label', 'field-label', t('settings_icons')));
  const iconLab = el('label', 'check');
  const iconCb = document.createElement('input');
  iconCb.type = 'checkbox';
  iconCb.checked = iconsEnabled();
  iconCb.onchange = () => {
    state.settings.fetch_icons = iconCb.checked;
    vd.updateSettings({ fetch_icons: iconCb.checked });
    renderView();
  };
  iconLab.append(iconCb, document.createTextNode(t('settings_fetch_icons')));
  left.append(iconLab, el('p', 'hint icons-hint', t('settings_fetch_icons_hint')));


  // --- Yedekleme / geri yukleme ---
  right.appendChild(el('label', 'field-label', t('backup_section')));
  const backupStack = el('div', 'stack');
  backupStack.append(
    button('⤓ ' + t('backup_export_btn'), 'btn-primary btn-block', exportBackup),
    button('⤒ ' + t('backup_import_btn'), 'btn-secondary btn-block', () => { m.close(); openRestore('open'); }),
    el('p', 'hint backup-hint', t('backup_export_hint')),
  );
  right.appendChild(backupStack);

  right.appendChild(el('label', 'field-label', t('settings_data')));
  const stack = el('div', 'stack');
  stack.append(
    button(t('btn_export_csv'), 'btn-secondary btn-block', async () => {
      if (!(await confirmDialog(t('export_csv_warning_title'), t('export_csv_warning_message')))) return;
      const res = await vd.exportCsv(state.data, null, 'vaultdesk_export.csv');
      if (res.ok) infoDialog(t('settings_title'), t('export_success', { path: res.path }));
    }),
    button(t('btn_import'), 'btn-secondary btn-block', () => { m.close(); openImport(); }),
  );
  right.appendChild(stack);

  right.appendChild(el('label', 'field-label', t('settings_security')));
  right.appendChild(button(t('btn_change_master_password'), 'btn-secondary btn-block', () => { m.close(); openChangePassword(); }));

  const sig = el('div', 'brand-signature settings-signature');
  sig.innerHTML = '<img class="brand-logo" src="assets/devilt_logo.png" alt="" width="22" height="22" /><span>by Devilt Interactive</span>';
  b.appendChild(sig);
  actionsRow(b).appendChild(button(t('btn_ok'), 'btn-secondary', () => m.close()));
  renderThemeSwitches();
}

function openChangePassword() {
  const m = openModal({ title: t('change_password_title') });
  const b = m.box;
  const cur = textInput({ type: 'password', placeholder: t('current_password_placeholder') });
  const n1 = textInput({ type: 'password', placeholder: t('new_password_placeholder') });
  const n2 = textInput({ type: 'password', placeholder: t('new_password_repeat_placeholder') });
  for (const i of [cur, n1, n2]) { i.style.marginTop = '10px'; b.appendChild(i); }
  const err = el('p', 'error hidden');
  b.appendChild(err);
  const fail = (key) => { err.textContent = t(key); err.classList.remove('hidden'); };
  const ok = button(t('btn_update'), 'btn-primary', async () => {
    if (n1.value.length < 4) return fail('error_password_too_short');
    if (n1.value !== n2.value) return fail('error_passwords_mismatch');
    ok.disabled = true;
    ok.textContent = t('btn_updating');
    const res = await vd.changePassword(cur.value, n1.value);
    ok.disabled = false;
    ok.textContent = t('btn_update');
    if (!res.ok) return fail(res.error === 'short' ? 'error_password_too_short' : 'error_current_password_wrong');
    m.close();
    infoDialog('VaultDesk Pro', t('success_password_updated'));
  });
  actionsRow(b).append(button(t('btn_cancel'), 'btn-secondary', () => m.close()), ok);
  cur.focus();
}

function openImport() {
  const m = openModal({ title: t('import_title') });
  const b = m.box;
  const src = document.createElement('select');
  src.innerHTML = IMPORT_SOURCES.map(([k, key]) => `<option value="${k}">${esc(t(key))}</option>`).join('');
  field(b, 'import_select_source', src);
  const cat = document.createElement('select');
  cat.innerHTML = state.data.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (state.view.name === 'category') cat.value = state.view.id;
  field(b, 'import_select_category', cat);
  let filePath = null;
  const pathLabel = el('div', 'file-label');
  const pick = button(t('btn_choose_file'), 'btn-secondary btn-block', async () => {
    const res = await vd.pickCsv();
    if (res.ok) { filePath = res.path; pathLabel.textContent = res.path; }
  });
  pick.style.marginTop = '16px';
  b.append(pick, pathLabel);
  const err = el('p', 'error hidden');
  b.appendChild(err);
  const start = button(t('btn_start_import'), 'btn-primary', async () => {
    if (!filePath) { err.textContent = t('import_no_file'); err.classList.remove('hidden'); return; }
    if (!cat.value) return;
    start.disabled = true;
    start.textContent = t('importing_progress');
    const res = await vd.importCsv(filePath, src.value);
    start.disabled = false;
    start.textContent = t('btn_start_import');
    if (!res.ok) { err.textContent = res.message || 'Error'; err.classList.remove('hidden'); return; }
    const list = entriesOf(cat.value);
    for (const r of res.records) list.push({ id: newId(), ...r });
    persist();
    m.close();
    renderView();
    infoDialog(t('import_title'), t('import_done', { count: res.records.length }));
  });
  actionsRow(b).append(button(t('btn_cancel'), 'btn-secondary', () => m.close()), start);
}

// ---------------------------------------------------------------------
// Yedekleme / geri yukleme
// ---------------------------------------------------------------------
async function exportBackup() {
  const res = await vd.exportBackup(state.data);
  if (res.ok) infoDialog(t('backup_export_btn'), t('backup_export_done', { path: res.path, records: res.records }));
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString(i18n.lang.replace('_', '-'));
}

/**
 * context "open"  : Ayarlar'dan, kasa acikken -> birlestir / yerine koy (ana sifre degismez)
 * context "login" : giris ekranindan -> kasa yedekten kurulur, ana sifre = yedegin sifresi
 */
async function openRestore(context) {
  const pick = await vd.pickBackup();
  if (pick.canceled) return;
  if (!pick.ok) {
    const key = { missing_salt: 'backup_missing_salt', missing_vault: 'backup_missing_vault' }[pick.error] || 'backup_invalid_file';
    return infoDialog(t('backup_restore_title'), t(key));
  }
  const legacyVault = pick.format === 'raw-vault';
  let finished = false;
  const m = openModal({ title: t('backup_restore_title'), onClose: () => { if (!finished) vd.discardBackup(); } });
  const b = m.box;
  const fileInfo = el('div', 'backup-file');
  fileInfo.innerHTML = legacyVault
    ? `<div class="backup-file-name">🔐 ${esc(t('backup_legacy_vault_label'))}</div>
       <div class="hint">${esc(pick.folder || '')}</div>
       <div class="hint">${esc(t('backup_modified', { date: formatDate(pick.createdAt) }))}</div>`
    : `<div class="backup-file-name">🗄 ${esc(pick.name)}</div>
       <div class="hint">${esc(t('backup_created', { date: formatDate(pick.createdAt) }))}</div>`;
  b.appendChild(fileInfo);

  const step1 = el('div');
  const pw = textInput({ type: 'password', placeholder: t('backup_password_placeholder') });
  step1.append(el('label', 'field-label', t('backup_password_label')), pw,
    el('p', 'hint', t(legacyVault ? 'backup_password_hint_legacy' : 'backup_password_hint')));
  b.appendChild(step1);
  const step2 = el('div', 'hidden');
  b.appendChild(step2);
  const err = el('p', 'error hidden');
  b.appendChild(err);
  const fail = (key) => { err.textContent = t(key); err.classList.remove('hidden'); };

  const actions = actionsRow(b);
  const primary = button(t('backup_decrypt_btn'), 'btn-primary');
  actions.append(button(t('btn_cancel'), 'btn-secondary', () => m.close()), primary);

  let inspected = null;
  let modeOf = () => (context === 'login' ? 'vault' : 'merge');
  let applySettingsBox = null;

  async function decrypt() {
    if (!pw.value) return;
    err.classList.add('hidden');
    primary.disabled = true;
    primary.textContent = t('btn_unlocking');
    const res = await vd.inspectBackup(pick.id, pw.value);
    primary.disabled = false;
    primary.textContent = t('backup_decrypt_btn');
    if (!res.ok) {
      if (res.error === 'wrong') { pw.value = ''; pw.focus(); return fail('backup_wrong_password'); }
      return fail('backup_invalid_file');
    }
    inspected = res;
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    step2.innerHTML = `<div class="backup-stats">${esc(t('backup_contents', res.stats))}</div>`;
    if (context === 'open') {
      const opts = el('div', 'radio-group');
      opts.innerHTML = ['merge', 'replace'].map((mode, i) => `<label class="radio-option">
          <input type="radio" name="restore-mode" value="${mode}"${i === 0 ? ' checked' : ''} />
          <span><b>${esc(t('backup_mode_' + mode))}</b><small>${esc(t('backup_mode_' + mode + '_desc'))}</small></span>
        </label>`).join('');
      step2.appendChild(opts);
      modeOf = () => opts.querySelector('input:checked').value;
    } else {
      step2.appendChild(el('p', 'notice' + (state.vaultExists ? ' warn' : ''),
        t(state.vaultExists ? 'backup_replace_warning_locked' : 'backup_new_vault_info')));
    }
    if (res.hasSettings) {
      const lab = el('label', 'check');
      applySettingsBox = document.createElement('input');
      applySettingsBox.type = 'checkbox';
      applySettingsBox.checked = true;
      lab.append(applySettingsBox, document.createTextNode(t('backup_apply_settings')));
      step2.appendChild(lab);
    }
    primary.textContent = t('backup_restore_btn');
    primary.onclick = restore;
    primary.focus();
  }

  async function restore() {
    const mode = modeOf();
    if (mode === 'replace' && !(await confirmDialog(t('backup_restore_title'), t('backup_replace_confirm'), { danger: true }))) return;
    primary.disabled = true;
    primary.textContent = t('importing_progress');
    const res = await vd.restoreBackup({
      id: pick.id, mode, applySettings: !!(applySettingsBox && applySettingsBox.checked),
      currentData: mode === 'merge' ? state.data : null,
    });
    primary.disabled = false;
    primary.textContent = t('backup_restore_btn');
    if (!res.ok) return fail(res.error === 'expired' ? 'backup_invalid_file' : 'backup_invalid_file');
    finished = true;
    m.close();
    if (applySettingsBox && applySettingsBox.checked) {
      state.settings = res.settings;
      if (res.settings.language !== i18n.lang) {
        await setLanguage(res.settings.language);
        applyStaticTranslations();
      }
      applyTheme(res.settings.theme, { persistChoice: false });
    }
    if (context === 'login') {
      state.vaultExists = true;
      state.legacyVault = null;
      enterVault(res.data);
    } else {
      state.data = res.data;
      state.openIds.clear();
      renderView();
    }
    let msg = mode === 'merge'
      ? t('backup_restore_done_merge', res.added)
      : t('backup_restore_done_replace', { records: res.records });
    if (res.safety) msg += '\n\n' + t('backup_safety_copy', { path: res.safety });
    infoDialog(t('backup_restore_title'), msg);
  }

  primary.onclick = decrypt;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!inspected) decrypt(); } });
  pw.focus();
}

// ---------------------------------------------------------------------
// Global arama (komut paleti, Ctrl+K) — tum kategorilerde canli arama
// ---------------------------------------------------------------------
let palette = null;

function openPalette() {
  if (!state.data) return;
  if (palette) { palette.input.focus(); return; }
  if (modalStack.length) return;
  const overlay = el('div', 'modal-overlay cmdk-overlay');
  const box = el('div', 'cmdk');
  box.innerHTML = `<div class="cmdk-input-row">
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t('global_search_placeholder'))}" />
      <kbd>Esc</kbd></div>
    <div class="cmdk-results"></div>
    <div class="cmdk-footer"><span class="hint-text">${esc(t('palette_hint'))}</span><span class="count"></span></div>`;
  overlay.appendChild(box);
  $('#modal-root').appendChild(overlay);
  palette = {
    overlay, input: $('input', box), results: $('.cmdk-results', box), count: $('.count', box),
    items: [], sel: 0, timer: null,
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
  palette.input.addEventListener('input', () => {
    clearTimeout(palette.timer);
    palette.timer = setTimeout(runPaletteSearch, 60);
  });
  palette.input.addEventListener('keydown', onPaletteKey);
  palette.results.addEventListener('mousemove', (e) => {
    const row = e.target.closest('[data-i]');
    if (row && Number(row.dataset.i) !== palette.sel) selectPalette(Number(row.dataset.i), false);
  });
  palette.results.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) activatePalette(Number(row.dataset.i), false);
  });
  runPaletteSearch();
  palette.input.focus();
}

function closePalette() {
  if (!palette) return;
  clearTimeout(palette.timer);
  palette.overlay.remove();
  palette = null;
}

function highlight(text, q) {
  const s = String(text || '');
  if (!q) return esc(s);
  const i = fold(s).indexOf(q);
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}

function runPaletteSearch() {
  if (!palette) return;
  const q = fold(palette.input.value.trim());
  const cats = state.data.categories;
  const catItems = cats.filter((c) => !q || fold(c.name).includes(q)).map((c) => ({ kind: 'cat', cat: c }));
  const hits = [];
  if (q) {
    for (const c of cats) {
      for (const e of entriesOf(c.id)) {
        const site = fold(e.site);
        let rank;
        if (site.includes(q)) rank = site.startsWith(q) ? 0 : 1;
        else if (fold(e.kullanici).includes(q) || fold(e.eposta).includes(q) || fold(e.ek_bilgi).includes(q)) rank = 2;
        else continue;
        hits.push({ rank, kind: 'entry', cat: c, entry: e });
      }
    }
    hits.sort((a, b) => a.rank - b.rank);
  }
  const total = catItems.length + hits.length;
  palette.items = [...catItems, ...hits].slice(0, PALETTE_MAX);
  palette.sel = 0;
  palette.count.className = 'count';
  palette.count.textContent = q ? String(total) : '';
  const nCat = Math.min(catItems.length, palette.items.length);
  let html = '';
  if (!palette.items.length) html = `<div class="cmdk-empty">${esc(t('palette_no_results'))}</div>`;
  palette.items.forEach((it, i) => {
    if (i === 0 && nCat) html += `<div class="cmdk-group-label">${esc(t('palette_group_categories'))}</div>`;
    if (i === nCat) html += `<div class="cmdk-group-label">${esc(t('palette_group_records'))}</div>`;
    const color = safeColor(it.cat.color);
    if (it.kind === 'cat') {
      const n = entriesOf(it.cat.id).length;
      html += `<div class="cmdk-item" data-i="${i}"><div class="cmdk-item-icon" style="--cat:${color}">${esc(it.cat.icon || '📁')}</div>
        <div class="cmdk-item-text"><div class="cmdk-item-title">${highlight(it.cat.name, q)}</div><div class="cmdk-item-sub">${esc(recCount(n))}</div></div>
        <span class="cmdk-item-meta">${esc(t('palette_category'))}</span></div>`;
    } else {
      const e = it.entry;
      const sub = [e.kullanici, e.eposta].filter(Boolean).map((x) => highlight(x, q)).join('  ·  ');
      html += `<div class="cmdk-item" data-i="${i}">${entryIconHtml(e, 'cmdk-item-icon', esc(it.cat.icon || '📁'), `--cat:${color}`)}
        <div class="cmdk-item-text"><div class="cmdk-item-title">${highlight(e.site || '—', q)}</div><div class="cmdk-item-sub">${sub}</div></div>
        <span class="cmdk-item-meta">${esc(it.cat.name)}</span></div>`;
    }
  });
  palette.results.innerHTML = html;
  palette.results.scrollTop = 0;
  selectPalette(0, false);
}

function selectPalette(i, scroll = true) {
  if (!palette || !palette.items.length) return;
  palette.sel = Math.max(0, Math.min(palette.items.length - 1, i));
  palette.results.querySelectorAll('.cmdk-item').forEach((n) => n.classList.toggle('selected', Number(n.dataset.i) === palette.sel));
  if (scroll) {
    const node = palette.results.querySelector(`[data-i="${palette.sel}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}

function onPaletteKey(e) {
  const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 6, PageUp: -6 };
  if (e.key in moves) { e.preventDefault(); selectPalette(palette.sel + moves[e.key]); }
  else if (e.key === 'Enter') { e.preventDefault(); activatePalette(palette.sel, e.ctrlKey); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
}

function activatePalette(i, copy) {
  const it = palette && palette.items[i];
  if (!it) return;
  if (copy) {
    if (it.kind !== 'entry') return;
    vd.copy(it.entry.sifre || '');
    palette.count.className = 'count ok';
    palette.count.textContent = t('palette_copied');
    setTimeout(closePalette, 650);
    return;
  }
  closePalette();
  if (it.kind === 'cat') openCategory(it.cat.id);
  else revealRecord(it.cat.id, it.entry.id);
}

// ---------------------------------------------------------------------
// Klavye
// ---------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (state.data && !modalStack.length) openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (palette) { closePalette(); return; }
    if (modalStack.length) { e.preventDefault(); modalStack[modalStack.length - 1].close(); }
  }
});

// ---------------------------------------------------------------------
// Baslangic
// ---------------------------------------------------------------------
async function boot() {
  const info = await vd.init();
  state.settings = info.settings;
  state.vaultExists = info.vaultExists;
  state.legacyVault = info.legacyVault;
  state.licenseRequired = info.licenseRequired;
  state.autolockChoices = info.autolockChoices || state.autolockChoices;
  await setLanguage(info.settings.language);
  applyStaticTranslations();
  applyTheme(info.settings.theme, { persistChoice: false, animate: false });

  $('#auth-form').addEventListener('submit', onAuthSubmit);
  $('#auth-lang').addEventListener('change', async (e) => { await changeLanguage(e.target.value); showAuth(); });
  $('#auth-import-existing').addEventListener('click', () => importExisting(false));
  $('#auth-use-legacy').addEventListener('click', () => importExisting(true));
  $('#auth-restore').addEventListener('click', () => openRestore('login'));
  $('#search-trigger').addEventListener('click', openPalette);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-lock').addEventListener('click', lockNow);
  const view = $('#view');
  view.addEventListener('click', onViewClick);
  view.addEventListener('dragstart', onDragStart);
  view.addEventListener('dragover', onDragOver);
  view.addEventListener('drop', onDrop);
  view.addEventListener('dragend', onDragEnd);
  view.addEventListener('input', debounce((e) => {
    if (e.target.id !== 'rec-search') return;
    state.query = e.target.value;
    renderRecords();
  }, 80));

  // Ana surec kilitledi (otomatik kilit / X ile tepsiye kucultme)
  vd.onIconsUpdated(applyIcons);
  vd.onLocked((lockInfo) => {
    if (!state.data) return;
    showAuth();
    if (lockInfo.reason === 'idle' && lockInfo.visible) {
      infoDialog(t('autolock_title'), t('autolock_message_idle', { minutes: state.settings.autolock_minutes }));
    }
  });

  if (state.licenseRequired && !state.settings.license_verified) showLicense();
  else showAuth();
}

boot();
