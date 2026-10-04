'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Ana surecin verdigi baslangic temasi (--vd-theme=...). theme-boot.js bunu <head>'de, ilk boyamadan
// once uygular: uygulama dogrudan kayitli temada acilir.
const themeArg = (process.argv.find((a) => a.startsWith('--vd-theme=')) || '').split('=')[1] || '';

contextBridge.exposeInMainWorld('vd', {
  initialTheme: themeArg,

  init: () => ipcRenderer.invoke('app:init'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  createVault: (password, categories) => ipcRenderer.invoke('vault:create', { password, categories }),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
  save: (data) => ipcRenderer.invoke('vault:save', data),
  lock: () => ipcRenderer.invoke('vault:lock'),
  changePassword: (current, next) => ipcRenderer.invoke('vault:changePassword', { current, next }),
  importExistingVault: () => ipcRenderer.invoke('vault:importExisting'),
  useLegacyVault: () => ipcRenderer.invoke('vault:useLegacy'),

  exportBackup: (data) => ipcRenderer.invoke('backup:export', data),
  pickBackup: () => ipcRenderer.invoke('backup:pick'),
  inspectBackup: (id, password) => ipcRenderer.invoke('backup:inspect', { id, password }),
  restoreBackup: (opts) => ipcRenderer.invoke('backup:restore', opts),
  discardBackup: () => ipcRenderer.invoke('backup:discard'),
  exportCsv: (data, categoryId, suggestedName) => ipcRenderer.invoke('export:csv', { data, categoryId, suggestedName }),
  pickCsv: () => ipcRenderer.invoke('import:pickCsv'),
  importCsv: (filePath, source) => ipcRenderer.invoke('import:csv', { filePath, source }),

  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  getIcons: (domains) => ipcRenderer.invoke('icons:get', domains),
  onIconsUpdated: (cb) => ipcRenderer.on('icons:updated', (_e, map) => cb(map)),
  verifyLicense: (key) => ipcRenderer.invoke('license:verify', key),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Ana surec kasayi kilitlediginde (otomatik kilit / tepsiye kucultme)
  onLocked: (cb) => ipcRenderer.on('vault:locked', (_e, info) => cb(info)),
});
