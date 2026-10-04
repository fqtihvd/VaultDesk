# VaultDesk

**VaultDesk Pro — by Devilt Interactive**

[English](#english) · [Türkçe](#türkçe)

---

## English

Encrypted desktop password manager for Windows, built with Electron 33 + plain HTML/CSS/JS.

### Download

[`release/VaultDesk_Setup.exe`](release/VaultDesk_Setup.exe) — one-click, per-user installer (no admin rights).
It installs to `%LOCALAPPDATA%\Programs\VaultDesk` with Start Menu / Desktop shortcuts. Your vault is stored in
`%APPDATA%\VaultDesk\data` and is **kept** when the app is uninstalled.

### Features

- Encrypted vault (Fernet: AES-128-CBC + HMAC-SHA256, key from PBKDF2-SHA256 with 390 000 iterations); the key
  never leaves the main process
- Categories with emoji icons and colors, drag-and-drop and ▲▼ ordering, A–Z sort, per-category search
- Records with show/hide + copy password, password generator and strength meter
- Global live search across all categories (**Ctrl+K**)
- Site icons (favicons) for records, or a chosen emoji; colored initial letter as fallback
- Encrypted backup & restore (`.vault`); also imports old `vault.enc` + `salt.bin` vaults
- CSV import (Chrome, Bitwarden, 1Password, generic) and CSV export
- Light / Dark / Devilt Violet themes, 9 languages (en, tr, de, es, fr, pt-BR, ru, ja, zh-CN)
- Auto-lock after system-wide inactivity, lock + minimize to tray, localized tray menu
- Optional Gumroad / Payhip license gate (`app.config.json`)

### Project layout

| Path | Purpose |
|---|---|
| `main.js` | Main process: window, tray, auto-lock, file I/O, backup/restore, site icons, IPC |
| `vault-crypto.js` | Fernet-compatible vault crypto |
| `csv.js` | CSV parser/writer + source column maps |
| `preload.js` | `window.vd` API via `contextBridge` (the renderer has no Node access) |
| `app.config.json` | License gate switch (`require_license`, Gumroad / Payhip ids) |
| `src/` | Renderer UI (`index.html`, `app.js`, `style.css`), languages (`i18n.js`, `locales/`), assets |
| `test/` | Crypto unit test and end-to-end tests |
| `release/` | Built installer |

### Build & test

```powershell
npm install
npm start          # dev run (data in .\data-dev)
npm test           # crypto test (incl. the official Fernet spec vector)
npm run dist       # -> dist\VaultDesk_Setup.exe, dist\win-unpacked\VaultDesk.exe
```

End-to-end tests run the real app with a **temporary** data folder (never your vault):

```powershell
node_modules\electron\dist\electron.exe test\e2e-main.js        <out-dir>   # UI, themes, Ctrl+K, forms, lock
node_modules\electron\dist\electron.exe test\e2e-backup.js      <out-dir>   # backup / restore
node_modules\electron\dist\electron.exe test\e2e-legacy.js      <out-dir>   # "Use this vault" from an old install
node_modules\electron\dist\electron.exe test\e2e-legacy-file.js <out-dir>   # vault.enc + salt.bin detection
node_modules\electron\dist\electron.exe test\e2e-ru.js          <out-dir>   # Russian + tray language sync
node_modules\electron\dist\electron.exe test\e2e-icons.js       <out-dir>   # site icons (real network)
```

### Security & privacy

- `contextIsolation`, `sandbox`, no `nodeIntegration`; strict CSP (`script-src 'self'`, no eval); navigation and
  `window.open` blocked; all web permission requests denied.
- Vault and backup writes are atomic; before any restore that replaces the vault, a copy of the current vault is
  saved to `data\backups\`.
- Site icons: only the **domain** (e.g. `github.com`) is sent to Google's favicon service, by the main process
  only, and only while *Settings → Site Icons* is on. `localhost`, IP addresses and private names are never sent.
  Icons are cached encrypted with the vault key (`data\icons.enc`).
- `.gitignore` keeps vault files, settings, backups and exports out of the repository.

---

## Türkçe

Windows için şifreli masaüstü şifre yöneticisi; Electron 33 + HTML/CSS/JS ile geliştirildi.

### İndir

[`release/VaultDesk_Setup.exe`](release/VaultDesk_Setup.exe) — tek tıkla, kullanıcı bazında kurulum (yönetici izni
gerekmez). `%LOCALAPPDATA%\Programs\VaultDesk` klasörüne kurulur, Başlat menüsü ve Masaüstü kısayolu oluşturur.
Kasan `%APPDATA%\VaultDesk\data` klasöründe tutulur ve uygulama kaldırıldığında **silinmez**.

### Özellikler

- Şifreli kasa (Fernet: AES-128-CBC + HMAC-SHA256, anahtar 390 000 turlu PBKDF2-SHA256 ile türetilir); anahtar
  ana süreçten hiç çıkmaz
- Emoji simgeli ve renkli kategoriler, sürükle-bırak ve ▲▼ ile sıralama, A–Z sıralama, kategori içi arama
- Şifre göster/gizle ve kopyalama, şifre oluşturucu ve şifre gücü göstergesi
- Tüm kategorilerde canlı genel arama (**Ctrl+K**)
- Kayıtlarda site ikonları (favicon) ya da seçilen emoji; yoksa renkli baş harf
- Şifreli yedekleme ve geri yükleme (`.vault`); eski `vault.enc` + `salt.bin` kasalarını da içe aktarır
- CSV içe aktarma (Chrome, Bitwarden, 1Password, genel) ve CSV dışa aktarma
- Açık / Koyu / Devilt Violet temaları, 9 dil (en, tr, de, es, fr, pt-BR, ru, ja, zh-CN)
- Sistem genelinde işlem yapılmadığında otomatik kilit, kilitleyip tepsiye küçültme, seçili dilde tepsi menüsü
- İsteğe bağlı Gumroad / Payhip lisans kontrolü (`app.config.json`)

### Proje yapısı

| Yol | Açıklama |
|---|---|
| `main.js` | Ana süreç: pencere, tepsi, otomatik kilit, dosya işlemleri, yedekleme, site ikonları, IPC |
| `vault-crypto.js` | Fernet uyumlu kasa şifrelemesi |
| `csv.js` | CSV okuma/yazma + kaynak sütun eşlemeleri |
| `preload.js` | `contextBridge` ile `window.vd` API'si (arayüzün Node erişimi yoktur) |
| `app.config.json` | Lisans kontrolü ayarı (`require_license`, Gumroad / Payhip kimlikleri) |
| `src/` | Arayüz (`index.html`, `app.js`, `style.css`), diller (`i18n.js`, `locales/`), görseller |
| `test/` | Şifreleme birim testi ve uçtan uca testler |
| `release/` | Derlenmiş kurulum paketi |

### Derleme ve test

```powershell
npm install
npm start          # geliştirme modu (veriler .\data-dev klasöründe)
npm test           # şifreleme testi (resmi Fernet test vektörü dahil)
npm run dist       # -> dist\VaultDesk_Setup.exe, dist\win-unpacked\VaultDesk.exe
```

Uçtan uca testler gerçek uygulamayı **geçici** bir veri klasörüyle çalıştırır (kendi kasana asla dokunmaz). Komutlar
yukarıdaki İngilizce bölümdekiyle aynıdır.

### Güvenlik ve gizlilik

- `contextIsolation`, `sandbox`, `nodeIntegration` kapalı; katı CSP (`script-src 'self'`, eval yok); uygulama dışına
  gezinme ve `window.open` engelli; tüm web izin istekleri reddedilir.
- Kasa ve yedek yazımları atomiktir; kasanın yerine geçecek her geri yüklemeden önce mevcut kasanın bir kopyası
  `data\backups\` klasörüne alınır.
- Site ikonları: Google'ın favicon servisine yalnızca **alan adı** (ör. `github.com`) gönderilir; bunu yalnızca ana
  süreç yapar ve yalnızca *Ayarlar → Site İkonları* açıkken. `localhost`, IP adresleri ve iç ağ adları asla
  gönderilmez. İkonlar kasa anahtarıyla şifreli saklanır (`data\icons.enc`).
- `.gitignore`, kasa dosyalarını, ayarları, yedekleri ve dışa aktarımları depo dışında tutar.
