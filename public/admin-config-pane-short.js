/** Config modal — pane «Short» (#config-pane-short). Loaded before admin.js; wired from initConfigModal. */
(function (global) {
  'use strict';

  /**
   * @param {{
   *   authFetch: function(string, object=): Promise<Response>,
   *   postJson: function(string, object): Promise<Response>,
   *   showToast: function(string): void,
   *   copyToClipboard: function(string): void
   * }} deps
   * @returns {{ loadConfigShort: function(): void }|undefined}
   */
  function initAdminConfigPaneShort(deps) {
    if (
      !deps ||
      typeof deps.authFetch !== 'function' ||
      typeof deps.postJson !== 'function' ||
      typeof deps.showToast !== 'function' ||
      typeof deps.copyToClipboard !== 'function'
    ) {
      return;
    }

    var authFetch = deps.authFetch;
    var postJson = deps.postJson;
    var showToast = deps.showToast;
    var copyToClipboard = deps.copyToClipboard;
    function bindClickOnce(el, key, handler) {
      if (!el || typeof el.addEventListener !== 'function' || typeof handler !== 'function') return;
      var guardKey = '__gmwBound_' + key;
      if (el[guardKey]) return;
      el[guardKey] = true;
      el.addEventListener('click', handler);
    }

    var SHORT_PATH_STATUS_SS = 'gmwShortPathProbe_v1';
    function readShortPathStatusAll() {
      try {
        var raw = sessionStorage.getItem(SHORT_PATH_STATUS_SS);
        if (!raw) return {};
        var o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : {};
      } catch (e1) {
        return {};
      }
    }
    function shortPathCacheKey(domain, slug) {
      return String(domain || '').toLowerCase() + '|' + String(slug || '');
    }
    /** Те же ✓/✕/круг что у CONFIG → Бренды (`config-brand-provision-icon`). */
    function setShortProvisionIconButton(btn, state, row) {
      btn.textContent = '';
      btn.className =
        'config-brand-provision-icon' + (row ? ' config-brand-provision-icon--short-row' : '');
      if (state === 'loading') {
        btn.classList.add('config-brand-provision-icon--loading');
      } else if (state === 'ready') {
        btn.classList.add('config-brand-provision-icon--ok');
        btn.textContent = '\u2713';
      } else if (state === 'error') {
        btn.classList.add('config-brand-provision-icon--err');
        btn.textContent = '\u2715';
      } else {
        btn.classList.add('config-brand-provision-icon--idle');
      }
    }
    function writeShortPathStatusEntry(domain, slug, entry) {
      try {
        var o = readShortPathStatusAll();
        o[shortPathCacheKey(domain, slug)] = entry;
        sessionStorage.setItem(SHORT_PATH_STATUS_SS, JSON.stringify(o));
      } catch (e2) {}
    }
    function applyShortPathStatusToCircle(btn, domain, slug) {
      var o = readShortPathStatusAll();
      var e = o[shortPathCacheKey(domain, slug)];
      if (!e || !e.state) return false;
      setShortProvisionIconButton(btn, e.state, true);
      if (e.state === 'error' && e.message) {
        btn.setAttribute('title', String(e.message));
      } else if (e.state === 'ready') {
        btn.setAttribute('title', 'Ок — проверить снова');
      } else {
        btn.setAttribute('title', 'Проверить доступность ссылки');
      }
      return true;
    }

    function loadConfigShort() {
      var listEl = document.getElementById('config-short-list');
      if (!listEl) return;
      listEl.innerHTML = '';
      authFetch('/api/config/short-domains').then(function (r) { return r.json(); }).then(function (data) {
        var list = (data && data.list) ? data.list : [];
        list.forEach(function (item) {
          var card = document.createElement('article');
          card.className = 'config-short-card';

          var top = document.createElement('div');
          top.className = 'config-short-card__top';

          var collapseKey = 'gmwShortCardCollapsed:' + item.domain;
          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'config-short-card__collapse';
          toggle.setAttribute('aria-label', 'Свернуть карточку');
          toggle.setAttribute('aria-expanded', 'true');
          toggle.textContent = '▼';

          var cluster = document.createElement('div');
          cluster.className = 'config-short-card__status-cluster';

          var statusKey =
            item.status === 'ready' ? 'ready' : item.status === 'error' ? 'error' : 'pending';
          var titlePending = 'Проверить доступность (HTTP/HTTPS)';
          var titleOk = 'Проверить снова';
          var titleErr = item.message ? String(item.message) : 'Проверить снова';
          var titleLoad = 'Проверка…';
          var circleTitle =
            item.status === 'error' && item.message ? titleErr : item.status === 'ready' ? titleOk : titlePending;

          var circle = document.createElement('button');
          circle.type = 'button';
          setShortProvisionIconButton(circle, statusKey, false);
          circle.setAttribute('aria-label', 'Проверить');
          circle.setAttribute('title', circleTitle);
          circle.addEventListener('click', function (ev) {
            ev.stopPropagation();
            try {
              sessionStorage.removeItem('gmwShortDnsOnce');
            } catch (e) {}
            if (circle.disabled) return;
            circle.disabled = true;
            setShortProvisionIconButton(circle, 'loading', false);
            circle.setAttribute('aria-label', titleLoad);
            circle.setAttribute('title', titleLoad);
            statusText.textContent = 'Проверка…';
            statusText.className = 'config-short-card__status-text config-short-card__status-text--loading';
            postJson('/api/config/short-domains-check', { domain: item.domain })
              .catch(function () {})
              .finally(function () {
                loadConfigShort();
              });
          });

          var meta = document.createElement('div');
          meta.className = 'config-short-card__meta';
          var domainEl = document.createElement('span');
          domainEl.className = 'config-short-card__domain';
          domainEl.textContent = item.domain;
          var statusText = document.createElement('span');
          statusText.className = 'config-short-card__status-text config-short-card__status-text--' + statusKey;
          statusText.textContent =
            item.status === 'ready' ? 'Ок' : item.status === 'error' ? 'Ошибка' : 'Ожидание';
          meta.appendChild(domainEl);
          meta.appendChild(statusText);

          cluster.appendChild(circle);
          cluster.appendChild(meta);

          var delDomainBtn = document.createElement('button');
          delDomainBtn.type = 'button';
          delDomainBtn.className = 'btn btn-ghost btn-sm config-short-card__del';
          delDomainBtn.textContent = 'Удалить';
          delDomainBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (!confirm('Удалить домен ' + item.domain + ' и все короткие ссылки?')) return;
            authFetch('/api/config/short-domains?domain=' + encodeURIComponent(item.domain), { method: 'DELETE' })
              .then(function () { loadConfigShort(); })
              .catch(function () { showToast('Ошибка'); loadConfigShort(); });
          });

          top.appendChild(toggle);
          top.appendChild(cluster);
          top.appendChild(delDomainBtn);
          card.appendChild(top);

          var body = document.createElement('div');
          body.className = 'config-short-card__body';

          try {
            if (localStorage.getItem(collapseKey) === '1') {
              body.classList.add('is-collapsed');
              toggle.setAttribute('aria-expanded', 'false');
              toggle.textContent = '▶';
              toggle.setAttribute('aria-label', 'Развернуть карточку');
            }
          } catch (lsErr) {}

          toggle.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var collapsed = body.classList.toggle('is-collapsed');
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            toggle.textContent = collapsed ? '▶' : '▼';
            toggle.setAttribute('aria-label', collapsed ? 'Развернуть карточку' : 'Свернуть карточку');
            try {
              localStorage.setItem(collapseKey, collapsed ? '1' : '0');
            } catch (ls2) {}
          });

          if (item.status === 'error' && item.message) {
            var msgRow = document.createElement('div');
            msgRow.className = 'config-short-card__alert';
            msgRow.textContent = item.message;
            body.appendChild(msgRow);
          }

          var genRow = document.createElement('div');
          genRow.className = 'config-short-card__generate';
          var targetInput = document.createElement('input');
          targetInput.type = 'url';
          targetInput.className = 'config-input config-short-card__gen-input';
          targetInput.placeholder = 'example.com/… (https подставится) или https://…';
          targetInput.autocomplete = 'off';
          var genBtn = document.createElement('button');
          genBtn.type = 'button';
          genBtn.className = 'btn btn-primary btn-sm config-short-card__gen-btn';
          genBtn.textContent = 'Создать ссылку';
          genBtn.addEventListener('click', function () {
            var pathLinkUrl = (targetInput.value || '').trim();
            if (!pathLinkUrl) {
              showToast('Введите целевую ссылку');
              return;
            }
            genBtn.disabled = true;
            postJson('/api/config/short-domains', { domain: item.domain, pathLinkUrl: pathLinkUrl, targetUrl: item.targetUrl || '', whitePageStyle: item.whitePageStyle || '' })
              .then(function (r) { return r.json(); })
              .then(function (res) {
                if (res && res.shortUrl) {
                  showToast('Готово: ' + res.shortUrl);
                  targetInput.value = '';
                } else if (res && res.error) showToast(res.error);
                loadConfigShort();
              })
              .catch(function () { showToast('Ошибка'); loadConfigShort(); })
              .finally(function () { genBtn.disabled = false; });
          });
          genRow.appendChild(targetInput);
          genRow.appendChild(genBtn);
          body.appendChild(genRow);

          var pathWrap = document.createElement('div');
          pathWrap.className = 'config-short-links';
          var linksList = document.createElement('div');
          linksList.className = 'config-short-links__list';
          var links = (item.pathLinks && item.pathLinks.length) ? item.pathLinks : [];
          if (links.length === 0) {
            var emptyPl = document.createElement('div');
            emptyPl.className = 'config-short-links__empty';
            emptyPl.textContent = '—';
            linksList.appendChild(emptyPl);
          } else {
            links.forEach(function (pl) {
              var plRow = document.createElement('div');
              plRow.className = 'config-short-link-item';
              var topLine = document.createElement('div');
              topLine.className = 'config-short-link-item__topline';

              var pathTitlePending = 'Проверить доступность ссылки';
              var pathTitleLoad = 'Проверка…';
              var pathCircle = document.createElement('button');
              pathCircle.type = 'button';
              setShortProvisionIconButton(pathCircle, 'pending', true);
              pathCircle.setAttribute('aria-label', 'Проверить ссылку');
              if (!applyShortPathStatusToCircle(pathCircle, item.domain, pl.slug)) {
                pathCircle.setAttribute('title', pathTitlePending);
              }
              pathCircle.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (pathCircle.disabled) return;
                pathCircle.disabled = true;
                setShortProvisionIconButton(pathCircle, 'loading', true);
                pathCircle.setAttribute('aria-label', pathTitleLoad);
                pathCircle.setAttribute('title', pathTitleLoad);
                postJson('/api/config/short-path-check', { domain: item.domain, slug: pl.slug })
                  .then(function (r) { return r.json(); })
                  .then(function (res) {
                    if (res && res.status === 'ready') {
                      setShortProvisionIconButton(pathCircle, 'ready', true);
                      pathCircle.setAttribute('title', 'Ок — проверить снова');
                      writeShortPathStatusEntry(item.domain, pl.slug, { state: 'ready', message: '' });
                    } else {
                      var errMsg = (res && res.message) ? String(res.message) : 'Ошибка';
                      setShortProvisionIconButton(pathCircle, 'error', true);
                      pathCircle.setAttribute('title', errMsg);
                      writeShortPathStatusEntry(item.domain, pl.slug, { state: 'error', message: errMsg });
                    }
                  })
                  .catch(function () {
                    setShortProvisionIconButton(pathCircle, 'error', true);
                    pathCircle.setAttribute('title', 'Запрос не удался');
                    writeShortPathStatusEntry(item.domain, pl.slug, { state: 'error', message: 'Запрос не удался' });
                  })
                  .finally(function () {
                    pathCircle.disabled = false;
                    pathCircle.setAttribute('aria-label', 'Проверить ссылку');
                  });
              });

              var copyBtn = document.createElement('button');
              copyBtn.type = 'button';
              copyBtn.className = 'config-short-link-item__href';
              copyBtn.textContent = pl.shortUrl;
              copyBtn.setAttribute('title', 'Скопировать ссылку');
              copyBtn.addEventListener('click', function () {
                copyToClipboard(pl.shortUrl);
              });

              var actions = document.createElement('div');
              actions.className = 'config-short-link-item__actions';

              var openBtn = document.createElement('button');
              openBtn.type = 'button';
              openBtn.className = 'config-short-link-item__icon-btn';
              openBtn.setAttribute('aria-label', 'Открыть в новой вкладке');
              openBtn.title = 'Открыть в новой вкладке';
              openBtn.innerHTML = '<svg class="config-short-link-item__svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
              openBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                try {
                  window.open(pl.shortUrl, '_blank', 'noopener,noreferrer');
                } catch (e3) {
                  var a = document.createElement('a');
                  a.href = pl.shortUrl;
                  a.target = '_blank';
                  a.rel = 'noopener noreferrer';
                  a.click();
                }
              });

              var delPlBtn = document.createElement('button');
              delPlBtn.type = 'button';
              delPlBtn.className = 'btn btn-ghost btn-sm config-item-trash config-item-trash--icon config-short-link-item__trash';
              delPlBtn.setAttribute('aria-label', 'Удалить ссылку');
              delPlBtn.title = 'Удалить';
              delPlBtn.addEventListener('click', function () {
                if (!confirm('Удалить ' + pl.shortUrl + '?')) return;
                authFetch('/api/config/short-domains?domain=' + encodeURIComponent(item.domain) + '&slug=' + encodeURIComponent(pl.slug), { method: 'DELETE' })
                  .then(function () { loadConfigShort(); })
                  .catch(function () { showToast('Ошибка'); loadConfigShort(); });
              });

              actions.appendChild(openBtn);
              actions.appendChild(delPlBtn);
              topLine.appendChild(pathCircle);
              topLine.appendChild(copyBtn);
              topLine.appendChild(actions);
              plRow.appendChild(topLine);
              var urlHint = document.createElement('div');
              urlHint.className = 'config-short-link-item__target';
              urlHint.textContent = pl.url;
              plRow.appendChild(urlHint);
              linksList.appendChild(plRow);
            });
          }
          pathWrap.appendChild(linksList);
          body.appendChild(pathWrap);

          var gateDetails = document.createElement('details');
          gateDetails.className = 'config-short-gate';
          var gateSum = document.createElement('summary');
          gateSum.className = 'config-short-gate__summary';
          gateSum.textContent = 'Гейт';
          gateDetails.appendChild(gateSum);
          var gateBody = document.createElement('div');
          gateBody.className = 'config-short-gate__body';
          var gateInput = document.createElement('input');
          gateInput.type = 'text';
          gateInput.className = 'config-input';
          gateInput.placeholder = '';
          gateInput.value = item.targetUrl || '';
          var gateStyle = document.createElement('select');
          gateStyle.className = 'config-input';
          gateStyle.innerHTML = '<option value="">Impressum</option><option value="news-webde">WEB.DE</option>';
          gateStyle.value = item.whitePageStyle === 'news-webde' ? 'news-webde' : '';
          var gateSave = document.createElement('button');
          gateSave.type = 'button';
          gateSave.className = 'btn btn-ghost btn-sm';
          gateSave.textContent = 'Сохранить';
          gateSave.addEventListener('click', function () {
            gateSave.disabled = true;
            postJson('/api/config/short-domains', {
              domain: item.domain,
              targetUrl: (gateInput.value || '').trim(),
              whitePageStyle: gateStyle.value || '',
              pathLinkUrl: ''
            })
              .then(function () { showToast('Сохранено'); loadConfigShort(); })
              .catch(function () { showToast('Ошибка'); })
              .finally(function () { gateSave.disabled = false; });
          });
          gateBody.appendChild(gateInput);
          gateBody.appendChild(gateStyle);
          gateBody.appendChild(gateSave);
          gateDetails.appendChild(gateBody);
          body.appendChild(gateDetails);

          card.appendChild(body);

          listEl.appendChild(card);
        });
        if (list.length === 0) {
          listEl.innerHTML = '<div class="config-short-empty"><div class="config-short-empty__icon" aria-hidden="true"></div><p class="config-short-empty__title">Нет доменов</p></div>';
        }
        var pendingDomains = list.filter(function (i) { return i.status === 'pending'; });
        try {
          if (pendingDomains.length === 0) sessionStorage.removeItem('gmwShortDnsOnce');
        } catch (e) {}
        var siteAuto = data && data.siteAutoCheck !== false;
        var pendingAuto = false;
        try {
          pendingAuto = sessionStorage.getItem('gmwShortDnsOnce') === '1';
        } catch (e2) {}
        if (pendingDomains.length && siteAuto && !pendingAuto) {
          try {
            sessionStorage.setItem('gmwShortDnsOnce', '1');
          } catch (e3) {}
          Promise.all(pendingDomains.map(function (i) {
            return postJson('/api/config/short-domains-check', { domain: i.domain });
          }))
            .catch(function () {})
            .finally(function () {
              loadConfigShort();
            });
        }
      }).catch(function () {
        if (listEl) {
          listEl.innerHTML = '<div class="config-short-empty config-short-empty--error"><p class="config-short-empty__title">Ошибка загрузки</p></div>';
        }
      });
    }

    var configShortAddDomain = document.getElementById('config-short-add-domain');
    var configShortNewDomain = document.getElementById('config-short-new-domain');
    var configShortMsg = document.getElementById('config-short-message');
    if (configShortAddDomain && configShortNewDomain) {
      bindClickOnce(configShortAddDomain, 'shortAddDomain', function () {
        var domain = (configShortNewDomain.value || '').trim().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();
        if (!domain) {
          showToast('Введите домен');
          return;
        }
        configShortAddDomain.disabled = true;
        postJson('/api/config/short-domains', { domain: domain, targetUrl: '', pathLinkUrl: '', whitePageStyle: '' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok !== false) {
              showToast('Домен добавлен');
              configShortNewDomain.value = '';
              try {
                sessionStorage.removeItem('gmwShortDnsOnce');
              } catch (eRm) {}
              loadConfigShort();
            } else {
              showToast((data && data.error) || 'Ошибка');
            }
          })
          .catch(function (err) { showToast(err.message || 'Ошибка'); })
          .finally(function () {
            configShortAddDomain.disabled = false;
            if (configShortMsg) configShortMsg.classList.add('hidden');
          });
      });
    }

    return { loadConfigShort: loadConfigShort };
  }

  global.initAdminConfigPaneShort = initAdminConfigPaneShort;
})(typeof window !== 'undefined' ? window : globalThis);
