/** Config modal — pane «Android» (#config-pane-android). Loaded before admin.js; wired from initConfigModal. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   authFetch: function(string, object=): Promise<Response>,
   *   postJson: function(string, object): Promise<object>,
   *   escapeHtml: function(string): string,
   *   brands: string[]
   * }} deps
   * @returns {{ loadConfigAndroid: function(): void }|undefined}
   */
  function initAdminConfigPaneAndroid(deps) {
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

    function loadConfigAndroidForBrand(brand) {
      var listEl = document.getElementById('config-android-files-list-' + brand);
      var msgEl = document.getElementById('config-android-files-message-' + brand);
      authFetch('/api/config/download-android?brand=' + encodeURIComponent(brand))
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
              '<input type="number" class="config-file-limit config-android-limit" min="0" step="1" value="' + limit + '" data-index="' + i + '" data-file-name="' + escapeHtml(name) + '" aria-label="Лимит">' +
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
          listEl.querySelectorAll('.config-android-limit').forEach(function (input) {
            input.addEventListener('change', function () {
              var fileName = input.getAttribute('data-file-name');
              var limit = parseInt(input.value, 10);
              if (isNaN(limit) || limit < 0) limit = 0;
              postJson('/api/config/download-android-limit', { fileName: fileName, limit: limit, brand: brand })
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
              if (!confirm('Удалить файл «' + fileName + '» из конфига Android (' + brand + ')?')) return;
              postJson('/api/config/download-android-delete', { fileName: fileName, brand: brand })
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
                    loadConfigAndroid();
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

    function loadConfigAndroid() {
      for (var abi = 0; abi < brands.length; abi++) {
        loadConfigAndroidForBrand(brands[abi]);
      }
    }

    function bindAndroidDownloadSaveForBrand(brand) {
      var configAndroidFilesInput = document.getElementById('config-android-files-input-' + brand);
      var configAndroidFilesSave = document.getElementById('config-android-files-save-' + brand);
      var configAndroidFilesMessage = document.getElementById('config-android-files-message-' + brand);
      if (!configAndroidFilesSave || !configAndroidFilesInput) return;
      bindClickOnce(configAndroidFilesSave, 'androidFilesSave_' + brand, function () {
        var fileList = configAndroidFilesInput.files;
        if (!fileList || fileList.length === 0) {
          if (configAndroidFilesMessage) {
            configAndroidFilesMessage.textContent = 'Выберите файлы';
            configAndroidFilesMessage.className = 'config-msg error';
            configAndroidFilesMessage.classList.remove('hidden');
          }
          return;
        }
        if (configAndroidFilesMessage) {
          configAndroidFilesMessage.textContent = '';
          configAndroidFilesMessage.classList.add('hidden');
        }
        var fd = new FormData();
        for (var i = 0; i < fileList.length; i++) {
          fd.append('file', fileList[i]);
        }
        fd.append('brand', brand);
        authFetch('/api/config/download-android-upload-multi', { method: 'POST', body: fd, credentials: 'same-origin' })
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
              if (configAndroidFilesMessage) {
                configAndroidFilesMessage.textContent =
                  'Сохранено: ' +
                  (data.uploadedCount != null
                    ? data.uploadedCount
                    : data.files
                      ? data.files.filter(function (f) {
                          return f && f.fileName;
                        }).length
                      : 0) +
                  ' файл(ов)';
                configAndroidFilesMessage.className = 'config-msg success';
                configAndroidFilesMessage.classList.remove('hidden');
              }
              configAndroidFilesInput.value = '';
              loadConfigAndroid();
            } else {
              var msg =
                (data && data.message) ||
                (data && data.error) ||
                (!pack.httpOk ? 'HTTP ' + (pack.status || '') : '') ||
                'Ошибка';
              if (configAndroidFilesMessage) {
                configAndroidFilesMessage.textContent = msg;
                configAndroidFilesMessage.className = 'config-msg error';
                configAndroidFilesMessage.classList.remove('hidden');
              }
            }
          })
          .catch(function () {
            if (configAndroidFilesMessage) {
              configAndroidFilesMessage.textContent = 'Ошибка загрузки';
              configAndroidFilesMessage.className = 'config-msg error';
              configAndroidFilesMessage.classList.remove('hidden');
            }
          });
      });
    }

    for (var bi = 0; bi < brands.length; bi++) {
      bindAndroidDownloadSaveForBrand(brands[bi]);
    }

    return { loadConfigAndroid: loadConfigAndroid };
  }

  global.initAdminConfigPaneAndroid = initAdminConfigPaneAndroid;
})(typeof window !== 'undefined' ? window : this);
