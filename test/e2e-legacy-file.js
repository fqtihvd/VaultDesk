'use strict';
/* Eski kasa dosyasi (vault.enc + salt.bin) akilli tanima testi. Ornek dosyalar kendisi uretilir.
 * Kullanim: electron test/e2e-legacy-file.js <cikti> */
const path = require('path');
const fs = require('fs');
const os = require('os');
const fx = require('./fixtures');
const OUT = path.resolve(process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-legacyfile-fx-'));
const PY_PW = 'Eski Kasa Şifresi!';
const OLD_PW = 'eski-2025';
const PY_DIR = fx.writeV1Vault(path.join(FX, 'v1'), PY_PW, fx.v1Data({
  sosyal_medya: [fx.rec('Eski Şifre 1', 'çok-gizli-1', { eposta: 'a@b.c', ek_bilgi: 'not' })],
  yapay_zeka: [fx.rec('Eski Şifre 2', 'çok-gizli-2')],
}), { language: 'tr', theme: 'violet', autolock_minutes: 15, license_verified: true });
const NO_SALT_DIR = path.join(FX, 'nosalt');
fs.mkdirSync(NO_SALT_DIR);
fs.copyFileSync(path.join(PY_DIR, 'vault.enc'), path.join(NO_SALT_DIR, 'vault.enc'));
// cok eski bicim: kategori listesi yok, dogrudan { kategori_id: [kayitlar] }
const OLD_DIR = fx.writeV1Vault(path.join(FX, 'old'), OLD_PW, { sosyal_medya: [{ id: 'o1', site: 'Çok Eski Kayıt', kullanici: 'x', eposta: '', sifre: 'o', ek_bilgi: '' }] });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-legacyfile-e2e-'));
const DATA = path.join(WORK, 'data');
process.env.VAULTDESK_DATA_DIR = DATA;

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
  const top = `[...document.querySelectorAll('.modal')].pop()`;
  const sites = `Object.values(state.data.entries).flat().map((e) => e.site)`;
  const enterPassword = async (pw) => {
    await js(`${top}.querySelector('input[type=password]').value = ${JSON.stringify(pw)}; ${top}.querySelector('.modal-actions .btn-primary').click(); true`);
  };

  // Electron kasasi (farkli ana sifreyle)
  await js(`document.querySelector('#auth-password').value='Yeni-Kasa-1'; document.querySelector('#auth-password2').value='Yeni-Kasa-1'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  await js(`state.data.entries[state.data.categories[0].id].push({ id: newId(), site: 'Electron Kaydı', kullanici: '', eposta: '', sifre: 'e', ek_bilgi: '' }); persist(); true`);

  // A) Ayarlar -> Yedekten Ice Aktar -> vault.enc
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(PY_DIR, 'vault.enc');
  await js(`openRestore('open'); true`);
  check('vault.enc accepted (no "invalid backup")', await waitFor(`!!document.querySelector('.backup-file')`));
  check('shows old-vault label + folder', await js(`${top}.querySelector('.backup-file').textContent.includes(t('backup_legacy_vault_label'))`));
  await enterPassword(PY_PW);
  await waitFor(`!!${top}.querySelector('.radio-group')`);
  await shot('F1_vault_enc_detected');
  check('decrypted with salt.bin from same folder', await js(`${top}.querySelector('.backup-stats').textContent.length > 0`), await js(`${top}.querySelector('.backup-stats').textContent`));
  check('folder settings.json offered', await js(`!!${top}.querySelector('.check input')`));
  await js(`${top}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!document.querySelector('.modal-text')`);
  const afterMerge = await js(`JSON.stringify(${sites})`);
  check('all old-vault passwords imported (merge)', afterMerge.includes('Eski Şifre 1') && afterMerge.includes('Eski Şifre 2') && afterMerge.includes('Electron Kaydı'), afterMerge);
  check('old record password intact', await js(`Object.values(state.data.entries).flat().find((e) => e.site === 'Eski Şifre 2').sifre === 'çok-gizli-2'`));
  check('settings applied (tr, violet, 15 min)', await js(`i18n.lang === 'tr' && document.documentElement.dataset.theme === 'violet' && state.settings.autolock_minutes === 15`));
  await shot('F2_merged');
  await js(`closeAllModals(); true`);

  // B) salt.bin secilirse yanindaki vault.enc kullanilir
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(PY_DIR, 'salt.bin');
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await enterPassword(PY_PW);
  check('salt.bin selection works too', await waitFor(`!!${top}.querySelector('.radio-group')`));
  await js(`closeAllModals(); true`);

  // C) salt.bin eksik -> acik mesaj
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(NO_SALT_DIR, 'vault.enc');
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.modal-text')`);
  check('missing salt.bin -> specific message', await js(`document.querySelector('.modal-text').textContent === t('backup_missing_salt')`));
  await shot('F3_missing_salt');
  await js(`closeAllModals(); true`);

  // D) yanlis sifre
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(PY_DIR, 'vault.enc');
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await enterPassword('yanlis');
  check('wrong password for old vault rejected', await waitFor(`!${top}.querySelector('.error').classList.contains('hidden')`));
  await js(`closeAllModals(); true`);

  // E) cok eski v1 kasa bicimi (kategoriler kodda sabitken: { sosyal_medya: [...] })
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(OLD_DIR, 'vault.enc');
  await js(`openRestore('open'); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await enterPassword(OLD_PW);
  await waitFor(`!!${top}.querySelector('.radio-group')`);
  await js(`${top}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!document.querySelector('.modal-text')`);
  check('very old v1 vault format migrated', await js(`${sites}.includes('Çok Eski Kayıt')`));
  await js(`closeAllModals(); true`);

  // F) temiz kurulum: giris ekranindan vault.enc ile kasa kur -> eski sifreyle acilir
  await js(`lockNow(); true`);
  await waitFor(`state.data === null`);
  fs.rmSync(DATA, { recursive: true, force: true });
  await js(`state.vaultExists = false; showAuth(); true`);
  process.env.VAULTDESK_TEST_OPEN_PATH = path.join(PY_DIR, 'vault.enc');
  await js(`document.querySelector('#auth-restore').click(); true`);
  await waitFor(`!!document.querySelector('.backup-file')`);
  await enterPassword(PY_PW);
  await waitFor(`!!${top}.querySelector('.notice')`);
  await shot('F4_login_from_vault_enc');
  await js(`${top}.querySelector('.modal-actions .btn-primary').click(); true`);
  await waitFor(`!!state.data`);
  check('fresh install: vault rebuilt from vault.enc', await js(`${sites}.includes('Eski Şifre 1')`));
  await js(`closeAllModals(); lockNow(); true`);
  await waitFor(`state.data === null`);
  await js(`document.querySelector('#auth-password').value=${JSON.stringify(PY_PW)}; document.querySelector('#auth-submit').click(); true`);
  check('unlocks with the old master password', await waitFor(`!!state.data`));
  check('source files untouched', fs.existsSync(path.join(PY_DIR, 'vault.enc')) && fs.existsSync(path.join(PY_DIR, 'salt.bin')));
  delete process.env.VAULTDESK_TEST_OPEN_PATH;

  check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(log.join('\n'));
  console.log('DATA=' + DATA);
  app.isQuitting = true;
  app.exit(0);
}).catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
