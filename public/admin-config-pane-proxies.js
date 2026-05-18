/** Config modal: proxies pane (`/api/config/proxies*`). Loaded before admin.js. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   authFetch: function(string, object=): Promise<Response>,
   *   postJson: function(string, object): Promise<object>,
   *   syncCodeEditorHeights: function(): void,
   *   adminNonJsonHint: function(string, number): string,
   *   getProxyStatsForLine: function(string): (object|null),
   *   buildInlineStatsNode: function(object|null): HTMLElement,
   *   loadProxyFpStats: function(): Promise<void>
   * }} deps
   * @returns {{ loadConfigProxies: function(): void, rerenderProxiesEditor: function(number=): void }|undefined}
   */
  function initAdminConfigPaneProxies(deps) {
    if (!deps) return;
    if (typeof deps.authFetch !== 'function' || typeof deps.postJson !== 'function') return;
    if (typeof deps.syncCodeEditorHeights !== 'function') return;
    if (typeof deps.adminNonJsonHint !== 'function') return;
    if (typeof deps.getProxyStatsForLine !== 'function' || typeof deps.buildInlineStatsNode !== 'function') return;
    if (typeof deps.loadProxyFpStats !== 'function') return;

    var authFetch = deps.authFetch;
    var postJson = deps.postJson;
    var syncCodeEditorHeights = deps.syncCodeEditorHeights;
    var adminNonJsonHint = deps.adminNonJsonHint;
    var getProxyStatsForLine = deps.getProxyStatsForLine;
    var buildInlineStatsNode = deps.buildInlineStatsNode;
    var loadProxyFpStats = deps.loadProxyFpStats;
    function bindClickOnce(el, key, handler) {
      if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return;
      var guardKey = '__gmwBound_' + key;
      if (el[guardKey]) return;
      el[guardKey] = true;
      el.addEventListener('click', handler);
    }

    var proxiesAutoSaveTimer = null;

    function showProxiesMessage(text, type) {
      var el = document.getElementById('config-proxies-message');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
      el.classList.toggle('success', type === 'success');
      el.classList.toggle('error', type === 'error');
    }

    function parseProxiesLines(text) {
      var out = [];
      String(text || '').split(/\r?\n/).forEach(function (line) {
        var s = String(line || '').trim();
        if (!s || s.charAt(0) === '#') return;
        out.push(s);
      });
      return out;
    }

    function scheduleProxiesAutoSave() {
      if (proxiesAutoSaveTimer) clearTimeout(proxiesAutoSaveTimer);
      proxiesAutoSaveTimer = setTimeout(function () {
        proxiesAutoSaveTimer = null;
        var ta = document.getElementById('config-proxies-text');
        if (!ta) return;
        postJson('/api/config/proxies', { content: ta.value })
          .then(function () {
            showProxiesMessage('Сохранено', 'success');
            try { loadProxyFpStats(); } catch (_) {}
          })
          .catch(function (err) {
            showProxiesMessage((err && err.message) || 'Ошибка сохранения', 'error');
          });
      }, 700);
    }

    function renderProxiesEditor(focusRowIndex) {
      var ta = document.getElementById('config-proxies-text');
      var listWrap = document.getElementById('config-proxies-list-wrap');
      if (!ta || !listWrap) return;
      var lines = parseProxiesLines(ta.value);
      listWrap.innerHTML = '';
      var uiLines = lines.slice();
      uiLines.push('');
      var rowInputs = [];

      uiLines.forEach(function (s, i) {
        var isAdderRow = i === (uiLines.length - 1);
        var row = document.createElement('div');
        row.className = 'config-item-row';
        var left = document.createElement('div');
        left.className = 'config-item-left';
        var n = document.createElement('span');
        n.className = 'config-item-index';
        n.textContent = String(i + 1);
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'config-item-input';
        input.value = s;
        if (isAdderRow) input.placeholder = 'Вставьте прокси (каждый с новой строки) или введите вручную';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.addEventListener('input', function () {
          try {
            window.__gmwProxyValidateByLine = null;
          } catch (_) {}
          var cur = parseProxiesLines(ta.value);
          var v = String(input.value || '').trim();
          if (isAdderRow) {
            if (v) cur.push(v);
            ta.value = cur.join('\n');
            renderProxiesEditor(cur.length - 1);
          } else {
            cur[i] = v;
            ta.value = cur.filter(function (x) { return x && x.trim(); }).join('\n');
          }
          scheduleProxiesAutoSave();
        });
        input.addEventListener('paste', function (ev) {
          var cd = (ev && ev.clipboardData) ? ev.clipboardData : (window.clipboardData || null);
          if (!cd) return;
          var raw = cd.getData('text');
          if (typeof raw !== 'string') return;
          if (raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) return;
          var pasted = parseProxiesLines(raw);
          if (!pasted.length) return;
          if (ev && ev.preventDefault) ev.preventDefault();
          try {
            window.__gmwProxyValidateByLine = null;
          } catch (_) {}
          var cur = parseProxiesLines(ta.value);
          if (isAdderRow) {
            Array.prototype.push.apply(cur, pasted);
          } else {
            cur.splice.apply(cur, [i, 1].concat(pasted));
          }
          ta.value = cur.join('\n');
          renderProxiesEditor(isAdderRow ? (cur.length - 1) : (i + pasted.length - 1));
          scheduleProxiesAutoSave();
        });
        left.appendChild(n);
        left.appendChild(input);

        var right = document.createElement('div');
        right.className = 'config-item-right';
        if (!isAdderRow) {
          right.appendChild(buildInlineStatsNode(getProxyStatsForLine(s)));
          try {
            var valMap = window.__gmwProxyValidateByLine;
            if (valMap && typeof valMap === 'object') {
              var st = valMap[s.trim()];
              if (st) {
                var vb = document.createElement('span');
                if (st.ok && st.warn) {
                  vb.className = 'config-proxy-validate config-proxy-validate--warn';
                  vb.textContent = 'Проверка: OK (403 WEB.DE)';
                  vb.title = String(st.warn);
                } else if (st.ok) {
                  vb.className = 'config-proxy-validate config-proxy-validate--ok';
                  vb.textContent = 'Проверка: OK';
                  vb.title = 'TCP + HTTPS до auth.web.de (или SOCKS5)';
                } else {
                  vb.className = 'config-proxy-validate config-proxy-validate--bad';
                  vb.textContent = 'Не работает';
                  vb.title = String(st.error || 'Ошибка проверки');
                }
                right.appendChild(vb);
              }
            }
          } catch (_) {}

          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'btn btn-ghost btn-sm config-item-trash config-item-trash--icon';
          del.title = 'Удалить прокси';
          del.setAttribute('aria-label', 'Удалить прокси');
          del.addEventListener('click', function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
            var cur = parseProxiesLines(ta.value);
            var next = cur.filter(function (_, idx) { return idx !== i; });
            ta.value = next.join('\n');
            renderProxiesEditor();
            postJson('/api/config/proxies', { content: ta.value })
              .then(function () {
                showProxiesMessage('Сохранено', 'success');
                try { loadProxyFpStats(); } catch (_) {}
              })
              .catch(function (err) {
                showProxiesMessage((err && err.message) || 'Ошибка сохранения', 'error');
              });
          });
          right.appendChild(del);
        }

        row.appendChild(left);
        row.appendChild(right);
        listWrap.appendChild(row);
        rowInputs.push(input);
      });

      if (typeof focusRowIndex === 'number' && focusRowIndex >= 0 && focusRowIndex < rowInputs.length) {
        setTimeout(function () {
          try {
            rowInputs[focusRowIndex].focus();
            rowInputs[focusRowIndex].select();
          } catch (_) {}
        }, 0);
      }
    }

    function loadConfigProxies() {
      var textEl = document.getElementById('config-proxies-text');
      var msgEl = document.getElementById('config-proxies-message');
      if (!textEl) return;
      try {
        window.__gmwProxyValidateByLine = null;
      } catch (_) {}
      if (msgEl) {
        msgEl.textContent = '';
        msgEl.classList.add('hidden');
      }
      authFetch('/api/config/proxies')
        .then(function (r) {
          return r.text().then(function (txt) {
            return { ok: r.ok, status: r.status, txt: txt };
          });
        })
        .then(function (w) {
          var data = {};
          try {
            data = w.txt && String(w.txt).trim() ? JSON.parse(w.txt) : {};
          } catch (eJ) {
            showProxiesMessage(adminNonJsonHint('Ответ /api/config/proxies', w.status), 'error');
            return;
          }
          if (!w.ok) {
            showProxiesMessage((data && data.error) ? String(data.error) : 'Ошибка загрузки прокси HTTP ' + w.status, 'error');
            return;
          }
          textEl.value = (data.content != null ? String(data.content) : '').trim();
          syncCodeEditorHeights();
          renderProxiesEditor();
        })
        .catch(function (err) {
          showProxiesMessage((err && err.message) || 'Ошибка сети при загрузке прокси', 'error');
        });
    }

    var configProxiesSave = document.getElementById('config-proxies-save');
    if (configProxiesSave) {
      bindClickOnce(configProxiesSave, 'proxiesSave', function () {
        var textEl = document.getElementById('config-proxies-text');
        if (!textEl) return;
        postJson('/api/config/proxies', { content: textEl.value })
          .then(function () {
            showProxiesMessage('Сохранено', 'success');
            renderProxiesEditor();
            try { loadProxyFpStats(); } catch (_) {}
          })
          .catch(function (err) {
            showProxiesMessage((err && err.message) || 'Ошибка сохранения', 'error');
          });
      });
    }

    var configProxiesValidate = document.getElementById('config-proxies-validate');
    if (configProxiesValidate) {
      bindClickOnce(configProxiesValidate, 'proxiesValidate', function () {
        var textEl = document.getElementById('config-proxies-text');
        if (!textEl) return;
        showProxiesMessage('Проверка…');
        configProxiesValidate.disabled = true;
        postJson('/api/config/proxies-validate', { content: textEl.value })
          .then(function (r) {
            return r.text().then(function (txt) {
              var j = {};
              try {
                j = txt && String(txt).trim() ? JSON.parse(txt) : {};
              } catch (eP) {
                throw new Error(adminNonJsonHint('Ответ проверки', r.status));
              }
              return { ok: r.ok, status: r.status, json: j };
            });
          })
          .then(function (w) {
            if (!w.ok) throw new Error((w.json && w.json.error) ? w.json.error : ('HTTP ' + w.status));
            var v = (w.json && w.json.valid) ? w.json.valid.length : 0;
            var b = (w.json && w.json.invalid) ? w.json.invalid.length : 0;
            var map = {};
            (w.json && w.json.valid ? w.json.valid : []).forEach(function (x) {
              var k = String(x.line || '').trim();
              if (k) map[k] = { ok: true, warn: String(x.warn || '').trim() };
            });
            (w.json && w.json.invalid ? w.json.invalid : []).forEach(function (x) {
              var k = String(x.line || '').trim();
              if (k) map[k] = { ok: false, error: String(x.error || 'ошибка') };
            });
            window.__gmwProxyValidateByLine = map;
            renderProxiesEditor();
            var samples = (w.json && w.json.invalid ? w.json.invalid : [])
              .slice(0, 2)
              .map(function (x) { return String(x.error || '').slice(0, 72); })
              .filter(Boolean);
            var tail = samples.length ? ' — ' + samples.join('; ') : '';
            var warnN = 0;
            (w.json && w.json.valid ? w.json.valid : []).forEach(function (x) {
              if (x && String(x.warn || '').trim()) warnN++;
            });
            var warnPart = warnN ? ' · с замечанием (часто 403 WEB.DE): ' + warnN : '';
            showProxiesMessage('Рабочих: ' + v + warnPart + ', не работает: ' + b + tail, b > 0 ? 'error' : 'success');
          })
          .catch(function (err) {
            showProxiesMessage((err && err.message) || 'Ошибка проверки', 'error');
          })
          .finally(function () {
            configProxiesValidate.disabled = false;
          });
      });
    }

    var configProxiesAddRow = document.getElementById('config-proxies-add-row');
    if (configProxiesAddRow) {
      bindClickOnce(configProxiesAddRow, 'proxiesAddRow', function () {
        var ta = document.getElementById('config-proxies-text');
        if (!ta) return;
        var cur = parseProxiesLines(ta.value);
        ta.value = cur.join('\n');
        renderProxiesEditor(cur.length);
      });
    }

    return {
      loadConfigProxies: loadConfigProxies,
      rerenderProxiesEditor: renderProxiesEditor
    };
  }

  global.initAdminConfigPaneProxies = initAdminConfigPaneProxies;
})(typeof window !== 'undefined' ? window : globalThis);
