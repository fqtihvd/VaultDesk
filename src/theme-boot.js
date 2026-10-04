'use strict';

/* -------------------------------------------------------------------
 * <head> icinde, stil dosyasi hicbir sey boyamadan ONCE calisir: uygulama
 * dogrudan kayitli temada acilir (varsayilan paletin bir anlik parlamasi
 * yok). Kaynak: ana surecin verdigi tema (settings.json), yedek olarak
 * localStorage. Pencerenin kendi zemini de ana surecte ayni renktedir.
 * ------------------------------------------------------------------- */
(function () {
  var THEMES = ['dark', 'light', 'violet'];
  var theme = 'dark';
  try {
    var fromMain = window.vd && window.vd.initialTheme;
    var saved = localStorage.getItem('vaultdesk.theme');
    if (THEMES.indexOf(fromMain) !== -1) theme = fromMain;
    else if (THEMES.indexOf(saved) !== -1) theme = saved;
  } catch (e) {
    // depolama kullanilamiyor - varsayilan tema
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
