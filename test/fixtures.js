'use strict';
/* Test ornek dosyalari: VaultDesk v1 kasa klasorleri (salt.bin + vault.enc + settings.json) ve v1 sifreli
 * disa aktarimlari. Fernet uyumlu vault-crypto ile, senkron uretilir (main.js yuklenmeden once de kullanilabilir). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vc = require('../vault-crypto');

const keyFor = (password, salt) => crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, vc.ITERATIONS, 32, 'sha256');

const V1_CATEGORIES = [
  { id: 'sosyal_medya', name: 'Sosyal Medya Hesapları', color: '#3B6EF6', icon: '📱' },
  { id: 'karisik', name: 'Karışık Siteler', color: '#8B5CF6', icon: '🌐' },
  { id: 'gamedesign', name: 'Game Design', color: '#F0576B', icon: '🎮' },
  { id: 'yapay_zeka', name: 'Yapay Zeka', color: '#22C55E', icon: '🤖' },
  { id: 'yemek_alisveris', name: 'Yemek / Alışveriş', color: '#F59E0B', icon: '🛒' },
];

const rec = (site, sifre, extra = {}) => ({ id: crypto.randomBytes(16).toString('hex'), site, kullanici: 'u', eposta: '', sifre, ek_bilgi: '', ...extra });

/** v1 kasa verisi; records: { kategori_id: [kayit, ...] } */
function v1Data(records = {}) {
  const categories = V1_CATEGORIES.map((c) => ({ ...c }));
  return { categories, entries: Object.fromEntries(categories.map((c) => [c.id, records[c.id] || []])) };
}

/** data\ klasoru gibi: salt.bin + vault.enc (+ istege bagli settings.json). data herhangi bir JSON olabilir. */
function writeV1Vault(dir, password, data, settings) {
  fs.mkdirSync(dir, { recursive: true });
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'salt.bin'), salt);
  fs.writeFileSync(path.join(dir, 'vault.enc'), vc.encrypt(keyFor(password, salt), JSON.stringify(data)));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

/** v1 "Sifreli JSON Disa Aktar" dosyasi (vaultdesk-pro-export-v1). */
function writeV1Export(file, password, data) {
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(file, JSON.stringify({
    format: 'vaultdesk-pro-export-v1',
    salt: salt.toString('base64'),
    vault: vc.encrypt(keyFor(password, salt), JSON.stringify(data)).toString('base64'),
  }));
  return file;
}

module.exports = { V1_CATEGORIES, rec, v1Data, writeV1Vault, writeV1Export };
