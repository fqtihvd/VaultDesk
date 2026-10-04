'use strict';
/* Site ikonu (favicon) testi — GERCEK ag istegi yapar. Kullanim: electron test/e2e-icons.js <cikti> */
const path = require('path');
const fs = require('fs');
const os = require('os');
const OUT = path.resolve(process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-icons-e2e-'));
process.env.VAULTDESK_DATA_DIR = DATA;
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ language: 'tr', theme: 'dark' }));

const { app, BrowserWindow } = require('electron');
require('../main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const check = (n, c, x = '') => log.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? '  (' + x + ')' : ''}`);
const fetches = () => global.__vaultdeskIconFetches;

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
  const shot = async (n) => { await sleep(450); fs.writeFileSync(path.join(OUT, n + '.png'), (await wc.capturePage()).toPNG()); };
  const waitFor = async (code, ms = 12000) => { for (let i = 0; i < ms / 100; i++) { if (await js(code)) return true; await sleep(100); } return false; };
  const rowIcon = (site) => `(() => { const r = [...document.querySelectorAll('.rec')].find((n) => n.querySelector('.rec-site').textContent === ${JSON.stringify(site)}); const a = r && r.querySelector('.avatar'); return a ? (a.classList.contains('has-icon') ? 'icon' : a.classList.contains('icon-emoji') ? 'emoji:' + a.textContent : 'letter:' + a.textContent) : 'none'; })()`;

  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-password2').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  await js(`(() => { const id = state.data.categories[0].id; const add = (site, extra = {}) => state.data.entries[id].push({ id: newId(), site, kullanici: 'u', eposta: '', sifre: 'p', ek_bilgi: '', ...extra });
    add('instagram.com'); add('spotify.com'); add('GitHub', { ek_bilgi: 'https://github.com/login' }); add('Banka Hesabı');
    add('bu-alan-adi-yok-xq83.com'); add('Oyun Hesabı', { icon: '🎮' }); add('192.168.1.1'); persist(); openCategory(id); return true; })()`);
  check('real logos fetched for instagram / spotify / github (from notes URL)',
    await waitFor(`${rowIcon('instagram.com')} === 'icon' && ${rowIcon('spotify.com')} === 'icon' && ${rowIcon('GitHub')} === 'icon'`));
  await sleep(1500);
  check('name only -> initial letter (no request)', (await js(rowIcon('Banka Hesabı'))) === 'letter:B');
  check('unknown domain (404) -> initial letter', (await js(rowIcon('bu-alan-adi-yok-xq83.com'))) === 'letter:B');
  check('IP address -> initial letter (never sent)', (await js(rowIcon('192.168.1.1'))) === 'letter:1');
  check('custom emoji wins', (await js(rowIcon('Oyun Hesabı'))) === 'emoji:🎮');
  check('exactly 4 domains requested (instagram, spotify, github, unknown)', fetches() === 4, String(fetches()));
  await shot('I1_category_dark');

  // sifreli onbellek
  await sleep(2200);
  const enc = fs.existsSync(path.join(DATA, 'icons.enc')) ? fs.readFileSync(path.join(DATA, 'icons.enc'), 'utf8') : '';
  check('icon cache written encrypted (no domain / image in plain text)', enc.startsWith('gAAAAA') && !/instagram|spotify|github|iVBOR|data:image/.test(enc));

  // kilitle -> bellek temizlenir; yeniden ac -> onbellekten, yeni istek yok
  await js(`lockNow(); true`);
  await waitFor(`state.data === null`);
  check('lock clears in-memory icons', await js(`icons.size === 0`));
  const before = fetches();
  await js(`document.querySelector('#auth-password').value='test1234'; document.querySelector('#auth-submit').click(); true`);
  await waitFor(`!!state.data`);
  await js(`openCategory(state.data.categories[0].id); true`);
  check('after unlock icons come from encrypted cache', await waitFor(`${rowIcon('instagram.com')} === 'icon' && ${rowIcon('GitHub')} === 'icon'`));
  await sleep(800);
  check('no new network requests after unlock', fetches() === before, `${before} -> ${fetches()}`);

  // kayit formu: canli onizleme + emoji secimi + otomatige donus
  await js(`openEntryForm(state.view.id, null); true`); await sleep(200);
  await js(`const s = document.querySelector('.modal input'); s.value = 'netflix.com'; s.dispatchEvent(new Event('input')); true`);
  check('entry form live preview fetches logo', await waitFor(`!!document.querySelector('.entry-icon-preview.has-icon img')`));
  check('hint names the domain', await js(`document.querySelector('.entry-icon-hint').textContent.includes('netflix.com')`));
  await shot('I2_entry_form_preview');
  await js(`[...document.querySelectorAll('.entry-icon-row button')][0].click(); true`);
  await waitFor(`!!document.querySelector('.emoji-grid button')`);
  await js(`[...document.querySelectorAll('.modal')].pop().querySelector('.emoji-grid button').click(); true`);
  await sleep(150);
  check('emoji chosen in form', await js(`!!document.querySelector('.entry-icon-preview.icon-emoji')`));
  await shot('I3_entry_form_emoji');
  await js(`document.querySelector('.modal .modal-actions .btn-primary').click(); true`);
  await sleep(300);
  check('saved record keeps chosen emoji', (await js(rowIcon('netflix.com'))).startsWith('emoji:'));
  await js(`openEntryForm(state.view.id, entriesOf(state.view.id).find((e) => e.site === 'netflix.com')); true`); await sleep(200);
  await js(`[...document.querySelectorAll('.entry-icon-row button')][1].click(); document.querySelector('.modal .modal-actions .btn-primary').click(); true`);
  check('"Automatic" removes emoji -> logo again', await waitFor(`${rowIcon('netflix.com')} === 'icon' && !('icon' in entriesOf(state.view.id).find((e) => e.site === 'netflix.com'))`));

  // palet
  await js(`openPalette(); palette.input.value = 'insta'; runPaletteSearch(); true`);
  check('palette shows site logo', await waitFor(`!!document.querySelector('.cmdk-item .cmdk-item-icon.has-icon img')`));
  await shot('I4_palette');
  await js(`closePalette(); applyTheme('light', { animate: false }); true`);
  await shot('I5_category_light');

  // ayar kapali -> hic istek yok, bas harfler
  await js(`openSettings(); true`); await sleep(300);
  await shot('I6_settings');
  await js(`const cb = [...document.querySelectorAll('.modal .check input')][0]; cb.checked = false; cb.dispatchEvent(new Event('change')); true`);
  await sleep(300);
  await js(`closeAllModals(); true`);
  const off = fetches();
  await js(`state.data.entries[state.view.id].push({ id: newId(), site: 'twitch.tv', kullanici: '', eposta: '', sifre: 'x', ek_bilgi: '' }); persist(); renderRecords(); true`);
  await sleep(1500);
  check('setting off: letters only, no new requests', (await js(rowIcon('instagram.com'))).startsWith('letter:') && (await js(rowIcon('twitch.tv'))) === 'letter:T' && fetches() === off, `${off} -> ${fetches()}`);
  check('setting persisted', JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).fetch_icons === false);

  check('no renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(log.join('\n'));
  app.isQuitting = true;
  app.exit(0);
}).catch((e) => { console.error('E2E ERROR', e); app.exit(1); });
