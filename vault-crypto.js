'use strict';

/* -------------------------------------------------------------------
 * VaultDesk kasa sifrelemesi — Fernet (github.com/fernet/spec) ile
 * BIREBIR ayni format; VaultDesk v1'in data/salt.bin + data/vault.enc
 * dosyalari da ayni ana sifreyle acilir.
 *
 *   Anahtar   : PBKDF2-HMAC-SHA256(sifre, salt[16], 390000 tur) -> 32 bayt
 *               ilk 16 bayt = HMAC imza anahtari, son 16 bayt = AES anahtari
 *   Token     : base64url( 0x80 | zaman[8, BE] | IV[16] | AES-128-CBC(PKCS7) | HMAC-SHA256[32] )
 *               ('=' dolgusu korunur)
 *
 * PBKDF2 crypto.pbkdf2 ile (libuv is parcacigi havuzunda) calisir: ana
 * surec ve arayuz anahtar turetme sirasinda hic beklemez.
 * ------------------------------------------------------------------- */

const crypto = require('crypto');

const ITERATIONS = 390000;
const VERSION = 0x80;

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(Buffer.from(String(password), 'utf8'), salt, ITERATIONS, 32, 'sha256', (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(text) {
  return Buffer.from(String(text).trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function encrypt(key, plaintext) {
  const signKey = key.subarray(0, 16);
  const encKey = key.subarray(16, 32);
  const iv = crypto.randomBytes(16);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const cipher = crypto.createCipheriv('aes-128-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const body = Buffer.concat([Buffer.from([VERSION]), ts, iv, ct]);
  const mac = crypto.createHmac('sha256', signKey).update(body).digest();
  return Buffer.from(b64urlEncode(Buffer.concat([body, mac])), 'ascii');
}

/** Sifre/anahtar yanlis ya da veri bozuksa null doner. */
function decrypt(key, token) {
  let data;
  try {
    data = b64urlDecode(Buffer.isBuffer(token) ? token.toString('ascii') : token);
  } catch {
    return null;
  }
  if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== VERSION || (data.length - 57) % 16 !== 0) return null;
  const body = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = crypto.createHmac('sha256', key.subarray(0, 16)).update(body).digest();
  if (!crypto.timingSafeEqual(mac, expected)) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key.subarray(16, 32), body.subarray(9, 25));
    return Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]);
  } catch {
    return null;
  }
}

module.exports = { ITERATIONS, deriveKey, encrypt, decrypt, b64urlEncode, b64urlDecode };
