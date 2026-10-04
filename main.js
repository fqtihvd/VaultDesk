'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, clipboard, powerMonitor, session, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const https = require('https');
const vc = require('./vault-crypto');
const csv = require('./csv');
const domainHelper = require('./src/domain.js');

// ---------------------------------------------------------------------
// Konumlar
// ---------------------------------------------------------------------
// Kasa kullanici veri klasorunde durur (%APPDATA%\VaultDesk\data), kurulum klasorunde DEGIL: electron-builder
// kaldiricisi/guncelleyicisi kurulum klasorunu tamamen siler. Gelistirmede proje icindeki data-dev kullanilir
// Testler VAULTDESK_DATA_DIR ile ayri bir klasor verebilir.
const isDev = !app.isPackaged;
const dataDir = process.env.VAULTDESK_DATA_DIR
  || (isDev ? path.join(__dirname, 'data-dev') : path.join(app.getPath('userData'), 'data'));
const SALT_PATH = path.join(dataDir, 'salt.bin');
const VAULT_PATH = path.join(dataDir, 'vault.enc');
const SETTINGS_PATH = path.join(dataDir, 'settings.json');

// VaultDesk v1'in (eski masaustu surumu) kasasini exe'nin yanindaki data\ klasorunde tuttugu kurulum yeri.
// (VAULTDESK_LEGACY_DIR yalnizca testler icindir.)
const LEGACY_DIRS = process.env.VAULTDESK_LEGACY_DIR
  ? [process.env.VAULTDESK_LEGACY_DIR]
  : [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'VaultDesk Pro', 'data')];

const ASSETS = path.join(__dirname, 'src', 'assets');
const APP_NAME = 'VaultDesk Pro';
const UI_THEMES = ['dark', 'light', 'violet'];
const AUTOLOCK_CHOICES = [1, 5, 15, 30, 0];
// Pencerenin kendi zemini temaya esit: sayfa boyanmadan once baska bir renk asla gorunmez (parlama yok).
const THEME_BACKGROUNDS = { dark: '#0f1117', light: '#f5f6f8', violet: '#110e1d' };
const DEFAULT_SETTINGS = { language: 'en', theme: 'dark', autolock_minutes: 5, fetch_icons: true };

const appConfig = (() => {
  const defaults = { require_license: false, provider: 'gumroad', gumroad_product_id: '', payhip_product_link: '' };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'app.config.json'), 'utf8')) }; }
  catch { return defaults; }
})();

// ---------------------------------------------------------------------
// Dosya yardimcilari
// ---------------------------------------------------------------------
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Gecici dosyaya yaz + fsync + rename: yazma sirasinda cokme olsa bile eski dosya bozulmaz. */
async function atomicWrite(p, payload) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // her yazim kendi gecici dosyasini kullanir: es zamanli iki yazim birbirinin .tmp'sini tasiyamaz
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(payload);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, p);
}

// Kasa yazimlari sirayla yapilir (ust uste kaydetmede yarisma olmaz).
let writeChain = Promise.resolve();
function queueWrite(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) };
  if (!UI_THEMES.includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  if (!AUTOLOCK_CHOICES.includes(s.autolock_minutes)) s.autolock_minutes = DEFAULT_SETTINGS.autolock_minutes;
  s.fetch_icons = s.fetch_icons !== false;
  return s;
}

function vaultExists(dir = dataDir) {
  return fs.existsSync(path.join(dir, 'vault.enc')) && fs.existsSync(path.join(dir, 'salt.bin'));
}

function findLegacyVault() {
  if (vaultExists()) return null;
  return LEGACY_DIRS.find((d) => vaultExists(d)) || null;
}

/** Cok eski (kategorileri kodda sabit) v1 kasalarini yeni yapiya cevirir. */
const DEFAULT_CATEGORY_META = {
  sosyal_medya: { name: 'Social Media', color: '#3B6EF6', icon: '📱' },
  karisik: { name: 'Miscellaneous Sites', color: '#8B5CF6', icon: '🌐' },
  gamedesign: { name: 'Game Design', color: '#F0576B', icon: '🎮' },
  yapay_zeka: { name: 'AI Tools', color: '#22C55E', icon: '🤖' },
  yemek_alisveris: { name: 'Food & Shopping', color: '#F59E0B', icon: '🛒' },
};
function migrateData(data) {
  if (data && Array.isArray(data.categories) && data.entries && typeof data.entries === 'object') {
    for (const c of data.categories) {
      c.color = c.color || '#3B6EF6';
      c.icon = c.icon || '📁';
      if (!Array.isArray(data.entries[c.id])) data.entries[c.id] = [];
    }
    return data;
  }
  const categories = [];
  const entries = {};
  for (const [id, items] of Object.entries(data || {})) {
    categories.push({ id, ...(DEFAULT_CATEGORY_META[id] || { name: id, color: '#3B6EF6', icon: '📁' }) });
    entries[id] = Array.isArray(items) ? items : [];
  }
  return { categories, entries };
}

// ---------------------------------------------------------------------
// Kasa durumu: turetilmis anahtar YALNIZCA ana surecte tutulur.
// ---------------------------------------------------------------------
let vaultKey = null;
let mainWindow = null;
let tray = null;
app.isQuitting = false;

function lockVault(reason) {
  const wasUnlocked = !!vaultKey;
  setVaultKey(null);
  pendingBackups.clear();
  if (wasUnlocked && mainWindow && !mainWindow.isDestroyed()) {
    const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
    mainWindow.webContents.send('vault:locked', { reason, visible });
  }
}

// Otomatik kilit: SISTEM GENELINDE N dakika fare/klavye girdisi yoksa (baska uygulamada calismak "hareketli"
// sayilir). Odak kaybi / Alt+Tab / simge durumu kilitlemez. 0 = Hicbir Zaman.
setInterval(() => {
  if (!vaultKey) return;
  const minutes = getSettings().autolock_minutes;
  if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lockVault('idle');
}, 1000);

// ---------------------------------------------------------------------
// Pencere & tepsi
// ---------------------------------------------------------------------
function appIcon() {
  const ico = nativeImage.createFromPath(path.join(ASSETS, 'logo.ico'));
  return ico.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'logo.png')) : ico;
}

function createWindow() {
  const settings = getSettings();
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: THEME_BACKGROUNDS[settings.theme],
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Arkada kalan pencerede de zamanlayicilar (arama gecikmesi, "Kopyalandi" geri bildirimi) yavaslatilmaz.
      backgroundThrottling: false,
      additionalArguments: [`--vd-theme=${settings.theme}`],
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Ilk kare hazir olunca goster: beyaz/bos pencere hic gorunmez.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Guvenlik: uygulama disina gezinme ve yeni pencere acma engellenir.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // X: kasa kilitlenir ve uygulama sistem tepsisine kuculur.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    lockVault('tray');
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ----- Tepsi menusu: etiketler secili dilin locales/<kod>.json dosyasindan, ana surecte okunur -----
// (arayuz yuklenmeden once de, uygulama tepsiden baslarken de dogru dilde). Dil ayari hangi yoldan
// degisirse degissin (Ayarlar, giris ekrani, yedekten geri yukleme, eski kasa aktarimi) updateSettingsFile
// uzerinden gecer ve menu aninda yeniden kurulur.
const LOCALES_DIR = path.join(__dirname, 'src', 'locales');
const TRAY_FALLBACK = { tray_show: 'Show VaultDesk Pro', tray_lock: 'Lock', tray_quit: 'Quit' };
let trayLang = null;
let trayLabels = { show: TRAY_FALLBACK.tray_show, lock: TRAY_FALLBACK.tray_lock, quit: TRAY_FALLBACK.tray_quit };

function trayLabelsFor(lang) {
  const code = /^[a-z]{2}(_[a-z]{2})?$/.test(String(lang || '')) ? lang : 'en';
  const en = readJson(path.join(LOCALES_DIR, 'en.json'), {});
  const loc = readJson(path.join(LOCALES_DIR, `${code}.json`), {});
  const pick = (k) => loc[k] || en[k] || TRAY_FALLBACK[k];
  return { show: pick('tray_show'), lock: pick('tray_lock'), quit: pick('tray_quit') };
}

function buildTray() {
  if (!tray) {
    tray = new Tray(appIcon());
    tray.setToolTip(APP_NAME);
    tray.on('click', showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabels.show, click: showWindow },
    { label: trayLabels.lock, click: () => { lockVault('tray'); showWindow(); } },
    { type: 'separator' },
    { label: trayLabels.quit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function syncTrayLanguage(lang) {
  if (lang === trayLang && tray) return;
  trayLang = lang;
  trayLabels = trayLabelsFor(lang);
  if (tray) buildTray();
}

// Testler icin: o an tepside gosterilen etiketler
global.__vaultdeskTray = () => ({ lang: trayLang, ...trayLabels });

function logCrash(err) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'crash.log'), `[${new Date().toISOString()}] ${(err && err.stack) || err}\n`);
  } catch {}
}
process.on('uncaughtException', logCrash);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  app.setAppUserModelId('com.devilt.vaultdesk');
  Menu.setApplicationMenu(null);
  // Hicbir web izni (kamera, bildirim, konum...) verilmez.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow();
  trayLang = getSettings().language;
  trayLabels = trayLabelsFor(trayLang);
  buildTray();
}).catch(logCrash);

app.on('before-quit', () => { app.isQuitting = true; setVaultKey(null); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------
ipcMain.handle('app:init', () => ({
  settings: getSettings(),
  vaultExists: vaultExists(),
  legacyVault: findLegacyVault(),
  licenseRequired: !!appConfig.require_license,
  appName: APP_NAME,
  version: app.getVersion(),
  autolockChoices: AUTOLOCK_CHOICES,
}));

// Ayar guncellemeleri sirayla: oku-degistir-yaz adimlari ust uste binip bir degisikligi kaybetmez.
let settingsChain = Promise.resolve();
function updateSettingsFile(patch) {
  const run = settingsChain.then(async () => {
    const s = { ...readJson(SETTINGS_PATH, {}), ...(patch || {}) };
    if (!UI_THEMES.includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
    if (!AUTOLOCK_CHOICES.includes(s.autolock_minutes)) s.autolock_minutes = DEFAULT_SETTINGS.autolock_minutes;
    await atomicWrite(SETTINGS_PATH, JSON.stringify(s, null, 2));
    if (patch && 'language' in patch) syncTrayLanguage(s.language);
    return s;
  });
  settingsChain = run.catch(() => {});
  return run;
}

ipcMain.handle('settings:update', async (_e, patch) => {
  const s = await updateSettingsFile(patch);
  if (patch && 'theme' in patch && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(THEME_BACKGROUNDS[s.theme]);
  }
  return getSettings();
});

ipcMain.handle('vault:create', async (_e, { password, categories }) => {
  if (vaultExists()) return { ok: false, error: 'exists' };
  if (!password || password.length < 4) return { ok: false, error: 'short' };
  const salt = crypto.randomBytes(16);
  const key = await vc.deriveKey(password, salt);
  const cats = (Array.isArray(categories) ? categories : []).map((c) => ({
    id: String(c.id), name: String(c.name), color: String(c.color || '#3B6EF6'), icon: String(c.icon || '📁'),
  }));
  const data = { categories: cats, entries: Object.fromEntries(cats.map((c) => [c.id, []])) };
  await queueWrite(async () => {
    await atomicWrite(SALT_PATH, salt);
    await atomicWrite(VAULT_PATH, vc.encrypt(key, JSON.stringify(data)));
  });
  setVaultKey(key);
  return { ok: true, data };
});

ipcMain.handle('vault:unlock', async (_e, password) => {
  try {
    const salt = await fsp.readFile(SALT_PATH);
    const key = await vc.deriveKey(password || '', salt);
    const plain = vc.decrypt(key, await fsp.readFile(VAULT_PATH));
    if (!plain) return { ok: false, error: 'wrong' };
    setVaultKey(key);
    return { ok: true, data: migrateData(JSON.parse(plain.toString('utf8'))) };
  } catch (err) {
    logCrash(err);
    return { ok: false, error: 'io', message: String(err.message || err) };
  }
});

ipcMain.handle('vault:save', async (_e, data) => {
  if (!vaultKey) return { ok: false, error: 'locked' };
  const key = vaultKey;
  await queueWrite(() => atomicWrite(VAULT_PATH, vc.encrypt(key, JSON.stringify(data))));
  return { ok: true };
});

ipcMain.handle('vault:lock', () => { setVaultKey(null); pendingBackups.clear(); return { ok: true }; });

ipcMain.handle('vault:changePassword', async (_e, { current, next }) => {
  if (!next || next.length < 4) return { ok: false, error: 'short' };
  const salt = await fsp.readFile(SALT_PATH);
  const oldKey = await vc.deriveKey(current || '', salt);
  const plain = vc.decrypt(oldKey, await fsp.readFile(VAULT_PATH));
  if (!plain) return { ok: false, error: 'wrong' };
  const newSalt = crypto.randomBytes(16);
  const newKey = await vc.deriveKey(next, newSalt);
  await queueWrite(async () => {
    // once ikisi de gecici adla yazilir, sonra arka arkaya yer degistirir (pencereyi minimuma indirir)
    await atomicWrite(SALT_PATH + '.new', newSalt);
    await atomicWrite(VAULT_PATH + '.new', vc.encrypt(newKey, plain));
    await fsp.rename(SALT_PATH + '.new', SALT_PATH);
    await fsp.rename(VAULT_PATH + '.new', VAULT_PATH);
  });
  setVaultKey(newKey, { keepIcons: true });
  return { ok: true };
});

/** Var olan bir kasayi (salt.bin + vault.enc) bu kuruluma kopyalar. Kaynak dosyalara dokunulmaz. */
async function copyVaultFrom(dir) {
  if (vaultExists()) return { ok: false, error: 'exists' };
  let src = dir;
  if (!vaultExists(src) && vaultExists(path.join(dir, 'data'))) src = path.join(dir, 'data');
  if (!vaultExists(src)) return { ok: false, error: 'invalid' };
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.copyFile(path.join(src, 'salt.bin'), SALT_PATH);
  await fsp.copyFile(path.join(src, 'vault.enc'), VAULT_PATH);
  // dil / otomatik kilit / tema tercihleri de tasinir (lisans onbellegi tasinmaz)
  const old = readJson(path.join(src, 'settings.json'), null);
  if (old && !fs.existsSync(SETTINGS_PATH)) {
    const keep = {};
    for (const k of ['language', 'theme', 'autolock_minutes']) if (k in old) keep[k] = old[k];
    await updateSettingsFile(keep);
  }
  return { ok: true, path: src };
}

ipcMain.handle('vault:importExisting', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  return copyVaultFrom(res.filePaths[0]);
});

ipcMain.handle('vault:useLegacy', async () => {
  const legacy = findLegacyVault();
  return legacy ? copyVaultFrom(legacy) : { ok: false, error: 'invalid' };
});

// ----- Dosya iletisim kutulari (testler VAULTDESK_TEST_SAVE_PATH / VAULTDESK_TEST_OPEN_PATH ile atlar) -----
function saveDialog(opts) {
  if (process.env.VAULTDESK_TEST_SAVE_PATH) return Promise.resolve({ canceled: false, filePath: process.env.VAULTDESK_TEST_SAVE_PATH });
  return dialog.showSaveDialog(mainWindow, opts);
}
function openDialog(opts) {
  if (process.env.VAULTDESK_TEST_OPEN_PATH) return Promise.resolve({ canceled: false, filePaths: [process.env.VAULTDESK_TEST_OPEN_PATH] });
  return dialog.showOpenDialog(mainWindow, opts);
}

// ---------------------------------------------------------------------
// Yedekleme / geri yukleme
//
// Yedek dosyasi (.vault, JSON metin):
//   { format: "vaultdesk-backup-v2", app, version, createdAt, kdf, salt: b64(16 bayt),
//     vault: b64( Fernet token( JSON { data, settings } ) ) }
// Kasa ile ayni sifreleme: anahtar = PBKDF2(yedegi alirken kullanilan ana sifre, salt). Dosyada hicbir
// kayit duz metin olarak bulunmaz. v1'in "vaultdesk-pro-export-v1" disa aktarimlari da
// (token icinde dogrudan kasa verisi) geri yuklenebilir.
// ---------------------------------------------------------------------
const BACKUP_FORMAT = 'vaultdesk-backup-v2';
const LEGACY_EXPORT_FORMAT = 'vaultdesk-pro-export-v1';
const BACKUP_SETTINGS = ['language', 'theme', 'autolock_minutes', 'fetch_icons'];
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
// Secilmis / cozulmus yedekler yalnizca ana surecte, kisa sure tutulur (kilitlemede temizlenir).
const pendingBackups = new Map();

function pickSettings(s) {
  const out = {};
  for (const k of BACKUP_SETTINGS) if (s && k in s) out[k] = s[k];
  return out;
}

function countRecords(data) {
  return Object.values(data.entries || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

function isValidVaultData(d) {
  return d && Array.isArray(d.categories) && d.categories.every((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
    && d.entries && typeof d.entries === 'object';
}

/** Yedekteki kategorileri/kayitlari mevcut kasaya ekler: ayni kimlikli ya da icerigi ayni kayit atlanir. */
function mergeData(current, backup) {
  const out = JSON.parse(JSON.stringify(current));
  const byId = new Map(out.categories.map((c) => [c.id, c]));
  let categories = 0;
  let records = 0;
  const sig = (e) => [e.site, e.kullanici, e.eposta, e.sifre].map((v) => String(v || '')).join('\u0000');
  for (const c of backup.categories) {
    if (!byId.has(c.id)) {
      out.categories.push({ ...c });
      byId.set(c.id, c);
      categories++;
    }
    const list = Array.isArray(out.entries[c.id]) ? out.entries[c.id] : (out.entries[c.id] = []);
    const ids = new Set(list.map((e) => e.id));
    const sigs = new Set(list.map(sig));
    for (const e of backup.entries[c.id] || []) {
      if (ids.has(e.id) || sigs.has(sig(e))) continue;
      list.push({ ...e });
      ids.add(e.id);
      sigs.add(sig(e));
      records++;
    }
  }
  return { data: out, categories, records };
}

/** Geri yuklemeden once mevcut kasanin kopyasi: data\backups\pre-restore-<zaman>\ (son 5 kopya tutulur). */
async function safetyCopy() {
  if (!vaultExists()) return null;
  const root = path.join(dataDir, 'backups');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(root, `pre-restore-${stamp}-${crypto.randomBytes(2).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(SALT_PATH, path.join(dir, 'salt.bin'));
  await fsp.copyFile(VAULT_PATH, path.join(dir, 'vault.enc'));
  const old = (await fsp.readdir(root)).filter((n) => n.startsWith('pre-restore-')).sort().reverse().slice(5);
  for (const n of old) await fsp.rm(path.join(root, n), { recursive: true, force: true });
  return dir;
}

function clearPendingBackups() { pendingBackups.clear(); }

ipcMain.handle('backup:export', async (_e, data) => {
  if (!vaultKey) return { ok: false, error: 'locked' };
  if (!isValidVaultData(data)) return { ok: false, error: 'invalid' };
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await saveDialog({
    defaultPath: path.join(app.getPath('documents'), `VaultDesk-Backup-${stamp}.vault`),
    filters: [{ name: 'VaultDesk Backup', extensions: ['vault'] }, { name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  const salt = await fsp.readFile(SALT_PATH);
  const payload = { data: migrateData(JSON.parse(JSON.stringify(data))), settings: pickSettings(getSettings()) };
  const file = {
    format: BACKUP_FORMAT,
    app: APP_NAME,
    version: app.getVersion(),
    createdAt: new Date().toISOString(),
    kdf: { name: 'pbkdf2-sha256', iterations: vc.ITERATIONS },
    salt: salt.toString('base64'),
    vault: vc.encrypt(vaultKey, JSON.stringify(payload)).toString('base64'),
  };
  await atomicWrite(res.filePath, JSON.stringify(file, null, 2));
  return { ok: true, path: res.filePath, records: countRecords(payload.data) };
});

// Ham kasa dosyasi: herhangi bir VaultDesk surumunun data\vault.enc'i (salt'i ayri salt.bin'de).
const RAW_VAULT_FORMAT = 'raw-vault';

/** Fernet token mi? (base64url metin; ilk bayt 0x80 -> metin "gAAAAA" ile baslar) */
function looksLikeFernetToken(buf) {
  const text = buf.toString('ascii').trim();
  return text.length >= 76 && /^gAAAAA[A-Za-z0-9_\-]+=*$/.test(text);
}

/**
 * Akilli dosya tanima. Desteklenenler:
 *  - .vault / .json yedekleri (vaultdesk-backup-v2, v1'in vaultdesk-pro-export-v1'i)
 *  - eski kasa: vault.enc secilirse ayni klasordeki salt.bin otomatik okunur (salt.bin secilirse
 *    yanindaki vault.enc kullanilir). Klasorde settings.json varsa tercihler de aktarilabilir.
 */
async function readBackupSource(filePath) {
  const st = await fsp.stat(filePath);
  if (!st.isFile() || st.size > MAX_BACKUP_BYTES) return { ok: false, error: 'invalid' };
  const dir = path.dirname(filePath);
  let vaultFile = filePath;
  if (path.basename(filePath).toLowerCase() === 'salt.bin') vaultFile = path.join(dir, 'vault.enc');
  const raw = await fsp.readFile(vaultFile).catch(() => null);
  if (!raw) return { ok: false, error: 'missing_vault' };

  if (looksLikeFernetToken(raw)) {
    const saltPath = path.join(dir, 'salt.bin');
    const salt = await fsp.readFile(saltPath).catch(() => null);
    if (!salt) return { ok: false, error: 'missing_salt' };
    if (salt.length !== 16) return { ok: false, error: 'invalid' };
    const vst = await fsp.stat(vaultFile);
    const settings = pickSettings(readJson(path.join(dir, 'settings.json'), {}));
    return {
      ok: true, salt, token: raw, format: RAW_VAULT_FORMAT, settings,
      createdAt: vst.mtime.toISOString(), name: path.basename(vaultFile), folder: dir,
    };
  }

  let file;
  try { file = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, error: 'invalid' }; }
  if (!file || ![BACKUP_FORMAT, LEGACY_EXPORT_FORMAT].includes(file.format)) return { ok: false, error: 'invalid' };
  const salt = Buffer.from(String(file.salt || ''), 'base64');
  const token = Buffer.from(String(file.vault || ''), 'base64');
  if (salt.length !== 16 || token.length < 60) return { ok: false, error: 'invalid' };
  return { ok: true, salt, token, format: file.format, settings: null, createdAt: file.createdAt || null, name: path.basename(filePath) };
}

ipcMain.handle('backup:pick', async () => {
  const res = await openDialog({
    properties: ['openFile'],
    filters: [
      { name: 'VaultDesk (.vault, .json, vault.enc)', extensions: ['vault', 'json', 'enc', 'bin'] },
      { name: '*', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const src = await readBackupSource(res.filePaths[0]);
    if (!src.ok) return src;
    clearPendingBackups();
    const id = crypto.randomBytes(8).toString('hex');
    pendingBackups.set(id, { salt: src.salt, token: src.token, format: src.format, createdAt: src.createdAt, folderSettings: src.settings });
    return { ok: true, id, name: src.name, folder: src.folder || null, format: src.format, createdAt: src.createdAt };
  } catch {
    return { ok: false, error: 'invalid' };
  }
});

ipcMain.handle('backup:inspect', async (_e, { id, password }) => {
  const p = pendingBackups.get(id);
  if (!p) return { ok: false, error: 'expired' };
  const key = await vc.deriveKey(password || '', p.salt);
  const plain = vc.decrypt(key, p.token);
  if (!plain) return { ok: false, error: 'wrong' };
  let parsed;
  try { parsed = JSON.parse(plain.toString('utf8')); } catch { return { ok: false, error: 'invalid' }; }
  const v2 = p.format === BACKUP_FORMAT;
  // v1 disa aktarim ve ham vault.enc: token icinde dogrudan kasa verisi (cok eski kasalar migrateData ile cevrilir)
  const data = migrateData(v2 ? parsed.data : parsed);
  if (!isValidVaultData(data)) return { ok: false, error: 'invalid' };
  const settings = v2 ? pickSettings(parsed.settings) : (p.folderSettings || {});
  Object.assign(p, { key, data, settings });
  return {
    ok: true,
    stats: { categories: data.categories.length, records: countRecords(data) },
    hasSettings: Object.keys(p.settings).length > 0,
  };
});

ipcMain.handle('backup:discard', () => { clearPendingBackups(); return { ok: true }; });

/**
 * mode: "merge"   — acik kasaya eksik kategori/kayitlari ekler (ana sifre degismez)
 *       "replace" — acik kasanin icerigini yedekle degistirir (ana sifre degismez; once guvenlik kopyasi)
 *       "vault"   — giris ekranindan: kasa yedekten kurulur, ana sifre = yedegin sifresi
 *                   (cihazda kasa varsa once guvenlik kopyasi)
 */
ipcMain.handle('backup:restore', async (_e, { id, mode, applySettings, currentData }) => {
  const p = pendingBackups.get(id);
  if (!p || !p.data) return { ok: false, error: 'expired' };
  let data;
  let safety = null;
  let added = null;
  if (mode === 'merge' || mode === 'replace') {
    if (!vaultKey) return { ok: false, error: 'locked' };
    const key = vaultKey;
    if (mode === 'merge') {
      if (!isValidVaultData(currentData)) return { ok: false, error: 'invalid' };
      const m = mergeData(migrateData(currentData), p.data);
      data = m.data;
      added = { categories: m.categories, records: m.records };
    } else {
      safety = await safetyCopy();
      data = p.data;
    }
    await queueWrite(() => atomicWrite(VAULT_PATH, vc.encrypt(key, JSON.stringify(data))));
  } else if (mode === 'vault') {
    if (vaultExists()) safety = await safetyCopy();
    data = p.data;
    const { key, salt } = p;
    await queueWrite(async () => {
      // once ikisi de gecici adla yazilir, sonra arka arkaya yer degistirir
      await atomicWrite(SALT_PATH + '.new', salt);
      await atomicWrite(VAULT_PATH + '.new', vc.encrypt(key, JSON.stringify(data)));
      await fsp.rename(SALT_PATH + '.new', SALT_PATH);
      await fsp.rename(VAULT_PATH + '.new', VAULT_PATH);
    });
    setVaultKey(key);
  } else {
    return { ok: false, error: 'invalid' };
  }
  if (applySettings && Object.keys(p.settings || {}).length) {
    const s = await updateSettingsFile(p.settings);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(THEME_BACKGROUNDS[s.theme]);
  }
  clearPendingBackups();
  return { ok: true, data, settings: getSettings(), safety, added, records: countRecords(data) };
});

ipcMain.handle('export:csv', async (_e, { data, categoryId, suggestedName }) => {
  if (!vaultKey) return { ok: false, error: 'locked' };
  const res = await saveDialog({
    defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'vaultdesk_export.csv').replace(/[\\/:*?"<>|]+/g, '_')),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await atomicWrite(res.filePath, csv.exportCsv(data, categoryId || null));
  return { ok: true, path: res.filePath };
});

ipcMain.handle('import:pickCsv', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv'] }, { name: '*', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('import:csv', async (_e, { filePath, source }) => {
  if (!vaultKey) return { ok: false, error: 'locked' };
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return { ok: true, records: csv.importRecords(text, source) };
  } catch (err) {
    return { ok: false, error: 'io', message: String(err.message || err) };
  }
});

// ---------------------------------------------------------------------
// Site ikonlari (favicon)
//
// Istekler YALNIZCA ana surecte yapilir (arayuz internete cikmaz, CSP degismez) ve yalnizca
// "Site ikonlarini otomatik getir" acikken. Gonderilen tek bilgi alan adidir (src/domain.js:
// localhost / IP / ic ag adlari asla). Indirilen ikonlar diskte duz dosya olarak DEGIL, kasa anahtariyla
// sifreli data\icons.enc icinde tutulur (hangi sitelerde hesap oldugu diskten okunamaz); her ikon bir kez
// indirilir. Bulunamayan alan adi 7 gun sonra yeniden denenir; ag hatasi yalnizca bu oturum icin hatirlanir.
// ---------------------------------------------------------------------
const ICONS_PATH = path.join(dataDir, 'icons.enc');
const ICON_URL = (d) => `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(d)}`;
const ICON_MAX_BYTES = 200 * 1024;
const ICON_RETRY_MS = 7 * 24 * 3600 * 1000;
const ICON_CONCURRENCY = 4;
const iconCache = new Map(); // alan adi -> { data: "data:image/...;base64,..." | null, ts }
const iconSessionFailures = new Set();
const iconQueue = [];
const iconInFlight = new Set();
let iconsDirty = false;
let iconSaveTimer = null;
global.__vaultdeskIconFetches = 0; // testler icin

function loadIconCache(key) {
  iconCache.clear();
  iconSessionFailures.clear();
  try {
    const plain = vc.decrypt(key, fs.readFileSync(ICONS_PATH));
    if (!plain) return; // baska bir anahtarla yazilmis (or. yedekten kurulum) -> bos baslar, sonra uzerine yazilir
    const obj = JSON.parse(plain.toString('utf8'));
    for (const [d, v] of Object.entries(obj.icons || {})) {
      if (v && (v.data === null || /^data:image\/(png|x-icon|jpeg|gif|webp);base64,/.test(v.data || ''))) iconCache.set(d, v);
    }
  } catch {}
}

function iconPayload() {
  return JSON.stringify({ version: 1, icons: Object.fromEntries(iconCache) });
}

function scheduleIconSave() {
  iconsDirty = true;
  clearTimeout(iconSaveTimer);
  iconSaveTimer = setTimeout(saveIconCache, 1500);
}

async function saveIconCache() {
  iconSaveTimer = null;
  if (!vaultKey || !iconsDirty) return;
  iconsDirty = false;
  const blob = vc.encrypt(vaultKey, iconPayload());
  await queueWrite(() => atomicWrite(ICONS_PATH, blob)).catch(logCrash);
}

/** Kilitlenirken/cikarken bekleyen ikonlari eski anahtarla hemen yazar. */
function flushIconCacheSync() {
  clearTimeout(iconSaveTimer);
  iconSaveTimer = null;
  if (!vaultKey || !iconsDirty) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(ICONS_PATH, vc.encrypt(vaultKey, iconPayload()));
    iconsDirty = false;
  } catch (e) { logCrash(e); }
}

/** Tek giris noktasi: kasa anahtari degisince ikon onbellegi de yuklenir / yeni anahtarla yazilir / temizlenir. */
function setVaultKey(key, { keepIcons = false } = {}) {
  if (!key) {
    flushIconCacheSync();
    iconCache.clear();
    iconQueue.length = 0;
    vaultKey = null;
    return;
  }
  vaultKey = key;
  if (keepIcons) scheduleIconSave(); // ana sifre degisti: ayni ikonlar yeni anahtarla yazilir
  else loadIconCache(key);
}

function sniffImageType(buf) {
  if (buf.length > 8 && buf.slice(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (buf.length > 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function fetchIcon(domain) {
  global.__vaultdeskIconFetches++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch(ICON_URL(domain), { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    // Google, ikonu olmayan alan adinda 404 + varsayilan dunya simgesi dondurur -> ikon yok
    if (res.status !== 200) return { data: null, ts: Date.now() };
    const buf = Buffer.from(await res.arrayBuffer());
    const type = sniffImageType(buf);
    if (!type || buf.length > ICON_MAX_BYTES) return { data: null, ts: Date.now() };
    return { data: `data:${type};base64,${buf.toString('base64')}`, ts: Date.now() };
  } catch {
    return undefined; // ag hatasi: kalici olarak kaydedilmez
  } finally {
    clearTimeout(timer);
  }
}

function pumpIconQueue() {
  while (iconInFlight.size < ICON_CONCURRENCY && iconQueue.length) {
    const domain = iconQueue.shift();
    if (iconInFlight.has(domain)) continue;
    iconInFlight.add(domain);
    const key = vaultKey;
    fetchIcon(domain).then((result) => {
      iconInFlight.delete(domain);
      if (!vaultKey || vaultKey !== key) return pumpIconQueue(); // bu arada kilitlendi
      if (result === undefined) iconSessionFailures.add(domain);
      else { iconCache.set(domain, result); scheduleIconSave(); }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('icons:updated', { [domain]: result ? result.data : null });
      }
      pumpIconQueue();
    });
  }
}

ipcMain.handle('icons:get', (_e, domains) => {
  if (!vaultKey || !getSettings().fetch_icons || !Array.isArray(domains)) return {};
  const out = {};
  const now = Date.now();
  for (const raw of domains.slice(0, 1000)) {
    const d = domainHelper.normalizeHost(String(raw || ''));
    if (!d || d in out) continue;
    const hit = iconCache.get(d);
    if (hit && (hit.data || now - hit.ts < ICON_RETRY_MS)) { out[d] = hit.data; continue; }
    if (iconSessionFailures.has(d)) { out[d] = null; continue; }
    if (!iconInFlight.has(d) && !iconQueue.includes(d)) iconQueue.push(d);
  }
  pumpIconQueue();
  return out;
});

// ----- Pano, lisans -----
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });

function postForm(hostname, pathName, form) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request({
      hostname, path: pathName, method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve({ json: JSON.parse(raw) }); } catch { resolve({ error: 'network' }); } });
    });
    req.on('error', () => resolve({ error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'network' }); });
    req.write(body);
    req.end();
  });
}

ipcMain.handle('license:verify', async (_e, licenseKey) => {
  const key = String(licenseKey || '').trim();
  if (!key) return { ok: false, status: 'empty' };
  let r;
  if (appConfig.provider === 'payhip') {
    r = await postForm('payhip.com', '/api/v2/license/verify', { product_link: appConfig.payhip_product_link, license_key: key });
    if (r.error) return { ok: false, status: 'network' };
    const ok = !!r.json.success && (r.json.data ? r.json.data.enabled !== false : true);
    if (!ok) return { ok: false, status: 'invalid' };
  } else {
    r = await postForm('api.gumroad.com', '/v2/licenses/verify', {
      product_id: appConfig.gumroad_product_id, license_key: key, increment_uses_count: 'false',
    });
    if (r.error) return { ok: false, status: 'network' };
    if (!r.json.success) return { ok: false, status: 'invalid' };
  }
  await updateSettingsFile({ license_verified: true, license_key: key });
  return { ok: true, status: 'ok' };
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});
