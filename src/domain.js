'use strict';

/* Kayittan site alan adi cikarma — hem arayuzde (<script>) hem ana surecte (require) kullanilir.
 *  - Site alani: "instagram.com", "https://www.github.com/login", "accounts.google.com" -> alan adi;
 *    yalnizca isim ("Instagram", "Banka hesabi") -> null (hicbir sey gonderilmez).
 *  - Ek bilgi: yalnizca http(s):// ile baslayan adresler (Chrome/Bitwarden CSV aktarimlari URL'yi buraya koyar).
 *  - localhost, IP adresleri, tek etiketli ve ic ag adlari (.local, .lan, .internal, .home...) asla dondurulmez.
 *  - Uluslararasi alan adlari punycode'a cevrilir; "www." atilir. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VaultDeskDomain = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const PRIVATE_TLDS = new Set(['local', 'lan', 'internal', 'home', 'localdomain', 'corp', 'intranet', 'test', 'invalid', 'example', 'localhost', 'arpa']);
  // gercek TLD olmayan yaygin dosya uzantilari ("dosya.txt" bir alan adi degil)
  const FILE_EXTS = new Set(['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'exe', 'rar', 'enc', 'bin', 'vault', 'ini', 'log', 'bak']);
  const HOST_RE = /(?:^|[\s(<"'])(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63})(?::\d{1,5})?(?=[\/?#\s)>"']|$)/iu;
  const URL_RE = /https?:\/\/[^\s<>"']+/i;

  function normalizeHost(raw) {
    if (!raw || typeof raw !== 'string' || raw.length > 253) return null;
    let host;
    try {
      host = new URL('https://' + raw.trim().replace(/^[a-z]+:\/\//i, '').split(/[\/?#]/)[0]).hostname.toLowerCase();
    } catch {
      return null;
    }
    host = host.replace(/\.$/, '').replace(/^www\./, '');
    if (!host || host.length > 253 || !host.includes('.')) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
    const labels = host.split('.');
    if (labels.some((l) => !l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return null;
    const tld = labels[labels.length - 1];
    if (PRIVATE_TLDS.has(tld) || FILE_EXTS.has(tld) || /^\d+$/.test(tld)) return null;
    return host;
  }

  function hostFromSite(site) {
    const m = String(site || '').match(HOST_RE);
    return m ? normalizeHost(m[1]) : null;
  }

  function hostFromNotes(notes) {
    const m = String(notes || '').match(URL_RE);
    if (!m) return null;
    try { return normalizeHost(new URL(m[0]).hostname); } catch { return null; }
  }

  function domainForEntry(entry) {
    if (!entry) return null;
    return hostFromSite(entry.site) || hostFromNotes(entry.ek_bilgi);
  }

  return { normalizeHost, hostFromSite, hostFromNotes, domainForEntry };
});
