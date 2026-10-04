'use strict';
/* v1 kurulumunda bulunan kasayi ("Bu kasayi kullan") tasima testi. Ornek kasa klasoru kendisi uretilir.
 * Kullanim: electron test/e2e-legacy.js <cikti> */
const path = require('path');
const fs = require('fs');
const os = require('os');
const fx = require('./fixtures');
const OUT = path.resolve(process.argv[2]);
const PASSWORD = 'Eski-Kasa 2026';
fs.mkdirSync(OUT, { recursive: true });
process.env.VAULTDESK_LEGACY_DIR = fx.writeV1Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'vd-legacy-src-')), PASSWORD,
  fx.v1Data({ sosyal_medya: [fx.rec('Eski Kayıt', 'Eski-şifre')] }),
  { language: 'tr', autolock_minutes: 15, theme: 'violet', license_verified: true });
process.env.VAULTDESK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-legacy-target-'));
const { app, BrowserWindow } = require('electron');
require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const check = (n, c, x = '') => log.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? '  (' + x + ')' : ''}`);

app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(50); }
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await sleep(600);
  const js = async (code) => {
    const r = await wc.executeJavaScript(`try { ${code}\n } catch (e) { ({ __err: String((e && e.stack) || e) }) }`, true);
    if (r && r.__err) throw new Error(r.__err);
    return r;
  };
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await wc.capturePage()).toPNG());
  check('legacy vault offered on setup screen', await js(`!document.querySelector('#auth-use-legacy').classList.contains('hidden')`));
  await shot('L1_setup_with_legacy');
  await js(`document.querySelector('#auth-use-legacy').click(); true`);
  await sleep(1200);
  await js(`closeAllModals(); true`);
  check('switched to unlock screen', await js(`state.vaultExists && document.querySelector('#auth-password2').classList.contains('hidden')`));
  check('legacy settings carried over (language)', await js(`i18n.lang`) === 'tr', await js(`i18n.lang`));
  await js(`document.querySelector('#auth-password').value=${JSON.stringify(PASSWORD)}; document.querySelector('#auth-submit').click(); true`);
  for (let i = 0; i < 60 && !(await js(`!!state.data`)); i++) await sleep(100);
  const summary = await js(`JSON.stringify(state.data.categories.map((c) => [c.name, state.data.entries[c.id].map((e) => e.site + '/' + e.sifre)]))`);
  check('old vault opens with its master password', !!summary && summary.includes('Eski-şifre'), summary);
  await shot('L2_dashboard_after_import');
  await js(`openSettings(); true`); await sleep(350);
  await shot('L3_settings');
  console.log(log.join('\n'));
  app.isQuitting = true;
  app.exit(0);
}).catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
