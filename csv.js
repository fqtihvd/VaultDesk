'use strict';

/* CSV okuma/yazma (RFC 4180: tirnakli alanlar, "" kacisi, CRLF/LF, UTF-8 BOM) ve
 * Chrome / Bitwarden / 1Password / genel CSV kaynak sutun eslemeleri. */

const SOURCE_COLUMN_MAPS = {
  chrome: { site: ['name'], kullanici: ['username'], sifre: ['password'], ek_bilgi: ['note', 'url'] },
  bitwarden: { site: ['name'], kullanici: ['login_username'], sifre: ['login_password'], ek_bilgi: ['notes', 'login_uri'] },
  '1password': { site: ['title', 'name'], kullanici: ['username'], sifre: ['password'], ek_bilgi: ['notes', 'url', 'website'] },
  generic: {
    site: ['site', 'name', 'title', 'site adı', 'site adi'],
    kullanici: ['username', 'user', 'login', 'kullanıcı adı', 'kullanici adi'],
    eposta: ['email', 'e-posta', 'eposta'],
    sifre: ['password', 'şifre', 'sifre'],
    ek_bilgi: ['notes', 'note', 'ek bilgi', 'ek_bilgi'],
  },
};

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

function importRecords(text, source) {
  const map = SOURCE_COLUMN_MAPS[source] || SOURCE_COLUMN_MAPS.generic;
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const pick = (row, candidates) => (candidates || [])
    .map((cand) => header.indexOf(cand.toLowerCase()))
    .filter((idx) => idx >= 0 && row[idx] && row[idx].trim())
    .map((idx) => row[idx].trim());
  const out = [];
  for (const row of rows.slice(1)) {
    const site = pick(row, map.site)[0] || '';
    const kullanici = pick(row, map.kullanici)[0] || '';
    const eposta = pick(row, map.eposta)[0] || '';
    const sifre = pick(row, map.sifre)[0] || '';
    const ek_bilgi = pick(row, map.ek_bilgi).join(' | ');
    if (!site && !kullanici && !sifre) continue;
    out.push({ site: site || '—', kullanici, eposta, sifre, ek_bilgi });
  }
  return out;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** UYARI: duz metin. categoryId verilirse yalnizca o kategori. Excel icin UTF-8 BOM + CRLF. */
function exportCsv(data, categoryId) {
  const names = Object.fromEntries((data.categories || []).map((c) => [c.id, c.name]));
  const lines = [['category', 'site', 'username', 'email', 'password', 'notes'].join(',')];
  for (const [catId, entries] of Object.entries(data.entries || {})) {
    if (categoryId && catId !== categoryId) continue;
    for (const e of entries) {
      lines.push([names[catId] || catId, e.site, e.kullanici, e.eposta, e.sifre, e.ek_bilgi].map(csvCell).join(','));
    }
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, importRecords, exportCsv, SOURCE_COLUMN_MAPS };
