'use strict';
/* Yedekleme / geri yukleme uctan uca testi.
 * Kullanim: electron test/e2e-backup.js <cikti_klasoru> */
const path = require('path');
const fs = require('fs');
const os = require('os');

const fx = require('./fixtures');
const OUT = path.resolve(process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-backup-e2e-'));
const V1_PASSWORD = 'v1-Sifre';
const V1_FILE = fx.writeV1Export(path.join(WORK, 'v1_export.json'), V1_PASSWORD,
  fx.v1Data({ karisik: [fx.rec('v1 Kaydı', 'v1-şifre')] }));
const DATA = path.join(WORK, 'data');
process.env.VAULTDESK_DATA_DIR = DATA;
const BACKUP = path.join(WORK, 'VaultDesk-Backup-test.vault');

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
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  const js = async (code) => {
    const r = await wc.executeJavaScript(`try { ${code}\n } catch (e) { ({ __err: String((e && e.stack) || e) }) }`, true);
    if (r && r.__err) throw new Error(r.__err + '\n in: ' + code.slice(0, 120));
    return r;
  };
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), (await wc.capturePage()).toPNG());
  const waitFor = async (code, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await js(code)) return true; await sleep(100); } return false; };
  const topModal = `[...document.querySelectorAll('.modal')].pop()`;
  const total = `Object.values(state.data.entries).reduce((n, l) => n + l.length, 0)`;

  // --- 1) kasa olustur + ornek veri + ayar ---
  await js(`document.querySelector('#auth-password').value='Orijinal-1'; document.querySelector('#auth-password2').value='Orijinal-1'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  await js(`(() => { state.data.categories.forEach((c, i) => { for (let j = 0; j <= i; j++) state.data.entries[c.id].push({ id: newId(), site: 'Site-' + i + '-' + j, kullanici: 'u' + j, eposta: '', sifre: 'GizliSifre' + i + j, ek_bilgi: '' }); }); persist(); renderView(); return true; })()`);
  await js(`applyTheme('violet', { animate: false }); vd.updateSettings({ autolock_minutes: 15 }); state.settings.autolock_minutes = 15; true`);
  await sleep(400);
  const original = await js(total);

  // --- 2) disa aktar ---
  process.env.VAULTDESK_TEST_SAVE_PATH = BACKUP;
  await js(`openSettings(); true`); await sleep(350);
  await shot('B1_settings_backup');
  await js(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes(t('backup_export_btn'))).click(); true`);
  await waitFor(`document.querySelectorAll('.modal').length === 2`);
  await shot('B2_export_done');
  delete process.env.VAULTDESK_TEST_SAVE_PATH;
  const fileText = fs.existsSync(BACKUP) ? fs.readFileSync(BACKUP, 'utf8') : '';
  let file = {};
  try { file = JSON.parse(fileText); } catch {}
  check('backup file written (vaultdesk-backup-v2)', file.format === 'vaultdesk-backup-v2' && !!file.createdAt, file.format);
  check('backup contains no plaintext records', fileText.length > 0 && !/Site-|GizliSifre|u0/.test(fileText));
  await js(`closeAllModals(); true`);

  // --- 3) Ayarlar'dan: yanlis sifre, birlestir, yerine koy ---
  await js(`state.data.entries[state.data.categories[0].id].push({ id: newId(), site: 'Yedekten-Sonra', kullanici: '', eposta: '', sifre: 'x', ek_bilgi: '' }); persist(); true`);
  process.env.VAULTDESK_TEST_OPEN_PATH = BACKUP;
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await js(`${topModal}.querySelector('input[type=password]').value = 'yanlis'; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!${topModal}.querySelector('.error').classList.contains('hidden')`);
  check('wrong backup password rejected', await js(`${topModal}.querySelector('.error').textContent === t('backup_wrong_password')`));
  await js(`${topModal}.querySelector('input[type=password]').value = 'Orijinal-1'; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!${topModal}.querySelector('.radio-group')`);
  await shot('B3_restore_options');
  check('backup stats shown', await js(`${topModal}.querySelector('.backup-stats').textContent.includes('${original}')`));
  await js(`${topModal}.querySelector('.modal-actions .btn-primary').click(); true`); // birlestir (varsayilan)
  await waitFor(`!!document.querySelector('.modal-text')`);
  check('merge: no duplicates, newer record kept', await js(`${total} === ${original + 1} && Object.values(state.data.entries).flat().some((e) => e.site === 'Yedekten-Sonra')`), String(await js(total)));
  await js(`closeAllModals(); true`);

  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await js(`${topModal}.querySelector('input[type=password]').value = 'Orijinal-1'; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!${topModal}.querySelector('.radio-group')`);
  await js(`${topModal}.querySelector('input[value=replace]').checked = true; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!document.querySelectorAll('.modal')[1]`); // onay
  await js(`${topModal}.querySelector('.btn-danger').click(); true`);
  await waitFor(`!!document.querySelector('.modal-text') && document.querySelectorAll('.modal').length === 1 && ${total} === ${original}`);
  await shot('B4_replace_done');
  check('replace: vault equals backup', await js(`${total} === ${original} && !Object.values(state.data.entries).flat().some((e) => e.site === 'Yedekten-Sonra')`));
  const safetyDirs = fs.existsSync(path.join(DATA, 'backups')) ? fs.readdirSync(path.join(DATA, 'backups')) : [];
  check('safety copy of previous vault created', safetyDirs.length === 1 && fs.existsSync(path.join(DATA, 'backups', safetyDirs[0], 'vault.enc')));
  await js(`closeAllModals(); true`);

  // --- 4) v1 sifreli disa aktarimi (birlestir) ---
  if (V1_FILE) {
    process.env.VAULTDESK_TEST_OPEN_PATH = V1_FILE;
    await js(`openRestore('open'); true`);
    await waitFor(`!!document.querySelector('.backup-file')`);
    await js(`${topModal}.querySelector('input[type=password]').value = ${JSON.stringify(V1_PASSWORD)}; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
    await waitFor(`!!${topModal}.querySelector('.radio-group')`);
    await js(`${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
    await waitFor(`!!document.querySelector('.modal-text')`);
    check('v1 encrypted export restores (merge)', await js(`Object.values(state.data.entries).flat().some((e) => e.site === 'v1 Kaydı')`));
    await js(`closeAllModals(); true`);
    process.env.VAULTDESK_TEST_OPEN_PATH = BACKUP;
  }

  // --- 5) giris ekranindan: kasa varken yedekle degistir (yedegin sifresi gecerli olur) ---
  await js(`applyTheme('light', { animate: false }); true`); await sleep(200);
  await js(`state.data.entries[state.data.categories[1].id].push({ id: newId(), site: 'Silinecek', kullanici: '', eposta: '', sifre: 'x', ek_bilgi: '' }); persist(); lockNow(); true`);
  await waitFor(`state.data === null`);
  check('restore button on login screen', await js(`!!document.querySelector('#auth-restore').offsetParent`));
  await shot('B5_login_restore_button');
  await js(`document.querySelector('#auth-restore').click(); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await js(`${topModal}.querySelector('input[type=password]').value = 'Orijinal-1'; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!${topModal}.querySelector('.notice')`);
  await shot('B6_login_restore_warning');
  await js(`${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!state.data`);
  check('login restore opens vault from backup', await js(`${total} === ${original} && !Object.values(state.data.entries).flat().some((e) => e.site === 'Silinecek')`));
  check('backup settings applied (theme, auto-lock)', await js(`document.documentElement.dataset.theme === 'violet' && state.settings.autolock_minutes === 15`));
  await js(`closeAllModals(); lockNow(); true`);
  await waitFor(`state.data === null`);
  await js(`document.querySelector('#auth-password').value='Orijinal-1'; document.querySelector('#auth-submit').click(); true`);
  check('restored vault unlocks with backup password', await waitFor(`!!state.data`));

  // --- 6) hic kasa yokken (temiz kurulum) yedekten kurulum ---
  await js(`closeAllModals(); lockNow(); true`);
  await waitFor(`state.data === null`);
  fs.rmSync(DATA, { recursive: true, force: true });
  await js(`state.vaultExists = false; showAuth(); true`);
  await js(`document.querySelector('#auth-restore').click(); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await js(`${topModal}.querySelector('input[type=password]').value = 'Orijinal-1'; ${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!${topModal}.querySelector('.notice')`);
  check('fresh install: new-vault notice', await js(`${topModal}.querySelector('.notice').textContent === t('backup_new_vault_info')`));
  await js(`${topModal}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!state.data`);
  check('fresh install: vault created from backup', await js(`${total} === ${original}`) && fs.existsSync(path.join(DATA, 'vault.enc')));
  delete process.env.VAULTDESK_TEST_OPEN_PATH;

  check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  fs.writeFileSync(path.join(OUT, 'backup_result.txt'), log.join('\n') + `\nWORK=${WORK}\n`);
  console.log(log.join('\n'));
  console.log('WORK=' + WORK);
  app.isQuitting = true;
  app.exit(0);
}).catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
