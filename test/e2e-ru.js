'use strict';
/* Rusca dil + tepsi menusu dil senkronizasyonu testi. Kullanim: electron test/e2e-ru.js <cikti> */
const path = require('path');
const fs = require('fs');
const os = require('os');
const OUT = path.resolve(process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-ru-e2e-'));
process.env.VAULTDESK_DATA_DIR = DATA;
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'tr', theme: 'dark' }));

const { app, BrowserWindow } = require('electron');
require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const check = (n, c, x = '') => log.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? '  (' + x + ')' : ''}`);
const tray = () => global.__vaultdeskTray();
const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'ru.json'), 'utf8'));

app.whenReady().then(async () => {
  await sleep(100);
  check('tray in saved language before UI loads (tr)', tray().lang === 'tr' && tray().quit === 'Çıkış', JSON.stringify(tray()));
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(50); }
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await sleep(600);
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  const js = async (code) => {
    const r = await wc.executeJavaScript(`try { ${code}\n } catch (e) { ({ __err: String((e && e.stack) || e) }) }`, true);
    if (r && r.__err) throw new Error(r.__err + '\n in: ' + code.slice(0, 120));
    return r;
  };
  const shot = async (n) => { await sleep(450); fs.writeFileSync(path.join(OUT, n + '.png'), (await wc.capturePage()).toPNG()); };
  const waitFor = async (code, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await js(code)) return true; await sleep(100); } return false; };
  // ekranda cevrilmemis anahtar (or. "backup_section") kalmis mi?
  const untranslated = `(() => { const keys = new Set(Object.keys(i18n.fallback)); const txt = document.body.innerText + ' ' + [...document.querySelectorAll('[placeholder]')].map((e) => e.placeholder).join(' ');
    return (txt.match(/\\b[a-z]+(?:_[a-z0-9]+)+\\b/g) || []).filter((w) => keys.has(w)); })()`;

  // giris (kurulum) ekraninda dil -> Rusca
  check('Русский offered in language list', await js(`[...document.querySelectorAll('#auth-lang option')].some((o) => o.value === 'ru' && o.textContent === 'Русский')`));
  await js(`const s = document.querySelector('#auth-lang'); s.value = 'ru'; s.dispatchEvent(new Event('change')); true`);
  await waitFor(`i18n.lang === 'ru' && document.querySelector('#auth-submit').textContent === ${JSON.stringify(ru.btn_create_vault)}`);
  await sleep(200);
  check('tray switches to Russian instantly', tray().lang === 'ru' && tray().show === ru.tray_show && tray().lock === ru.tray_lock && tray().quit === ru.tray_quit, JSON.stringify(tray()));
  check('setup screen in Russian', await js(`document.querySelector('#auth-subtitle').textContent === ${JSON.stringify(ru.login_setup_subtitle)}`));
  await shot('R1_setup_ru');

  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-password2').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  check('default categories in Russian', await js(`state.data.categories.map((c) => c.name).join('|')`) === [ru.default_cat_social, ru.default_cat_misc, ru.default_cat_gamedesign, ru.default_cat_ai, ru.default_cat_shopping].join('|'));
  await js(`(() => { const ids = state.data.categories.map((c) => c.id); [1, 2, 5, 21].forEach((n, i) => { for (let j = 0; j < n; j++) state.data.entries[ids[i]].push({ id: newId(), site: 'Сайт ' + j, kullanici: 'user' + j, eposta: '', sifre: 'p' + j, ek_bilgi: '' }); }); persist(); renderView(); return true; })()`);
  await sleep(300);
  check('Russian plural forms (1 запись / 2 записи / 5 записей / 21 запись)',
    await js(`[1, 2, 5, 21, 11].map((n) => tPlural('records', n)).join('|')`) === '1 запись|2 записи|5 записей|21 запись|11 записей',
    await js(`[1, 2, 5, 21, 11].map((n) => tPlural('records', n)).join('|')`));
  check('dashboard: no untranslated keys', (await js(untranslated)).length === 0, JSON.stringify(await js(untranslated)));
  await shot('R2_dashboard_ru');

  // kategori + kayit formu + palet + ayarlar
  await js(`openCategory(state.data.categories[1].id); true`); await sleep(200);
  await js(`state.openIds.add(entriesOf(state.view.id)[0].id); renderRecords(); true`);
  check('category page: no untranslated keys', (await js(untranslated)).length === 0, JSON.stringify(await js(untranslated)));
  await shot('R3_category_ru');
  await js(`openEntryForm(state.view.id, null); true`);
  check('entry form: no untranslated keys', (await js(untranslated)).length === 0);
  await shot('R4_entry_form_ru');
  await js(`closeAllModals(); openPalette(); palette.input.value = 'сайт'; runPaletteSearch(); true`);
  check('palette Russian + Cyrillic search', await js(`palette.items.some((x) => x.kind === 'entry') && document.querySelector('.cmdk-footer .hint-text').textContent === t('palette_hint')`));
  await shot('R5_palette_ru');
  await js(`closePalette(); openSettings(); true`);
  check('settings: Русский selected + no untranslated keys', await js(`[...document.querySelectorAll('.modal select')][0].value === 'ru'`) && (await js(untranslated)).length === 0, JSON.stringify(await js(untranslated)));
  await shot('R6_settings_ru');

  // Ayarlar'dan baska dile gecis -> tepsi takip eder
  await js(`const s = [...document.querySelectorAll('.modal select')][0]; s.value = 'de'; s.dispatchEvent(new Event('change')); true`);
  await waitFor(`i18n.lang === 'de'`);
  await sleep(200);
  check('tray follows language change from Settings (de)', tray().lang === 'de' && tray().quit === 'Beenden', JSON.stringify(tray()));
  await js(`const s = [...document.querySelectorAll('.modal select')][0]; s.value = 'ru'; s.dispatchEvent(new Event('change')); true`);
  await waitFor(`i18n.lang === 'ru'`);
  await sleep(200);
  check('back to Russian -> tray Russian', tray().lang === 'ru' && tray().quit === ru.tray_quit);

  // kilit ekrani Rusca
  await js(`closeAllModals(); lockNow(); true`);
  await waitFor(`state.data === null`);
  check('lock screen in Russian', await js(`document.querySelector('#auth-submit').textContent === ${JSON.stringify(ru.btn_open_vault)} && document.querySelector('#auth-restore').textContent.includes(${JSON.stringify(ru.backup_import_btn)})`));
  check('lock screen: no untranslated keys', (await js(untranslated)).length === 0);
  await shot('R7_lock_ru');

  // yedekten geri yukleme dili degistirirse tepsi de degisir
  const bk = path.join(DATA, 'tr-backup.vault');
  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  await js(`vd.updateSettings({ language: 'tr' }); true`); await sleep(300);
  process.env.VAULTDESK_TEST_SAVE_PATH = bk;
  await js(`vd.exportBackup(state.data).then(() => vd.updateSettings({ language: 'ru' })); true`);
  await sleep(1200);
  delete process.env.VAULTDESK_TEST_SAVE_PATH;
  check('tray Russian again', tray().lang === 'ru');
  process.env.VAULTDESK_TEST_OPEN_PATH = bk;
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await js(`const m = [...document.querySelectorAll('.modal')].pop(); m.querySelector('input[type=password]').value = 'test1234'; m.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!![...document.querySelectorAll('.modal')].pop().querySelector('.radio-group')`);
  await js(`[...document.querySelectorAll('.modal')].pop().querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`i18n.lang === 'tr'`);
  await sleep(300);
  check('restoring backup settings switches tray language (tr)', tray().lang === 'tr' && tray().quit === 'Çıkış', JSON.stringify(tray()));
  delete process.env.VAULTDESK_TEST_OPEN_PATH;

  check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(log.join('\n'));
  app.isQuitting = true;
  app.exit(0);
}).catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
