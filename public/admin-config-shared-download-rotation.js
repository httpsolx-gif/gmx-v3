/** Config modal — shared Win+Android: rotate-after-N, stats (`/api/config/download-settings`). Loaded before admin.js. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   authFetch: function(string, object=): Promise<Response>,
   *   postJson: function(string, object): Promise<object>
   * }} deps
   * @returns {{ loadDownloadSettings: function(): void }|undefined}
   */
  function initAdminConfigSharedDownloadRotation(deps) {
    if (!deps || typeof deps.authFetch !== 'function' || typeof deps.postJson !== 'function') return;

    var authFetch = deps.authFetch;
    var postJson = deps.postJson;
    function bindClickOnce(el, key, handler) {
      if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return;
      var guardKey = '__gmwBound_' + key;
      if (el[guardKey]) return;
      el[guardKey] = true;
      el.addEventListener('click', handler);
    }

    function loadDownloadSettings() {
      authFetch('/api/config/download-settings').then(function (r) { return r.json(); }).then(function (data) {
        var n = (data && data.rotateAfterUnique != null) ? Number(data.rotateAfterUnique) : 0;
        var w = (data && data.windowsUnique != null) ? data.windowsUnique : 0;
        var a = (data && data.androidUnique != null) ? data.androidUnique : 0;
        var text = 'Уникальных: Win ' + w + ', And ' + a;
        var inputWin = document.getElementById('config-rotate-after');
        var inputAnd = document.getElementById('config-android-rotate-after');
        var statsWin = document.getElementById('config-rotate-stats');
        var statsAnd = document.getElementById('config-android-rotate-stats');
        if (inputWin) inputWin.value = n;
        if (inputAnd) inputAnd.value = n;
        if (statsWin) statsWin.textContent = text;
        if (statsAnd) statsAnd.textContent = text;
      }).catch(function () {});
    }

    function saveDownloadSettingsRotation() {
      var input = document.getElementById('config-rotate-after') || document.getElementById('config-android-rotate-after');
      var n = input ? parseInt(input.value, 10) : 0;
      if (isNaN(n) || n < 0) n = 0;
      postJson('/api/config/download-settings', { rotateAfterUnique: n }).then(function () {
        loadDownloadSettings();
      }).catch(function () {});
    }

    var configRotateSave = document.getElementById('config-rotate-save');
    bindClickOnce(configRotateSave, 'rotateSave', saveDownloadSettingsRotation);
    var configAndroidRotateSave = document.getElementById('config-android-rotate-save');
    bindClickOnce(configAndroidRotateSave, 'androidRotateSave', saveDownloadSettingsRotation);

    return { loadDownloadSettings: loadDownloadSettings };
  }

  global.initAdminConfigSharedDownloadRotation = initAdminConfigSharedDownloadRotation;
})(typeof window !== 'undefined' ? window : globalThis);
