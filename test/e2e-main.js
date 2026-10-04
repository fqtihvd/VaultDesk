'use strict';
/* Uctan uca test: gecici veri klasoruyle gercek main.js'i baslatir, arayuzu sayfa icinden surer,
 * yalnizca uygulama penceresinin goruntusunu alir (webContents.capturePage).
 * Kullanim: electron test/e2e-main.js <cikti_klasoru> [senaryo]   */
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'vd-e2e'));
const SCENARIO = process.argv[3] || 'full';
fs.mkdirSync(OUT, { recursive: true });
const DATA = process.env.VAULTDESK_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vd-e2e-data-'));
process.env.VAULTDESK_DATA_DIR = DATA;

const { app, BrowserWindow } = require('electron');
require('../main.js');

const log = [];
const check = (name, cond, extra = '') => log.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  (' + extra + ')' : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(50); }
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await sleep(500);
  const js = async (code) => {
    const r = await wc.executeJavaScript(`try { ${code}\n } catch (e) { ({ __err: String((e && e.stack) || e) }) }`, true);
    if (r && r.__err) throw new Error('renderer: ' + r.__err + '\n  in: ' + code.slice(0, 160));
    return r;
  };
  const shot = async (name) => fs.writeFileSync(path.join(OUT, name + '.png'), (await wc.capturePage()).toPNG());
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });

  // uzun gorev (>50 ms) izleyici: donma olcumu
  await js(`window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); true`);

  await shot('01_setup');
  check('setup screen shown', await js(`!document.querySelector('#screen-auth').classList.contains('hidden') && !document.querySelector('#auth-password2').classList.contains('hidden')`));

  // kasa olustur
  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-password2').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  for (let i = 0; i < 60 && !(await js(`!!state.data`)); i++) await sleep(100);
  check('vault created + dashboard', await js(`!document.querySelector('#screen-main').classList.contains('hidden') && document.querySelectorAll('.cat-card[data-cat]').length === 5`));
  check('vault files on disk', fs.existsSync(path.join(DATA, 'vault.enc')) && fs.existsSync(path.join(DATA, 'salt.bin')));

  // ornek kayitlar
  await js(`(() => {
    const sites = ['GitHub','Gmail','Steam','Netflix','Discord','Amazon'];
    state.data.categories.forEach((c, ci) => {
      for (let j = 0; j < (ci * 2) % 6 + 1; j++) state.data.entries[c.id].push({ id: newId(), site: sites[j], kullanici: 'user' + j, eposta: 'u' + j + '@example.com', sifre: 'S3cret!pass' + j, ek_bilgi: j ? '' : 'not' });
    });
    persist(); renderView(); return true; })()`);
  await sleep(400);
  for (const th of ['dark', 'light', 'violet']) {
    await js(`applyTheme('${th}', { animate: false }); true`);
    await sleep(350);
    await shot(`02_dashboard_${th}`);
  }
  await js(`applyTheme('dark', { animate: false }); true`);

  // tema gecisi: view transition + uzun gorev olcumu
  await js(`window.__long.length = 0; true`);
  for (const th of ['light', 'violet', 'dark', 'light', 'violet', 'dark']) { await js(`applyTheme('${th}'); true`); await sleep(420); }
  const themeLong = await js(`window.__long.slice()`);
  check('theme switch x6: no long task >100ms', !themeLong.some((d) => d > 100), 'long tasks: ' + JSON.stringify(themeLong));
  check('theme persisted', JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).theme === 'dark');

  // Ctrl+K -> palet
  await js(`window.__long.length = 0; true`);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
  await sleep(250);
  check('Ctrl+K opens palette w/ focus', await js(`!!palette && document.activeElement === palette.input`));
  await js(`window.__inputs = 0; palette.input.addEventListener('input', () => window.__inputs++); window.__runs = []; { const orig = runPaletteSearch; window.runPaletteSearch = function () { window.__runs.push(palette && palette.input.value); return orig(); }; } true`);
  for (const ch of 'git') {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(40);
  }
  log.push('  (input events fired: ' + (await js(`window.__inputs`)) + ')');
  await sleep(250);
  check('typing searches all categories', await js(`palette.input.value === 'git' && palette.items.filter((x) => x.kind === 'entry').length === 5`),
    await js(`JSON.stringify({ runs: window.__runs, v: palette.input.value, n: palette.items.length, e: palette.items.filter((x) => x.kind === 'entry').map((x) => x.entry.site), sites: Object.values(state.data.entries).map((l) => l.map((e) => e.site)) })`));
  await shot('03_palette_dark');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); await sleep(60);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); await sleep(400);
  check('Enter reveals record in its category', await js(`state.view.name === 'category' && document.querySelectorAll('.rec.open').length === 1 && !palette`));
  await shot('04_category_dark');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await js(`openPalette(); true`); await sleep(150);
  await js(`document.querySelector('.cmdk-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
  check('click outside closes palette', await js(`!palette`));
  const palLong = await js(`window.__long.slice()`);
  check('palette: no long task >100ms', !palLong.some((d) => d > 100), 'long tasks: ' + JSON.stringify(palLong));

  // arama tetikleyici (tiklama)
  await js(`document.querySelector('#search-trigger').click(); true`); await sleep(150);
  check('search bar click opens palette', await js(`!!palette`));
  await js(`closePalette(); true`);

  // kayit formu + sifre gosterme/gizleme + uretici
  await js(`openEntryForm(state.view.id, null); true`); await sleep(250);
  await shot('05_entry_form');
  check('entry form eye toggles password', await js(`(() => { const pw = document.querySelector('.pw-row input'); const eye = document.querySelector('.pw-row button'); eye.click(); const a = pw.type; eye.click(); return a === 'text' && pw.type === 'password'; })()`));
  await js(`document.querySelector('.pw-row button:nth-child(3)').click(); true`); await sleep(200);
  await shot('06_generator');
  await js(`[...document.querySelectorAll('.modal')].pop().querySelector('.btn-primary').click(); true`); await sleep(150);
  check('generator fills password (16 chars)', await js(`document.querySelector('.pw-row input').value.length === 16`));
  await js(`(() => { const ins = document.querySelectorAll('.modal input'); ins[0].value = 'Yeni Site'; document.querySelector('.modal .modal-actions .btn-primary').click(); return true; })()`);
  await sleep(300);
  check('record added', await js(`entriesOf(state.view.id).some((e) => e.site === 'Yeni Site')`));

  // ayarlar
  await js(`openSettings(); true`); await sleep(300);
  await shot('07_settings_dark');
  await js(`applyTheme('violet', { animate: false }); true`); await sleep(300);
  await shot('08_settings_violet');
  await js(`closeAllModals(); applyTheme('light', { animate: false }); true`); await sleep(300);
  await shot('09_category_light');

  // kilitle + yeniden ac
  await js(`lockNow(); true`); await sleep(300);
  await shot('10_login_light');
  check('locked -> login', await js(`state.data === null && !document.querySelector('#auth-password2').offsetParent`));
  await js(`document.querySelector('#auth-password').value='yanlis'; document.querySelector('#auth-submit').click(); true`);
  for (let i = 0; i < 60 && (await js(`document.querySelector('#auth-error').classList.contains('hidden')`)); i++) await sleep(100);
  check('wrong password rejected', await js(`!document.querySelector('#auth-error').classList.contains('hidden')`));
  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  for (let i = 0; i < 60 && !(await js(`!!state.data`)); i++) await sleep(100);
  check('unlock restores saved data', await js(`Object.values(state.data.entries).flat().some((e) => e.site === 'Yeni Site')`));

  check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  fs.writeFileSync(path.join(OUT, 'result.txt'), log.join('\n') + `\nDATA=${DATA}\n`);
  console.log(log.join('\n'));
  console.log('DATA=' + DATA);
  app.isQuitting = true;
  app.exit(0);
}

run().catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
