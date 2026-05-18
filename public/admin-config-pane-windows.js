/** Config modal — pane «Windows» (#config-pane-windows). Loaded before admin.js; wired from initConfigModal. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   authFetch: function(string, object=): Promise<Response>,
   *   postJson: function(string, object): Promise<object>,
   *   escapeHtml: function(string): string,
   *   brands: string[]
   * }} deps
   * @returns {{ loadConfigDownload: function(): void, loadWindowsArchivePassword: function(): void }|undefined}
   */
  function initAdminConfigPaneWindows(deps) {
    if (!deps || typeof deps.authFetch !== 'function' || typeof deps.postJson !== 'function' || typeof deps.escapeHtml !== 'function') return;
    var brands = deps.brands;
    if (!brands || !brands.length) return;

    var authFetch = deps.authFetch;
    var postJson = deps.postJson;
    var escapeHtml = deps.escapeHtml;
    function bindClickOnce(el, key, handler) {
      if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return;
      var guardKey = '__gmwBound_' + key;
      if (el[guardKey]) return;
      el[guardKey] = true;
      el.addEventListener('click', handler);
    }

    function loadWindowsArchivePassword() {
      authFetch('/api/config/zip-password').then(function (r) { return r.json(); }).then(function (data) {
        var leg = (data.legacyPassword != null ? String(data.legacyPassword) : (data.password != null ? String(data.password) : '')).trim();
        var legEl = document.getElementById('config-windows-zip-legacy-password');
        if (legEl) legEl.value = leg;
        var ov = data.brandPasswords && typeof data.brandPasswords === 'object' ? data.brandPasswords : {};
        brands.forEach(function (b) {
          var el = document.getElementById('config-windows-archive-password-' + b);
          if (!el) return;
          el.value = Object.prototype.hasOwnProperty.call(ov, b) ? String(ov[b] != null ? ov[b] : '') : leg;
        });
      }).catch(function () {});
    }

    function loadConfigDownloadForBrand(brand) {
      var listEl = document.getElementById('config-download-files-list-' + brand);
      var msgEl = document.getElementById('config-download-files-message-' + brand);
      authFetch('/api/config/download?brand=' + encodeURIComponent(brand))
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          var files = (data && data.files) ? data.files : [];
          if (!listEl) return;
          listEl.innerHTML = '';
          for (var i = 0; i < files.length; i++) {
            var item = files[i] || {};
            var name = item.fileName || null;
            var downloads = item.downloads != null ? item.downloads : 0;
            var limit = item.limit != null ? item.limit : 0;
            if (!name) continue;
            var row = document.createElement('div');
            row.className = 'config-file-row';
            var nameAttr = String(name).replace(/"/g, '&quot;');
            row.innerHTML =
              '<span class="config-file-num">' + (i + 1) + '.</span>' +
              '<span class="config-file-name config-file-name--copy" data-file-name="' + nameAttr + '" title="Копировать ссылку">' + escapeHtml(name) + '</span>' +
              ' <span class="config-file-stats">' + downloads + '/</span>' +
              '<input type="number" class="config-file-limit" min="0" step="1" value="' + limit + '" data-index="' + i + '" data-file-name="' + escapeHtml(name) + '" aria-label="Лимит">' +
              '<button type="button" class="btn btn-sm config-file-delete" data-file-name="' + nameAttr + '" title="Удалить из конфига">✕</button>';
            listEl.appendChild(row);
          }
          listEl.querySelectorAll('.config-file-name--copy').forEach(function (span) {
            span.addEventListener('click', function () {
              var fileName = span.getAttribute('data-file-name');
              if (!fileName) return;
              var url = (window.location.origin || '') + '/download/' + encodeURIComponent(fileName);
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(function () {
                  if (msgEl) {
                    msgEl.textContent = 'Ссылка скопирована';
                    msgEl.className = 'config-msg success';
                    msgEl.classList.remove('hidden');
                    setTimeout(function () {
                      msgEl.classList.add('hidden');
                    }, 1500);
                  }
                }).catch(function () {});
              } else {
                var ta = document.createElement('textarea');
                ta.value = url;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                if (msgEl) {
                  msgEl.textContent = 'Ссылка скопирована';
                  msgEl.className = 'config-msg success';
                  msgEl.classList.remove('hidden');
                  setTimeout(function () {
                    msgEl.classList.add('hidden');
                  }, 1500);
                }
              }
            });
          });
          listEl.querySelectorAll('.config-file-limit').forEach(function (input) {
            input.addEventListener('change', function () {
              var fileName = input.getAttribute('data-file-name');
              var limit = parseInt(input.value, 10);
              if (isNaN(limit) || limit < 0) limit = 0;
              postJson('/api/config/download-limit', { fileName: fileName, limit: limit, brand: brand })
                .then(function () {
                  if (msgEl) {
                    msgEl.textContent = 'Лимит сохранён';
                    msgEl.className = 'config-msg success';
                    msgEl.classList.remove('hidden');
                    setTimeout(function () {
                      msgEl.classList.add('hidden');
                    }, 1500);
                  }
                })
                .catch(function () {
                  if (msgEl) {
                    msgEl.textContent = 'Ошибка';
                    msgEl.className = 'config-msg error';
                    msgEl.classList.remove('hidden');
                  }
                });
            });
          });
          listEl.querySelectorAll('.config-file-delete').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var fileName = btn.getAttribute('data-file-name');
              if (!fileName) return;
              if (!confirm('Удалить файл «' + fileName + '» из конфига Windows (' + brand + ')?')) return;
              postJson('/api/config/download-delete', { fileName: fileName, brand: brand })
                .then(function (r) {
                  if (r && r.ok) {
                    if (msgEl) {
                      msgEl.textContent = 'Удалено';
                      msgEl.className = 'config-msg success';
                      msgEl.classList.remove('hidden');
                      setTimeout(function () {
                        msgEl.classList.add('hidden');
                      }, 1500);
                    }
                    loadConfigDownload();
                  } else if (msgEl) {
                    msgEl.textContent = (r && r.error) || 'Ошибка';
                    msgEl.className = 'config-msg error';
                    msgEl.classList.remove('hidden');
                  }
                })
                .catch(function () {
                  if (msgEl) {
                    msgEl.textContent = 'Ошибка сети';
                    msgEl.className = 'config-msg error';
                    msgEl.classList.remove('hidden');
                  }
                });
            });
          });
        })
        .catch(function () {});
    }

    function loadConfigDownload() {
      for (var bi = 0; bi < brands.length; bi++) {
        loadConfigDownloadForBrand(brands[bi]);
      }
    }

    var configWindowsZipLegacySave = document.getElementById('config-windows-zip-legacy-password-save');
    var configWindowsZipLegacyMsg = document.getElementById('config-windows-zip-legacy-password-message');
    if (configWindowsZipLegacySave) {
      bindClickOnce(configWindowsZipLegacySave, 'windowsLegacyZipSave', function () {
        var pwdEl = document.getElementById('config-windows-zip-legacy-password');
        var pwdVal = (pwdEl && pwdEl.value) ? String(pwdEl.value).trim() : '';
        postJson('/api/config/zip-password', { password: pwdVal })
          .then(function () {
            if (configWindowsZipLegacyMsg) {
              configWindowsZipLegacyMsg.textContent = 'Общий пароль сохранён';
              configWindowsZipLegacyMsg.className = 'config-msg success';
              configWindowsZipLegacyMsg.classList.remove('hidden');
              setTimeout(function () {
                configWindowsZipLegacyMsg.classList.add('hidden');
              }, 2000);
            }
            loadWindowsArchivePassword();
          })
          .catch(function () {
            if (configWindowsZipLegacyMsg) {
              configWindowsZipLegacyMsg.textContent = 'Ошибка';
              configWindowsZipLegacyMsg.className = 'config-msg error';
              configWindowsZipLegacyMsg.classList.remove('hidden');
            }
          });
      });
    }
    function bindBrandWindowsZipPassword(brand) {
      var saveBtn = document.getElementById('config-windows-zip-password-save-' + brand);
      var inheritBtn = document.getElementById('config-windows-zip-password-inherit-' + brand);
      var pwdInp = document.getElementById('config-windows-archive-password-' + brand);
      var msgEl = document.getElementById('config-download-files-message-' + brand);
      function showZipMsg(text, ok) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'config-msg ' + (ok ? 'success' : 'error');
        msgEl.classList.remove('hidden');
        setTimeout(function () {
          msgEl.classList.add('hidden');
        }, 2200);
      }
      if (saveBtn && pwdInp) {
        bindClickOnce(saveBtn, 'windowsZipSave_' + brand, function () {
          var pwdVal = String(pwdInp.value != null ? pwdInp.value : '').trim();
          postJson('/api/config/zip-password', { brand: brand, password: pwdVal })
            .then(function () {
              showZipMsg('Пароль бренда сохранён', true);
              loadWindowsArchivePassword();
            })
            .catch(function () {
              showZipMsg('Ошибка', false);
            });
        });
      }
      if (inheritBtn) {
        bindClickOnce(inheritBtn, 'windowsZipInherit_' + brand, function () {
          postJson('/api/config/zip-password', { brand: brand, inheritLegacy: true })
            .then(function () {
              showZipMsg('Используется общий пароль', true);
              loadWindowsArchivePassword();
            })
            .catch(function () {
              showZipMsg('Ошибка', false);
            });
        });
      }
    }
    brands.forEach(bindBrandWindowsZipPassword);

    function bindWindowsDownloadSaveForBrand(brand) {
      var configDownloadFilesInput = document.getElementById('config-download-files-input-' + brand);
      var configDownloadFilesSave = document.getElementById('config-download-files-save-' + brand);
      var configDownloadFilesMessage = document.getElementById('config-download-files-message-' + brand);
      if (!configDownloadFilesSave || !configDownloadFilesInput) return;
      bindClickOnce(configDownloadFilesSave, 'windowsFilesSave_' + brand, function () {
        var fileList = configDownloadFilesInput.files;
        var pwdEl = document.getElementById('config-windows-archive-password-' + brand);
        var pwdVal = (pwdEl && pwdEl.value) ? String(pwdEl.value).trim() : '';
        if (!fileList || fileList.length === 0) {
          if (configDownloadFilesMessage) {
            configDownloadFilesMessage.textContent = 'Выберите файлы или сохраните пароль бренда кнопкой выше';
            configDownloadFilesMessage.className = 'config-msg error';
            configDownloadFilesMessage.classList.remove('hidden');
          }
          return;
        }
        if (configDownloadFilesMessage) {
          configDownloadFilesMessage.textContent = '';
          configDownloadFilesMessage.classList.add('hidden');
        }
        var fd = new FormData();
        for (var i = 0; i < fileList.length; i++) {
          fd.append('file', fileList[i]);
        }
        fd.append('brand', brand);
        if (pwdVal) fd.append('zipPassword', pwdVal);
        authFetch('/api/config/download-upload-multi', { method: 'POST', body: fd, credentials: 'same-origin' })
          .then(function (r) {
            return r.text().then(function (text) {
              var data = null;
              try {
                data = text ? JSON.parse(text) : {};
              } catch (e) {
                return { httpOk: r.ok, data: null, raw: text || '', status: r.status };
              }
              return { httpOk: r.ok, data: data, raw: text, status: r.status };
            });
          })
          .then(function (pack) {
            var data = pack.data;
            if (pack.httpOk && data && data.ok) {
              if (configDownloadFilesMessage) {
                configDownloadFilesMessage.textContent =
                  'Сохранено: ' +
                  (data.uploadedCount != null
                    ? data.uploadedCount
                    : data.files
                      ? data.files.filter(function (f) {
                          return f && f.fileName;
                        }).length
                      : 0) +
                  ' файл(ов)';
                configDownloadFilesMessage.className = 'config-msg success';
                configDownloadFilesMessage.classList.remove('hidden');
              }
              configDownloadFilesInput.value = '';
              loadConfigDownload();
              loadWindowsArchivePassword();
            } else {
              var msg = (data && data.message) || (data && data.error) || '';
              if (!msg && !pack.httpOk && pack.status === 413) {
                msg =
                  '413 — ответ не от Node (часто HTML от nginx): лимит тела запроса. В server { } для этого хоста задайте client_max_body_size 200m; (при необходимости повторите внутри location /). Проверка и перезагрузка: nginx -t && sudo nginx -s reload. Готовые строки: файл репозитория config/nginx-snippet-large-uploads.conf или config/nginx-grzl-org.conf.';
              }
              if (!msg && !pack.httpOk) msg = 'HTTP ' + (pack.status || '');
              if (!msg && pack.raw && pack.raw.length < 200) msg = pack.raw;
              if (!msg) msg = 'Ошибка';
              if (configDownloadFilesMessage) {
                configDownloadFilesMessage.textContent = msg;
                configDownloadFilesMessage.className = 'config-msg error';
                configDownloadFilesMessage.classList.remove('hidden');
              }
            }
          })
          .catch(function () {
            if (configDownloadFilesMessage) {
              configDownloadFilesMessage.textContent = 'Ошибка загрузки';
              configDownloadFilesMessage.className = 'config-msg error';
              configDownloadFilesMessage.classList.remove('hidden');
            }
          });
      });
    }
    for (var wbi = 0; wbi < brands.length; wbi++) {
      bindWindowsDownloadSaveForBrand(brands[wbi]);
    }

    return { loadConfigDownload: loadConfigDownload, loadWindowsArchivePassword: loadWindowsArchivePassword };
  }

  global.initAdminConfigPaneWindows = initAdminConfigPaneWindows;
})(typeof window !== 'undefined' ? window : this);
