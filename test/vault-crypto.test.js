'use strict';
/* node test/vault-crypto.test.js — kasa sifrelemesinin Fernet ile birebir uyumlu oldugunu dogrular. */
const assert = require('assert');
const crypto = require('crypto');
const vc = require('../vault-crypto');

(async () => {
  // 1) Fernet sartnamesinin resmi test vektoru (github.com/fernet/spec, generate.json/verify.json)
  const specKey = vc.b64urlDecode('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=');
  const specToken = 'gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==';
  assert.strictEqual(vc.decrypt(specKey, specToken).toString('utf8'), 'hello');

  // 2) gidis-donus (Turkce karakter + emoji) ve '=' dolgusunun korunmasi
  const salt = crypto.randomBytes(16);
  const key = await vc.deriveKey('Şifre-ÇöğüŞ 123!', salt);
  const plain = JSON.stringify({ site: 'GitHub ✓', sifre: 'p@ss Ğü 🔐' });
  const token = vc.encrypt(key, plain);
  assert.ok(/^[A-Za-z0-9_\-=]+$/.test(token.toString('ascii')));
  assert.strictEqual(token.toString('ascii').length % 4, 0);
  assert.strictEqual(vc.decrypt(key, token).toString('utf8'), plain);

  // 3) yanlis anahtar / bozulmus veri reddedilir
  const wrong = await vc.deriveKey('yanlis', salt);
  assert.strictEqual(vc.decrypt(wrong, token), null);
  const tampered = Buffer.from(token);
  tampered[40] = tampered[40] === 65 ? 66 : 65;
  assert.strictEqual(vc.decrypt(key, tampered), null);

  // 4) anahtar turetme: PBKDF2-SHA256, 390000 tur, 32 bayt
  assert.strictEqual(vc.ITERATIONS, 390000);
  assert.strictEqual(key.length, 32);
  console.log('vault-crypto: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
