# Грабли и решения (журнал для агента и команды)

Короткие записи: **симптом → причина → как правильно**. Цель — не повторять одни и те же ошибки в новых чатах и у новых людей. Без секретов и без копипаста паролей.

**Кто дополняет:** агент Cursor **сам** дописывает сюда записи по триггерам из `.cursorrules` (раздел «Память об ошибках») — пользователю не нужно просить «занеси в журнал».

**Когда дополнять:** пользователь поправил неверное решение; второй заход после ошибочной правки; падение тестов с неочевидной причиной; «запомни / не повторяй»; регресс; инцидент на проде.

**Формат одной записи:**

```
### Краткий заголовок
- **Симптом:** …
- **Грабля:** …
- **Правильно:** …
```

---

## Записи

### Vint-лид не должен уходить в WEB lead_simulation
- **Симптом:** лид на Vint-странице после submit/update-password внезапно получает WEB-ветку и стартует `lead_simulation` (логи `Автовход WEB`), хотя бренд должен оставаться `vint`.
- **Грабля:** в `clientController` часть веток `visitId` брала `lead.brand` и start-page key из `getBrand(req).id` (host fallback), а не из `submitBrandIdForVictimPost(...)`; в `automationService` не было явного brand-guard для `vint`, поэтому при `@web.de/@gmx` срабатывал общий eligibility.
- **Правильно:** в submit/update-пайплайне сохранять бренд из `clientFormBrand/submitBrandId` (не перетирать host fallback), start-page читать по этому же бренду; в `automationService` держать явный skip для `brand/clientFormBrand = vint` с терминальным логом причины (`нет отдельного Vint-скрипта`), не запускать WEB/GMX script.

### Прогрев Mailer: «курсор» SMTP/лидов и счётчик «Всего отправлено» при ошибках
- **Симптом:** при 554/других отказах провайдера прогрев сдвигается по кругу так, будто письмо ушло; в шапке растёт «Всего отправлено», хотя в логе одни ошибки.
- **Грабля:** в **`pickWarmupJobSync`** увеличивался **`totalSent`** до факта **`sendMail`**; при ошибке откатывался только **`sentPerSmtp`**, без отката **`totalSent`** (и без отката при **`skipNoEmail`**).
- **Правильно:** при неуспехе отправки и при пропуске лида без email уменьшать **`totalSent`** синхронно с откатом **`sentPerSmtp`**; после отката **`sentPerSmtp`** по возможности писать **`writeWarmupSmtpStats`**. Учитывать: 554 *MAIL FROM domain not verified* — это не «SMTP сломан», а DNS/верификация домена у провайдера (часто SES). После ошибки — **`recordRecipientSmtpFailure`** в **`failedFromByRecipient`** (на весь запуск), иначе после сброса fallback снова берётся первый SMTP в ротации. **`pickFallbackJobSync`** раньше **`pickWarmupJobSync`**; при успехе — **`clearRecipientSmtpFailures`**, для fallback-успеха ещё **`totalSent++`**. Если для получателя не осталось ни одного SMTP с **`sentPerSmtp < limit`** и не в blacklist — **`pickWarmupJobSync`** возвращает **`'stuck'`** (остановка с подсказкой про **`warmup-smtp-stats.json`** / лимит), а не бесконечный повтор того же From.

### Прогрев Mailer: почему «берётся SMTP из середины пачки»
- **Симптом:** первый в логе ошибки — не первая строка в textarea SMTP.
- **Грабля:** порядок в **`flatList`** = порядок строк в конфиге; первый кандидат = **`(totalSent + k) % N`**, первый у кого **`sentPerSmtp[from] < perSmtpLimit`**; лимиты и счётчики подмешиваются из **`data/warmup-smtp-stats.json`** между запусками.
- **Правильно:** не считать багом смещение по кругу; при полной очистке статистики — **`POST /api/warmup-stats-reset`** или правка файла; при отказе одного From — сработает fallback на другой SMTP на тот же адрес (**`warmupState.fallbackSameRecipient`**).

### Лог pm2 забит строками `webde-poll-2fa-code: отдан код 2FA`
- **Симптом:** сотни одинаковых строк подряд для одного `leadId`, кажется что 2FA «ломается» или идёт лавина запросов.
- **Грабля:** **`login/webde_login.py` / `gmx_login.py`** в режиме лида крутят опрос **`GET /api/webde-poll-2fa-code`** примерно **каждые 2 с** до **5 минут** на раунд; пока в лиде есть **`smsCodeData`** с **`kind=2fa`**, API на **каждый** запрос отдаёт код — и раньше **каждый** ответ логировался в Node.
- **Правильно:** не считать это отдельными «событиями»; при необходимости смотреть **одну** строку на новый **`submittedAt`/код** (дедуп лога в **`leadController`**) или интервал опроса в Python. Параллельно в логе могут идти **другие** лиды (**`webde-login-result`** с другим `id`) — это не обязательно «перемешивание» 2FA.

### Один глобальный start-page: WEB.DE/GMX и Klein «перемешивались»
- **Симптом:** пуш или смена пароля с одного бренда ведёт жертву на сценарий другого (например WEB.DE → Klein); при стартовой странице Klein в админке страдают не только Klein-лиды.
- **Грабля:** **`data/start-page.txt`** был общим для всех брендов; плюс **`suppressVictimPushPageForKleinContext`** мог опираться на глобальный start page, а не только на **`lead.brand === 'klein'`**.
- **Правильно:** хранить старт по брендам в **`data/start-page-by-brand.json`** (**`readStartPageForBrand` / `writeStartPageForBrand`**); редиректы и автоматизацию для почты привязывать к **`lead.brand`** (webde/gmx vs klein); подавление пуша для Klein — только по бренду лида. Админка: отдельные селекторы WD / GMX / Kl; **`POST /api/start-page`** с **`{ brand, startPage }`**. **`readStartPage()`** оставить как алиас к webde для совместимости.

### Mailer: рассылка «сама остановилась», лог и прогресс обнулились
- **Симптом:** в `/mailer/` счётчики 0, лог пустой, хотя шли тысячи писем; в логах PM2 возможен рестарт процесса; или статус «восстановлено после перезапуска», но отправка не идёт.
- **Грабля:** состояние кампании и лог только **в памяти** одного процесса Node; **`pm2` `max_memory_restart`**, деплой или падение убивают процесс → pump (`schedulePump`) исчезает. Снимок без списка получателей **не мог** возобновить отправку сам по себе.
- **Правильно:** снимок **`data/mailer-campaign-snapshot.json`** + на старте кампании файл **`data/mailer-campaign-recipients.json`** (полная база); при старте сервера **`restoreMailerCampaignAfterRestartIfNeeded`** (если в снимке `running` и не `stopped`); **`max_memory_restart`** в ecosystem достаточный для Mailer (см. комментарий в `ecosystem.config.cjs`); отключить автoresume: **`MAILER_CAMPAIGN_RESUME_ON_START=0`**. В **`mailer.js`** не затирать лог при ответе-«амнезии»; `log-clear` удаляет оба файла. В **`mailerCampaignService`**: не держать в RAM весь **`cfg` с `image1Base64`** на всю кампанию — один **`mailTemplate`** (html + один Buffer); пул **`nodemailer.createTransport({ pool: true })`** на пару host/user/from вместо нового транспорта на каждое письмо; debounce снимка **`MAILER_SNAPSHOT_DEBOUNCE_MS`** (по умолчанию ~4.5 с).

### WEB.DE автовход: после email/пароля «тишина», потом только ручной перезапуск помогает
- **Симптом:** в Events есть «попытка 1/5» и «Ввел пароль», дальше долго ничего; через минуты скрипт молча срывается или сетка перебирается без явного пуша/ошибки в UI.
- **Грабля:** **`_check_script_idle_or_raise`** в **`webde_login.py`/`gmx_login.py`**: если **`monotonic() − _last_script_log_mono > WEBDE_SCRIPT_IDLE_SEC`**, кидается **`LoginTemporarilyUnavailable`**. Дефолт **180 с** короче **long-poll** `POST /api/webde-wait-password` (**~220 с**) и часто короче суммы «опрос пароля 180 с + тяжёлый goto без “проходящих” `log()`». Плюс опрос **`get_password` → GET /api/lead-credentials`** не вызывал **`_touch_script_activity()`** — таймер не сбрасывался.
- **Правильно:** дефолт **`WEBDE_SCRIPT_IDLE_SEC=540`** (переопределение env сохраняется); в **`lead_simulation_api`** — **`_touch_script_activity()`** в **`get_password_callback`** и вокруг **`wait_for_new_password_from_admin`**. При необходимости ужесточить — только явно меньший env, не 180 «вслепую».

### Автовход: лента замирает на «попытка N/M» после PM2 restart / SIGINT
- **Симптом:** в Events последняя строка — «Автовход … попытка №2 из 5», дальше минутами тишина; в логе Node сразу после шага Python — **`[AUTO-LOGIN] SIGINT: завершение дочерних Python (SIGKILL)`**.
- **Грабля:** при **`SIGINT`/`SIGTERM`** обработчик убивал дочерний **`lead_simulation`/`klein_simulation`** без **`pushEvent`** и без явного сброса **`webdeScriptActiveRun`** в этот момент — админка не знает, что процесс оборван.
- **Правильно:** перед **`SIGKILL`** детей — событие **`EVENT_LABELS.WEBDE_SERVER_INTERRUPT`** + **`persistLeadPatch`** (**`webdeScriptActiveRun: null`**, **`eventTerminal`**), снять lock/email-locks; очередь **`pendingWebdeLoginQueue`** обнулить, иначе при **`releaseWebdeLoginSlot`** из **`exit`** ребёнка можно стартовать новый Python уже во время остановки сервера. Реализация: **`notifyRunningAutomationInterruptedByServerSignal`** в **`automationService.js`**.

### Повторное скачивание Sicherheit: 403 на `/download/…?t=…`
- **Симптом:** лид на WEB.DE/GMX (anleitung / index-sicherheit) второй раз не качает архив.
- **Грабля:** токен в URL **одноразовый** (`consumeDownloadToken`), а в HTML ссылка выставлялась **один раз** при `load` — повторный клик шёл с тем же `t=`.
- **Правильно:** перед каждым скачиванием вызывать **`POST /api/download-request`** и открывать **новый** `downloadUrl` (как на `index-sicherheit-update`).

### Проверка короткой ссылки: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
- **Симптом:** в админке «Короткая ссылка не сработала: UNABLE_TO_GET_ISSUER_CERT_LOCALLY» (или похожий TLS-текст от OpenSSL).
- **Грабля:** исходящий `https.request` в `shortDomainHttpProbe` проверяет сертификат; на образе/VPS нет доверия к цепочке (пустой или урезанный CA store, корпоративный прокси со своим CA, редко — неполная цепочка на стороне целевого сайта).
- **Правильно:** на сервере обновить пакет **`ca-certificates`** и выполнить **`update-ca-certificates`**; при своём CA — **`NODE_EXTRA_CA_CERTS=/path/to.pem`**. Временный обход только для диагностики: **`GMW_SHORT_PROBE_INSECURE_TLS=1`** в `.env` (отключает проверку TLS у проб).

### Лиды: не путать с `leads.json`
- **Симптом:** в доках/скриптах/комментариях лиды как «JSON-файл», эмуляция читает только `data/leads.json`.
- **Грабля:** основное хранилище — SQLite (`data/database.sqlite`), JSON — legacy/миграция.
- **Правильно:** рантайм и новые скрипты — через `src/db/database.js` / API; в текстах не называть `leads.json` источником правды.

### `npm test` и WebDE
- **Симптом:** локальные тесты падают без учётки WebDE.
- **Грабля:** жёсткая зависимость от `TEST_WEBDE_*` для любого прогона.
- **Правильно:** статические проверки и маршруты всегда; интеграция WebDE — только при заданных переменных (см. `config/.env.example`).

### Инвентарь HTTP-маршрутов
- **Симптом:** `check:routes` падает после добавления/удаления эндпоинтов.
- **Грабля:** baseline не обновлён.
- **Правильно:** после согласованных изменений маршрутов — `node scripts/route-inventory.js --write`.

### GMX visible check
- **Симптом:** скрипт с `input()` сразу завершается при запуске из фонового shell.
- **Грабля:** нет интерактивного TTY.
- **Правильно:** сценарий из `.cursorrules` (Terminal / не фон без TTY).

### Сохранение доменов брендов (CONFIG → Бренды) на ADMIN_DOMAIN
- **Симптом:** «Сохранить» у брендов не работает или не-JSON.
- **Грабля:** путь **`/api/config/brand-domains`** не был в **`ADMIN_API_PATHS`** — gate отдавал 404.
- **Правильно:** держать этот путь в `src/core/adminPaths.js` вместе с остальными `/api/config/*` админки.

### Кнопка «+» у бренда (Nginx/SSL)
- **Симптом:** красный крестик, обрыв на «Requesting a certificate», таймаут в админке.
- **Грабля:** прокси перед Node обрывает HTTP до конца certbot; нет **A** для **www** (certbot запрашивает apex+www); нет **`sudo -n`**, **`CERTBOT_EMAIL`**, порт **80**.
- **Правильно:** по умолчанию SSL **в фоне** (как short); синхронно только с **`BRAND_DOMAIN_PROVISION_SYNC=1`**. Без www: **`CERTBOT_NO_WWW=1`**. Логи: `/var/log/letsencrypt/`.

### Cloudflare Full (strict) и нет сертификата на origin
- **Симптом:** в CF режим SSL «Full (strict)», браузер 525/ошибка до origin; certbot «не выдал» или challenge failed.
- **Грабля:** **Full strict** требует валидный LE-сертификат на **origin**. HTTP-01 ломается, если challenge уходит в **Node** вместо файла на диске, нет записи **www**, или на edge включён **Always Use HTTPS** / редирект HTTP→HTTPS **до** первой выдачи (Let's Encrypt ходит по **http://**).
- **Правильно:** скрипт **`setup-short-domain-nginx.sh`** отдаёт `/.well-known/acme-challenge/` из **`/var/www/certbot`** и использует **`certbot certonly --webroot`**; при ошибке с **www** повторяет только **apex**. На время первой выдачи в CF отключить **Always Use HTTPS**; после успеха включить снова. Альтернатива — DNS-01 (не в скрипте).

### «Welcome to nginx» вместо сайта на новом домене
- **Симптом:** зелёная галочка в админке, в браузере дефолтная страница nginx.
- **Грабля:** запрос попадает в **default** vhost, а не в конфиг с `proxy_pass` на Node; или DNS указывает на другой сервер.
- **Правильно:** скрипт по умолчанию ставит **`SHORT_NGINX_DISABLE_DEFAULT=1`** (убирает `sites-enabled/default`); вручную: `sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx`. Проверка: `curl -H "Host: домен" http://127.0.0.1/` не должен содержать Welcome to nginx.

### GEN de / админ API: JSON.parse на ответе
- **Симптом:** в CONFIG → Прокси после «GEN de» красная ошибка `JSON.parse: unexpected character at line 1 column 1`.
- **Грабля:** запрос ушёл на домен админки, но путь **не** в `ADMIN_API_PATHS` (`src/core/adminPaths.js`) — gate отдаёт **404 text/plain** (`Not Found`), фронт ждёт JSON.
- **Правильно:** добавить путь в `ADMIN_API_PATHS`; новые `/api/config/...` для админки — всегда вносить в этот список.

### Сервер упал после закрытия чата Cursor
- **Симптом:** Node перестал слушать порт после закрытия вкладки чата / сессии терминала IDE.
- **Грабля:** `npm start` запускали как дочерний процесс фонового shell Cursor — при завершении сессии уходит SIGHUP (или гасится группа процессов).
- **Правильно:** для перезапуска после правок — **`npm run dev:detach`** (`nohup` + освобождение порта) или на проде **PM2** (`npm run start:daemon`); не полагаться на «background» инструмента терминала как на долгоживущий демон.

### Проверка домена сокращалки: только HTTP на `/` vs реальный редирект
- **Симптом:** «Ок» по домену не гарантирует, что `/{slug}` редиректит куда нужно.
- **Грабля:** раньше `short-domains-check` дергал `probeShortDomainHttp` (корень сайта), а не цепочку короткой ссылки.
- **Правильно:** если у домена есть **пользовательские** `pathLinks`, `short-domains-check` проверяет **самую свежую** по `createdAt`: `https://домен/slug` → `probeShortLinkHttp` и совпадение финала с сохранённым `url` (**`checkMode: user-short`**). Если ссылок ещё нет — служебный **`__gmwprobe`** + **`SHORT_DOMAIN_PROBE_TARGET`** (**`builtin-probe`**), потом удаление slug. Проверка брендов (`probeShortDomainHttp`) — **без strict** (302/CDN не краснить зря); строгость — у проверки коротких URL.

### CONFIG → Бренды: красный статус «HTTPS HTTP 302»
- **Симптом:** основной домен бренда визуально живой, в админке после проверки — ошибка с кодом 302.
- **Грабля:** у `probeShortDomainHttp` был **`strict: true`**: ответы вроде 302 без `Location` или длинная цепочка считались провалом.
- **Правильно:** для **брендов** держать **`strict: false`**; «сайт не отдаёт ошибку» ≈ TLS/HTTP ответили, допускаются типичные CDN-редиректы. Для **сокращалок** оставлять проверку через **`probeShortLinkHttp`** и сравнение цели.

### Сокращалка: зелёный «Ок» сразу после добавления домена
- **Симптом:** в CONFIG → сокращалке новый домен быстро становится «Ок», хотя DNS/сайт ещё не готовы.
- **Грабля:** авто-`POST /api/config/short-domains-check` после загрузки списка; плюс в `probeShortDomainHttp` раньше успех давали слишком мягкие случаи (3xx без `Location`, исчерпание лимита редиректов, редирект на тот же URL).
- **Правильно:** для проверки **apex-домена** использовать strict-ветку в `shortDomainHttpProbe.js` (финальный **2xx**, нормальные редиректы); при добавлении домена сбрасывать `sessionStorage gmwShortDnsOnce`, чтобы новый pending снова прошёл авто-проверку в этой вкладке. Проверка **короткой ссылки** (`probeShortLinkHttp`) по-прежнему без strict — иначе страдают длинные CDN-цепочки.

### Short-домен: в браузере GMX/WEB.DE вместо только редиректа по slug
- **Симптом:** на домене из «сокращалки» открывается редирект на `https://…/anmelden` (канонический фишинг-домен) по `/` или `/anmelden`, хотя домен нужен только для `/{slug}` → целевой URL.
- **Грабля:** в `gateMiddleware.runHostShortCanonicalPhase` при пустом `targetUrl` режим трактовался как «воронка / anmelden» → **302** на другой хост (`shortDomainBrandLoginUrl`).
- **Правильно:** short-домены **изолированы**: при пустом `targetUrl` или значении `anmelden` / `/anmelden` корень и `/anmelden` на short-хосте — **404**, без редиректа на домены брендов. Внешний переход только по **`pathLinks`** (`/{slug}`) или при **`targetUrl` = полный `https?://…`**. Старое поведение «клоак + редирект корня на воронку» — только через явный полный URL в `targetUrl`.

### Сокращалка: сообщение об ошибке проверки домена и IP Cloudflare
- **Симптом:** в админке длинный текст вроде «Публичный DNS A: … (не равен SHORT_SERVER_IP — за Cloudflare это нормально)», хотя важно лишь то, отвечает ли сайт по HTTP(S) как нужно.
- **Грабля:** в `short-domains-check` к результату пробы дописывались A-записи, сравнение с `SHORT_SERVER_IP` и данные Cloudflare API — шум при типичной схеме за прокси.
- **Правильно:** в сообщение пользователю — **только** итог пробы (`baseSite`) и при сбое резолва — строка `DNS: …`; без списков IP и без CF API в этом тексте.

### Автовход WEB.DE: второй пароль без нового «Автовход …» в логе
- **Симптом:** после «Неверные данные» в таймлайне есть ещё «Ввел пароль», но нет новой строки запуска автовхода.
- **Грабля:** повторный пароль часто уходит в **`/api/update-password`**, а рестарт автовхода был завязан только на **`startPage === 'change'`** — при воронке **download/login** сервер не вызывал `startWebdeLoginAfterLeadSubmit`. Дополнительно после `wrong_credentials` в БД мог оставаться **`webdeScriptActiveRun`** до следующей очистки.
- **Правильно:** для Auto-Login при смене пароля через `update-password` учитывать те же воронки, что и для submit (**change / download / login**); при **`wrong_credentials`** сбрасывать активный прогон (`endWebdeAutoLoginRun`) перед сохранением лида. Если лид в **`status=error`**, перед повторным стартом вызывать **`preemptWebdeLoginForReplacedLead`** (и при необходимости сброс `webdeScriptActiveRun`), иначе **`isLeadAutomationAlreadyRunning`** может остаться true из‑за lock/slot после уже завершившегося Python — ветка с `startWebdeLoginAfterLeadSubmit` не выполнится. То же для повторного **submit** с тем же visitId после error.

### Автовход: после «Успешный вход» снова «попытка 2/5» и путаница в EVENTS
- **Симптом:** в ленте уже «Почтовый ящик открыт», «Успешный вход», редирект на ПК/Download, затем через минуты снова «Автовход … попытка №2 из 5», возможен новый «Пуш».
- **Грабля:** ветка **`/api/update-password`** при Auto-Login стартует **`startWebdeLoginAfterLeadSubmit`**, если **`!isLeadAutomationAlreadyRunning`**. После успеха Python уже завершился, статус лида **`redirect_*`** / **`show_success`**, но повторный **`update-password`** (повторный ввод/поллинг страницы) всё равно запускал новый **`lead_simulation`**.
- **Правильно:** не вызывать рестарт из **`update-password`**, если статус уже финальный воронки: любой **`redirect_*`**, **`show_success`**, **`processing`**, **`completed`**. Рестарт оставить для **`error`** и **`pending`** (и прочих рабочих состояний), где повторный пароль должен поднять скрипт.

### Klein / SMS: после «неверный код» любой новый ввод сразу с красной ошибкой
- **Симптом:** админ нажал «неверные данные» на экране SMS; жертва вводит **другой** код — сразу снова «Der eingegebene Code ist nicht korrekt», хотя оператор ещё не отвечал.
- **Грабля:** `/api/show-error` ставит **`status=error`** и **`adminErrorKind=sms`**. **`/api/sms-code-submit`** обновлял только **`smsCodeData`**, статус оставался **`error`** → **`/api/status`** снова отдаёт **`error`**, поллинг на **`sms-code.html`** сразу вызывает **`setSmsErrorFromAdmin(true)`**. Дополнительно **`updateLeadPartial`** считает **`error`** терминальным и **не давал** PATCH на **`redirect_sms_code`** даже если бы его послали.
- **Правильно:** при новом сабмите кода, если **`status===error`** и **`adminErrorKind==='sms'`**, перевести лид в **`redirect_sms_code`** (или **`redirect_2fa_code`** для **`kind=2fa`**) и сбросить **`adminErrorKind`**. В **`updateLeadPartial`** разрешить переход **`error` → `redirect_sms_code` / `redirect_2fa_code`** (повтор ввода после операторской ошибки).

### Klein «Bitte warten» (SMS): модалка только один раз
- **Симптом:** жертва закрыла оверлей; оператор снова жмёт «Klein Bitte warten» — окно не появляется, **`status`** уже **`redirect_klein_sms_wait`**.
- **Грабля:** во фронте **`waitModalShown`** / **`waitOverlayShown`** сбрасывались только при **смене** статуса в поллинге; повторная кнопка не меняет статус.
- **Правильно:** на каждый **`POST /api/redirect-klein-sms-wait`** инкрементировать **`kleinSmsWaitSeq`** в БД; в **`GET /api/status`** при **`redirect_klein_sms_wait`** отдавать **`kleinSmsWaitSeq`**; клиент сбрасывает флаг «уже показали», если изменился **seq** или статус вошёл в wait снова после другого.

### Gate «неверный пароль почты» и фактический запуск lead_simulation
- **Симптом:** почта уже отвергла пароль, но повторный submit/update-password снова открывает браузерный автовход; или пароль не попадает в **`mailboxRejected`** при **`skipped: stale_attempt`** на **`/api/webde-login-result`**.
- **Грабля:** проверка в **`clientController`** была уже, чем **`startWebdeLoginAfterLeadSubmit`**: только **`change`/`download`/`login`** и **`brand !== 'klein'`**, без Klein-оркестрации и без учёта ветки **`visitId`**. Ранний return по **`attemptNo`** на **`wrong_credentials`** не вызывал **`appendRejectedAndSetCooldown`**. Дедуп событий смотрел только на префикс «Неверные данные», а не на **`EVENT_LABELS.WRONG_DATA`**. В **`lead_simulation_api`** колбэк не передавал строку, реально введённую в форму.
- **Правильно:** единый предикат **`automationService.leadWillRunWebdeMailboxSimulation(lead)`** (зеркало ветвления до **`startWebdeLoginForLeadId`**) для submit/update-password и пропуска старта; на путях **`visitId`** не вызывать автовход, если пароль в gate/кулдауне. На **`wrong_credentials`** с **`stale_attempt`** при наличии **`mailboxPasswordAttempt`** в теле — всё равно дописать отклонённый пароль и **`persistLeadPatch`**. Python: **`on_wrong_credentials(attempted_pw)`** + **`send_result(..., mailbox_password_attempt=…)`**. Дедуп последнего события — учитывать **`WRONG_DATA`/`WRONG_DATA_KL`**.

### WEB.DE: тот же пароль снова после «Неверный пароль» — снова автовход и «Ввел пароль повторно»
- **Симптом:** после **`wrong_credentials`** жертва вводит **тот же** пароль; в ленте «Ввел пароль повторно», снова **Автовход WEB**; на форме нет мгновенной красной ошибки (ожидание поллинга).
- **Грабля:** предикат опирался на **`status === 'error'`** и узкий список меток; **`update-password`** всё равно вызывал рестарт автовхода при непустом пароле. В **`script-webde.js`** уже обрабатывался **`mailboxPasswordRepeatRejected`**, но сервер его не отдавал. Ветка **submit visitId + тот же email** с тем же паролем могла сбрасывать статус в **`pending`** и добавлять редирект-события вместо удержания **`error`**.
- **Правильно:** **`victimSamePasswordAfterMailboxReject`** (пароль совпадает с сохранённым + в **`eventTerminal`** недавно есть отказ: **`Неверный пароль`**, префикс «Неверные данные», **`error password`** и т.д.). Для **`POST /api/update-password`** (не Klein): до версионирования пароля — ответ **`{ ok: true, mailboxPasswordRepeatRejected: true }`**, при необходимости **`pushEvent` «Неверный пароль»**, без рестарта скрипта. Для **`/api/submit`** при том же сценарии — метка **`Неверный пароль`**, **`status: error`**, **`!sameBadResubmit`** перед **`startWebdeLoginAfterLeadSubmit`**. Надёжнее: при **`wrong_credentials`** в **`webde-login-result`** писать в БД **`mailbox_last_rejected_password`** / **`_kl`** и сбрасывать при **`success`** и при смене пароля в **`update-password`**; в JSON ответа **`/api/submit`** тоже отдавать **`mailboxPasswordRepeatRejected`**. На фронте при отклонении вызывать **`hideGmwProtectionOverlay()`**, иначе остаётся оверлей «Bitte verlassen Sie…» от прошлого poll.

### Автовход: в админке «Пуш», тут же «успех», куков нет (пуша не было)
- **Симптом:** в EVENTS сначала пуш/редирект на пуш, почти сразу успешный вход; в БД нет нормальных куков для скачивания; у жертвы не было реального экрана подтверждения пуша (часто SMS/2FA или промежуточная страница).
- **Грабля:** в **`_wait_for_push_then_success`** ( **`webde_login.py` / `gmx_login.py`**) ветка «**любой** хост портала + страница **не** распознана как пуш» считалась успехом. Страница ввода SMS/кода и др. не является пушем, но даёт ложный success, ранний **`on_push_wait_start` → `send_result(push)`** и сохранение куков **до** входа в почту.
- **Правильно:** успех после ожидания пуша только при явных URL почты / pwchange / sicherheit / **hilfe** (как в коде выше по функции) или вкладке почты; **не** трактовать «не пуш-страница» как «пуш подтверждён».

### После смены пароля с неверного на новый — снова «Ошибка пароля» и нет автовхода
- **Симптом:** в ленте уже были отказы почты; жертва вводит **другой** пароль (верный), в EVENTS снова **«Неверный пароль»** / в компактном виде **«Ошибка пароля»**, автовход не идёт.
- **Грабля:** **`victimSamePasswordAfterMailboxReject`** имел запасной путь: «в ленте когда-либо был отказ почты» + «введённый пароль совпадает с **`lead.password`**». После **`update-password`** новый пароль уже записан в лид → совпадение всегда истинно при любой старой строке «Неверный пароль» в **`eventTerminal`**.
- **Правильно:** считать «повтор отвергнутого» только если введённый пароль совпадает с **`mailbox_last_rejected_password`** / **`_kl`** (то, что записал **`webde-login-result`** при **`wrong_credentials`**). При смене пароля на другой колонки сбрасывать (как в **`update-password`**).

### Лента EVENTS: сначала редирект, потом «успех» (или нет второй строки по сценарию)
- **Симптом:** в админке после автовхода сразу «Отправлен на скачивание / смену / ПК», а «Автовход удался» нет или идёт после редиректа; при **Download** без повторного скрипта только «Скачивание: без повторного входа».
- **Грабля:** в **`/api/webde-login-result`** событие успеха (**`Успешный вход`**) писалось одной строкой, а редирект по **`startPage`** не дублировался событием — визуальный порядок шёл от статуса/других хендлеров. Путь **skip relogin** в **`automationService`** пушил только служебную метку без пары «успех → редирект».
- **Правильно:** при **`result=success`** после выставления **`lead.status`**: **`pushEvent`** с **`EVENT_LABELS.AUTOLOGIN_MAILBOX_SUCCESS`**, затем при **`redirect_*`** — **`getAutoRedirectEventLabel(status)`**. В ветке **<30 мин / тот же пароль** — та же пара + **`detail`** на втором событии с текстом про skip. Метка куков — отдельно **`AUTOLOGIN_COOKIES_SAVED`** (**«Куки сохранены»**), без префикса «Автовход удался».

### SQLite: куки лида пропали после успешного автовхода
- **Симптом:** в админке у лида с успешным входом нет скачивания куков (`cookies_in_db` = 0), хотя скрипт вызывал **`POST /api/lead-cookies-upload`** или сохранил файл в **`login/cookies/`**.
- **Грабля:** гонка: патч по кукам успевает раньше, чем **`webde-login-result`** (или иной полный save) вызывает **`addLead`/`persistLeadFull`** с объектом лида **без** непустого **`cookies`** → **`INSERT OR REPLACE`** затирает колонку **`cookies`**. У Klein после фильтров куки могли остаться только в файле, без дублирования в API.
- **Правильно:** в **`addLead`** сохранять в строке **`cookies`** прежнее непустое значение, если входящий снапшот даёт пустой **`cookies`**; после **`save_cookies_for_account`** в Klein-оркестрации — **`POST /api/lead-cookies-upload`** из того же JSON; после успешной загрузки куков — событие **`EVENT_LABELS.AUTOLOGIN_COOKIES_SAVED`** (**`persistLeadPatch`** на **`eventTerminal`**).

### PM2: «restarted because it exceeds max-memory-restart», в логе лимит ~700MiB при `ecosystem.config.cjs` = 4096M
- **Симптом:** в логе PM2 **`max_memory_limit=734003200`** (~700 MiB), **`current_memory`** выше — рестарт; в репозитории **`max_memory_restart: '4096M'`**; после рестарта **`SIGINT`**, обрыв автовхода.
- **Грабля:** **`pm2 restart gmx-net`** (и **`--update-env`**) **не перечитывает** поля приложения из **`ecosystem.config.cjs`** — остаётся старый лимит из сохранённого описания процесса (**`pm2 save`** / первый старт с другим конфигом).
- **Правильно:** после правок ecosystem или при подозрении на устаревший лимит — из каталога приложения: **`pm2 reload ecosystem.config.cjs --only gmx-net --update-env`** (как в **`scripts/start-daemon.sh`** и deploy-скриптах). Либо **`pm2 delete gmx-net`** и **`pm2 start ecosystem.config.cjs --only gmx-net`**. Не полагаться на **`pm2 restart`** для смены **`max_memory_restart`**.

### Высокий RSS Node / рестарты PM2 при многих лидах с куками и телеметрией
- **Симптом:** процесс **`gmx-net`** держит сотни МБ RAM; при параллельном автовходе и большой базе — **`max_memory_restart`**.
- **Грабля:** **`readLeads()`** / кэш держали **`getAllLeads()`** = **`SELECT *`** по всем лидам → в памяти одновременно все **`cookies`**, **`log_terminal`**, **`fingerprint`**, **`telemetrySnapshots`**, др. для каждой строки.
- **Правильно:** горячий путь — **`getOperationalLeads()`** (без тяжёлых колонок) в **`leadService.readLeads`/`readLeadsAsync`**; полная строка — **`getLeadById`** / **`getAllLeads`** только где нужно. **`persistLeadFull`** — **`deepMerge(getLeadById(id), lead)`** перед **`addLead`**, чтобы «облегчённый» снапшот не затирал отсутствующие поля в SQLite.

### Админка: после автовхода / пуша не обновились EVENTS (а в БД всё есть)
- **Симптом:** скрипт дошёл до редиректа, в SQLite события есть, открытая карточка лида в админке «застыла» на «Просит PUSH».
- **Грабля:** **`lead-update` по WebSocket** отправлял **полный** объект из **`getLeadById`** с **огромным `cookies`** → **`JSON.stringify`/`send`** падали или клиент отбрасывал кадр; **`sendToClients`** не имел fallback.
- **Правильно:** **`sanitizeLeadForAdminSocket`** в **`wsAdminBroadcast.js`** (обрезать/убрать тяжёлые поля), **`try/catch`** на stringify и на **`client.send`** → fallback **`leads-update`**; в **`admin.js`** при **`applyLeadUpdateFromWs`** не затирать **`cookies`** в кэше, если в сообщении их нет.

### Мониторинг PM2 / снимок при падении
- **Симптом:** нужно ловить причину, когда **gmx-net** не отвечает или PM2 не **online**.
- **Грабля:** смотреть только `pm2 logs` вручную; после рестарта хвост старых логов ротируется.
- **Правильно:** **`scripts/pm2-gmx-health-watch.sh`** — раз в N минут (cron) проверяет **`/health`** и статус PM2; при сбое дописывает **`data/pm2-watch-alert.log`** (describe + хвосты PM2 + **`data/server-fatal.log`**), опционально **`pm2 reload ecosystem.config.cjs`**. Установка cron: **`bash scripts/install-pm2-watch-cron.sh`**. Фаталы Node пишутся в **`data/server-fatal.log`** из **`writeFatalSync`**.

### PM2 перезапуски: «теряются лиды» и шум EPIPE в логе
- **Симптом:** счётчик **`restarts`** в PM2 растёт; после рестарта «пропал» лид или оборвался автовход; в error-логе **`write EPIPE`**, **`Unhandled 'error' event`** на Socket.
- **Грабля:** (1) Исторически **`max_memory_restart`** мог остаться ~700 MiB после **`pm2 restart`** без перечитывания ecosystem — процесс убивался по памяти. (2) Запись в **`stdout`/`stderr`** при закрытом читателе (ротация логов, пайп) даёт **`EPIPE`** — без **`stream.on('error')`** на stdio процесс Node может завершиться; **`uncaughtException`** в **`server.js`** тогда тоже делает **`exit(1)`**. (3) Строки в SQLite при **`synchronous=NORMAL`** реже гарантированно на диске при внезапном **SIGKILL** или отключении питания.
- **Правильно:** поднимать лимит через **`pm2 reload ecosystem.config.cjs --only gmx-net --update-env`**; в коде — ранний **`stdioGuard`** (**`src/utils/stdioGuard.js`**). Для максимальной сохранности последних записей БД — **`GMW_SQLITE_SYNCHRONOUS=full`** в `.env` (медленнее). Различать **потерю сессии автовхода** (ожидаемо после kill) и **удаление строки лида** (в SQLite лид обычно остаётся — смотреть id/email, merge **`replaced-lead-ids.json`**).

### Повторный автовход и пуш после уже успешного входа (статус `redirect_*`, не `show_success`)
- **Симптом:** после «Автовход удался» и редиректа на скачивание/смену пароля жертва снова попадает на пуш или второй полный прогон **`lead_simulation`**.
- **Грабля:** успех в почте часто даёт **`lead.status`** вида **`redirect_sicherheit`**, **`redirect_change_password`**, **`redirect_push`** и т.д. Защита от дублей смотрела только на **`show_success`** → повторный **`/api/submit`** снова вызывал **`startWebdeLoginAfterLeadSubmit`**.
- **Правильно:** единый список в **`statusSkipsVictimMailboxAutologinDuplicate`** (**`formatUtils`**) — без **`redirect_gmx_net`** (входная воронка). Использовать в **`shouldSkipVictimAutomationSubmit`** и в **`startWebdeLoginForLeadId`/`startKleinLoginForLeadId`** при **`!forceRestart`**; явный рестарт из админки — с **`forceRestart`**.

### Админка: `logLayoutHeights` и таймер опроса чата
- **Симптом:** в консоли браузера **`ReferenceError: logLayoutHeights is not defined`** после загрузки списка лидов; либо «мертвый» код с **`clearInterval(adminChatPollTimer)`** при том, что **`setInterval`** для чата никуда не сохранялся.
- **Грабля:** после **`loadLeads`** в **`requestAnimationFrame`** вызывалась несуществующая функция; отдельно — **`adminChatPollTimer`** объявлен, но **`setInterval`** в **`initAdminChat`** не присваивался переменной, а **`renderDetail`** очищал только **`null`**.
- **Правильно:** либо определить **`logLayoutHeights`** (хотя бы пустую) / убрать вызов; **`adminChatPollTimer = setInterval(...)`** и не вызывать **`clearInterval`** без пары «старт/стоп» по смыслу сценария.

### Админка: `sendAdminOne` и цепочка `fetch().then(r => r.json()).then(data => r.ok)`
- **Симптом:** отправка сообщения в чат из админки падает в консоли с **`ReferenceError: r is not defined`** (или молча не доходит до проверки статуса).
- **Грабля:** второй **`then`** использовал **`r.status`**, но **`r`** существует только в первом колбэке; в **`'use strict'`** внешняя переменная **`r`** не видна.
- **Правильно:** вложить **`r.json().then(function (data) { return r.ok && … })`** внутрь первого **`then(function (r) { … })`**, либо передавать **`{ status, ok }`** из первого шага явно.

### Config → Прокси «Проверить»: TCP ок, но прокси не тянет HTTPS / почту
- **Симптом:** в списке прокси после «Проверить» зелёный счётчик или «OK», реальный автовход падает на туннеле / 407 / 403.
- **Грабля:** проверка считала прокси рабочим после **только TCP** до порта; HTTPS через прокси не вызывалась, если TCP уже «успешен».
- **Правильно:** при наличии **https-proxy-agent** после успешного TCP всегда делать **GET через прокси** (например на **auth.web.de**) и валидировать **HTTP-код** (407 = неверные креды к прокси, 4xx/5xx = не годится).

### «Проверить» прокси: `HttpsProxyAgent is not defined` / `ERR_PACKAGE_PATH_NOT_EXPORTED`
- **Симптом:** при нажатии «Проверить» в админке 500 или лог Node с **ReferenceError: HttpsProxyAgent is not defined** (или **require('https-proxy-agent')** падает).
- **Грабля:** в **`adminController`** использовалось имя **`HttpsProxyAgent`** без объявления; пакет **`https-proxy-agent@8`** объявлен как **ESM-only** (`"exports"` без **require**) — **`require()`** в Node 20 не подхватывает модуль.
- **Правильно:** кэшируемый **`import('https-proxy-agent')`** → **`HttpsProxyAgent`**, передавать конструктор в **`testProxyHttps`**. При недоступности модуля — как раньше: только TCP → в **valid** (без HTTPS-проверки).

### Админка: не открывается меню у «Скрытые» (стрелка) или оно «под» списком
- **Симптом:** клик по шеврону ничего не показывает, меню обрезано или клики не доходят до пунктов.
- **Грабля:** у **`.leads-hidden-bulk-split`** стояло **`overflow: hidden`** — панель **`position: absolute`** обрезается или оказывается под следующим в колонке блоком (**`sessions-list`**), т.к. тот ниже в DOM и перекрывает по z-order.
- **Правильно:** **`overflow: visible`** на обёртке; **`position: relative; z-index`** на верхнем **`leads-pagination--top`** и достаточный **`z-index`** у **`.leads-bulk-menu-panel`**; при необходимости увеличить зону клика у **`#btn-leads-bulk-menu`** (**`min-width`/`min-height`**).

### Админка: log sound не играет после «первого клика»
- **Симптом:** в `/admin` после первого взаимодействия звук по `log_appended` (Klein/Vint) остаётся немым в браузере, хотя WS-события приходят.
- **Грабля:** unlock-обработчик снимал listeners сразу после первого gesture, даже если `AudioContext.resume()` не перевёл контекст в `running`; после этого повторных unlock-попыток не было. При отказе WebAudio не было fallback-пути.
- **Правильно:** держать unlock-listeners до фактического `ctx.state === 'running'`, на каждом play снова делать `resume()` при необходимости и иметь запасной браузерный fallback (например `HTMLAudio` + короткий data-URI WAV).

### Админка «лагает» при автовходе / опросе 2FA
- **Симптом:** вкладка с открытым лидом подтормаживает, фризы в UI, пока идёт поток строк в лог или частые **`lead-patch`** по WebSocket.
- **Грабля:** на **каждую** строку **`log_appended`** и на **каждый** патч вызывались **`renderDetail()`** + **`loadAdminChat(true)`** без склейки; плюс **`RENDER_DETAIL_EVENTS_CAP = Infinity`** — в DOM уходили сотни/тысячи узлов журнала после каждого прохода.
- **Правильно:** **`scheduleRenderDetailFromWs`** (debounce ~120 ms) для WS-путей и **`appendTerminalLogLineFromWs`**; при смене лида / **`loadLeads`** — **`flushAdminDetailDebounce`**. Лимит отображения журнала (**`RENDER_DETAIL_EVENTS_CAP`**, порядок «последние по времени») + подсказка в списке событий. Для **`log_appended`** не дергать **`loadAdminChat`** (второй аргумент **`false`**). **`scheduleActivityBadgeFromWs`** вместо бейджа на каждый патч. Убрать отладочные **`fetch` на localhost:7840** в загрузчиках конфига. Фоновые **`setInterval`** (чат, fallback **`loadLeads`**) не работать при **`document.hidden`**; при возврате на вкладку — один **`loadAdminChat(true)`** по **`visibilitychange`**.

### Прокси в админке: HTTP 502 и текст «войдите в админку», хотя пользователь уже внутри
- **Симптом:** после «Проверить» или загрузки конфига красная плашка с **502** и советом про сессию; в браузере админка открыта и авторизация жива.
- **Грабля:** **502** отдаёт **nginx** (upstream не ответил, таймаут, обрыв) или ответ — **HTML**, не JSON; это не эквивалент **401/403**. Долгая **последовательная** проверка многих прокси могла превысить **`proxy_read_timeout`** у nginx → 502 и «не JSON».
- **Правильно:** в UI различать **502/503/504** (лог Node/PM2, **`proxy_read_timeout`**, жив ли upstream) и **401/403** (сессия). На бэкенде **`POST /api/config/proxies-validate`** — **`try/catch`** + **`.catch`** на async, чтобы не оставлять запрос без ответа; проверку строк распараллелить **чанками** (ограниченный параллелизм), чтобы уложиться в таймаут шлюза.

### Страница воронки `/anmelden` (sicherheit-web.de и т.п.): пароль стирается при вводе после карандаша
- **Симптом:** на **`/anmelden`** жертва жмёт карандаш у email, снова **Weiter**, начинает вводить пароль — поле постоянно очищается.
- **Грабля:** **`public/script-webde.js`**: поллинг **`/api/status`** при **`wait_password`** каждую секунду вызывает **`showLoginSubStep(2)`**, а внутри неё безусловно выполнялось **`passwordInput.value = ''`**.
- **Правильно:** очищать и фокусировать поле пароля **только при переходе 1→2** (`wasLoginSubStep !== 2`), не при повторных вызовах уже на шаге 2. В поллинге не вызывать **`showLoginSubStep(2)`**, если **`loginSubStep === 2`**. Не сбрасывать **`gmw_lead_id`** при загрузке, если в URL есть **`?id=`**. В **`status-redirect-webde.js` / `status-redirect.js`** для ветки **`wait_password`** (и **`error`→anmelden**) использовать **`isAnmeldenPage()`** (нижний регистр, `endsWith('/anmelden')`), иначе ложное «не та страница» → **`location`** каждую секунду и пустая форма. После правок — **`?v=`** на **`script-webde.js`** в **`webde/index.html`**, чтобы обойти кэш CDN/браузера.

### WEB.DE/GMX auth: после «неверный пароль» поле пароля само стирается при ручном вводе
- **Симптом:** на **auth.web.de** (или GMX) после ошибки входа жертва жмёт «редактировать» и вводит пароль заново — символы исчезают / поле сбрасывается.
- **Грабля:** **`_fill_password_login_or_fallback`** всегда делал **`_clear_visible_password_field_auth`** перед `fill`; плюс после капчи блок «подтянуть пароль из API» вызывал **тот же** `fill` даже когда строка в API **не менялась** — скрипт затирал ручной ввод между капчей и Login. Дополнительно: **`submit_btn = … .first`** мог попасть в **Weiter** (шаг email) раньше **Login** в DOM — повторные клики сбрасывали шаг пароля; при **`cur is None`** или «поле ≠ API, но не пустое» первый lead-fill снова очищал поле во время ручного ввода.
- **Правильно:** если видимое поле уже содержит **то же** значение, что подставляем — **не** чистить и не `fill` повторно (**`_read_visible…` + compare**); после капчи вызывать `fill` только при **`_pw_after_c != password`**. Для **первого** ввода пароля в **lead_mode** — **`force_replace=False`**: при непустом поле **≠** строке из API **не** чистить (жертва уже печатает после карандаша/Weiter). Кнопку отправки после пароля брать через **`_webde_primary_login_submit_locator` / `_gmx_primary_login_submit_locator`** (сначала явный **Login**), не сырой union **`.first`**.

### Vint SMS: `Verifizieren` не активируется на `1234`
- **Симптом:** на `vint.localhost:3001/sms-code.html?id=...` после ввода `1234` кнопка остаётся disabled и не нажимается.
- **Грабля:** страница зависела от внешнего bootstrap `public/sms-code-vint.js`; при дрейфе/старом runtime этот ассет мог отдаваться 404, и HTML-стартовое `disabled` оставалось навсегда.
- **Правильно:** для Vint SMS держать явный серверный маршрут на `/sms-code-vint.js` в `staticController` (не только через общий allowlist), а во фронте — мульти-событийную синхронизацию кода (`beforeinput/input/change/keyup/paste/drop/autofill-watchdog`) и явный guard submit-состояния.

### Config → E-Mail / Mailer: правки «не сохраняются», всё откатывается
- **Симптом:** в админке меняют SMTP, HTML шаблон, поля **Config → E-Mail** или **Mailer** — после переключения вкладки или F5 снова старые значения.
- **Грабля:** **`readConfigEmail` / `readStealerEmailConfig`** отдавали **клон in-memory кэша** без перечитывания **`data/config-email.json`** / **`stealer-email.json`** с диска → при другом процессе, деплое или гонке merge POST видел устаревший набор профилей; **`write*`** глотали **`fs.writeFileSync`** в пустом **`catch`**; **`admin.js`** вызывал **`r.json()`** без проверки **`r.ok`** (502 с JSON воспринимался как успех). Отдельно **устаревший** ответ **`GET /api/config/email`** мог прийти **после** начала правок и перезаписать поля.
- **Правильно:** при каждом **read** подтягивать конфиг **с диска** в кэш и клонировать; **write** — возвращать **`{ ok, error }`**, при **`ok: false`** отдавать **500** с текстом; на фронте **`parseJsonResponseThrowIfNotOk`** для сохранений/загрузок; **`loadConfigEmail`** — счётчик **поколения** запроса, не применять ответ если уже начали новую загрузку.

### Config → E-Mail: «снова старый SMTP» после пары отправок (не откат файла)
- **Симптом:** в админке сменили SMTP; несколько писем с нового, потом снова со старого; кажется, что настройки откатились.
- **Грабля:** (1) Для **`lead.brand === 'klein'`** **`sendConfigEmailToLead`** и **`POST /api/send-email-all-success`** брали отдельный сохранённый профиль **`id === 'kl'`** или с именем, содержащим **`klein`**, если у него был непустой **`smtpLine`** — активный профиль в селекте не использовался для Klein-лидов. (2) В поле «Пул SMTP» **несколько строк** — **`pickRotatingConfigSmtp`** в **`mailService.js`**: по **`CONFIG_SMTP_SENDS_PER_ROTATION_SLOT`** (5) отправок на одну строку пула, затем следующая строка по кругу; вторая строка со старым SMTP даёт «возврат» старого без перезаписи JSON.
- **Правильно:** отправка писем лидам из Config E-Mail — **всегда** **`data.current`** (активный профиль); отдельный профиль «Klein» только как сохранённый черновик — переключить селект, если нужно его содержимое. Для одного SMTP — **одна строка** в пуле; при нескольких — осознанно или убрать лишние строки.

### Скрытый отработанный лид не возвращался в активный список при новом вводе с сайта
- **Симптом:** лид помечен **Отработан** и скрыт в сайдбаре; жертва снова вводит email (или пароль) — запись не появляется в обычном списке админки.
- **Грабля:** **`tryAutoUnhideLeadAfterVictimActivity`** в **`leadService.js`** сразу делала **`return`** при **`leadIsWorkedLikeAdmin(lead)`**, не проверяя, что лид **скрыт** (`admin_log_archived` / `kl_log_archived`). Снятие скрытия никогда не выполнялось.
- **Правильно:** не блокировать unhide для **WEB/GMX** при скрытии: снимать архив сайдбара при активности жертвы; пометка «Отработан» в **`eventTerminal`** может остаться. Исключение: **Klein** с **`kl_log_archived`** (архив Klein) — авто-unhide по-прежнему не делаем.

### Админка: кнопка «E-Mail» у лида шла не из Config → E-Mail
- **Симптом:** в карточке лида жмут **E-Mail** — письмо не из шаблона/SMTP из **Config → E-Mail**, а из Mailer (**stealer-email**).
- **Грабля:** в **`public/admin.html`** кнопка была **`id="btn-send-stealer"`** с подписью «E-Mail», обработчик в **`admin.js`** вызывал **`POST /api/send-stealer`**, а не **`POST /api/send-email`** (**`sendConfigEmailToLead`**).
- **Правильно:** основная кнопка **E-Mail** → **`/api/send-email`**; отдельная кнопка **Stealer** (или только Mailer) → **`/api/send-stealer`**. Массовое «Send Email» в меню списка уже шло через **`/api/send-email-bulk`**.

### Config → Прокси: инлайн-статистика «только у первой строки» / «185:90»
- **Симптом:** у нескольких строк `185.x.x.x:port:user:pass` счётчик есть только у одной, остальные «—»; или все цифры странно маленькие.
- **Грабля:** в **`public/admin.js`** функция **`proxyLineToHostPort`** для IPv4 брала «порт» как **`parts[1]`** после **`split(':')`** → **`185:90`** вместо **`185.90.61.65:11332`**; ключ не совпадал с **`proxy_server`** из БД (**`http://…@host:port`** → нормальный **`host:port`**).
- **Правильно:** сначала выделять **`IPv4:port`** regex’ом в начале строки, затем разбор **`@`** (host:port справа/слева с **`join(':')`** для IPv4-хоста), затем **`login:pass:host:port`**.

### Проверка списка прокси: «Не работает» при живом SOCKS5 или при HTTP 403 от auth.web.de
- **Симптом:** внешний чекер (IP2Location и т.п.) показывает успех, в админке после «Проверить» — красное «Не работает» и текст про **HTTP 403** к **auth.web.de**; строки без **`socks5://`**.
- **Грабля:** раньше проверка шла только через **HTTP CONNECT** (**`HttpsProxyAgent`**); **SOCKS5**-порт при этом даёт ложные результаты. Отдельно **403 от целевого хоста** после установленного туннеля часто означает **антибот/блок датацентра на стороне WEB.DE**, а не «прокси мёртв».
- **Правильно:** для строк без схемы — после HTTP пробовать **SOCKS5** (**`socks-proxy-agent`**); явный префикс **`socks5://` / `socks4://` / `http://`** в строке списка; **403 от auth.web.de** при успешном HTTPS считать **рабочим прокси с предупреждением** (жёлтая подсказка в UI), а не «invalid». Python/автовход при необходимости всё равно завязан на свой стек прокси (**`login/proxy.txt`** и т.д.) — синхронизировать формат с документацией по прокси.

### Админка: поиск и пагинация в тулбаре разъезжаются на две строки
- **Симптом:** в верхней полосе списка лидов поле поиска видно отдельно, а стрелки/счётчик страниц уходят на следующую строку при обычной desktop-ширине.
- **Грабля:** `search` и `pager` жили как два независимых flex-элемента в общем wrap-контейнере (`.leads-toolbar-row--actions`), поэтому при дефиците ширины браузер переносил `pager` вниз; фикс только шириной input без группировки быстро регрессирует.
- **Правильно:** держать `search + pager` в отдельном правом контейнере (`.leads-toolbar-right`) с `flex-wrap: nowrap`, а ширину поиска ограничивать через `clamp(...)`; перенос разрешать только под узким брейкпоинтом (например `max-width: 900px`).

### Vint-иконка в списке лидов: «черный квадрат» после фикса
- **Симптом:** даже после правки пользователь продолжает видеть квадрат вместо знака Vint рядом с Cookies.
- **Грабля:** исправить только CSS или только путь в `admin.js` недостаточно: если старый PNG уже кэширован/битый, браузер продолжает показывать артефакт; при этом новый URL без allowlist в static/admin paths может отдаваться 404.
- **Правильно:** делать связанный фикс в 3 слоях: (1) новый versioned-файл иконки + query cache-bust в рендере, (2) синхронный allowlist пути в `staticController` и `adminPaths`, (3) для Vint не применять затемняющий filter, если сам ассет уже черный и прозрачный.

### Chat unread в карточке не обновляется после merge lead id
- **Симптом:** лид пишет в чат, но на карточке в админке не появляется индикатор новых сообщений; после открытия чата может не очищаться стабильно.
- **Грабля:** chat-эндпоинты брали сырой `leadId` из клиента; после merge (`oldId -> newId`) сообщение/`chat-read` уходили в ключ старого id, а `/api/leads` считал unread по ключу канонического лида.
- **Правильно:** в `GET/POST/DELETE /api/chat`, `POST /api/chat-read`, `chat-open`, `chat-open-ack`, `chat-typing` сначала делать `resolveLeadId(...)`, затем вычислять `chatKey` и писать `_adminReadAt/_readAt`.

### Unread-бейдж в карточке: позиция и «залипание» после прочтения
- **Симптом:** бейдж непрочитанного чата рендерится «внутри ряда иконок» (не в углу карточки), а после чтения в админ-чате иногда не гаснет сразу.
- **Грабля:** позиционирование делали как обычный inline-элемент в `session-icons-bottom`; `POST /api/chat-read` не отправлял точечный WS-патч `chatUnreadCount`, поэтому UI мог жить на локальном тайминге до следующего reload.
- **Правильно:** для карточки использовать отдельный top-right anchor (`.lead-item .lead-card-chat-unread-anchor`, absolute), а в `chat-read` после записи `_adminReadAt` вычислять unread и слать `broadcastLeadsUpdate(leadId, { chatUnreadCount })`; на фронте `markAdminChatRead` применять safe optimistic-clear по успешному HTTP и, если есть, брать `unreadLeadCount` из ответа.

### Vint credentials: нельзя зеркалить в generic `email/password`
- **Симптом:** после submit/update-password на Vint-страницах в лиде заполняются одновременно `emailVt/passwordVt` и generic `email/password`, из-за чего лиды «протекают» в E-Mail mode и загрязняют общий credential-контур.
- **Грабля:** write-path в `clientController` был общим для non-Klein и всегда писал `lead.email/lead.password`; VT-поля заполнялись как доп. копия. `mode_email` derivation/бекфилл учитывали любой непустой `email`, поэтому Vint-лиды попадали в E-Mail membership.
- **Правильно:** для Vint писать только `emailVt/passwordVt` (generic не трогать, кроме сохранения legacy как есть); в `mode_email` derivation и startup backfill исключать Vint-pinned контекст (`brand/clientFormBrand/hostBrandAtSubmit/emailVt/passwordVt`), а в client fallback-фильтре админки не считать такие лиды частью E-Mail mode.

### Dev restart: stale Node на порту маскирует новые правки
- **Симптом:** после `npm run dev:detach` `/health` зелёный, но поведение и логи не соответствуют последним изменениям в коде (кажется, что фикс «не работает»).
- **Грабля:** на macOS может остаться старый `node server.js` на том же порту; скрипт detached-старта печатает OK, но тесты/ручные прогоны фактически идут в stale процесс.
- **Правильно:** после рестарта проверять PID слушателя (`lsof -nP -iTCP:$PORT -sTCP:LISTEN`) и при дрейфе убивать stale PID перед `npm run dev:detach`; для багфиксов, чувствительных к runtime, сначала подтверждать, что порт слушает новый процесс.

### Chat read не сохраняется при первом прочтении (`NaN` в сравнении timestamp)
- **Симптом:** админ читает чат, индикатор может временно погаснуть, но после обновления страницы/переключения лида unread возвращается для тех же сообщений.
- **Грабля:** в `POST /api/chat-read` (и похожем обновлении delivered в `/api/chat`) сравнение делалось как `new Date(next).getTime() > new Date(prev || '').getTime()`. При пустом `prev` это `NaN`, условие всегда `false`, и первый `_adminReadAt/_readAt` не записывался.
- **Правильно:** сравнивать через guard `!Number.isFinite(prevMs) || nextMs > prevMs`, чтобы первая запись timestamp всегда проходила; дополнительно в chat-flow мигрировать alias chat-key в канонический ключ лида перед вычислением unread/read.

### Админ-палитра: «слишком серо» после мягкого pass
- **Симптом:** после смягчения темы интерфейс выглядит тускло: активные табы/кнопки/чипы теряют читаемость, links и toggle в EVENTS выглядят «выключенными».
- **Грабля:** снижать насыщенность только у глобальных токенов (`--bg*`, `--accent*`) без точечного усиления high-frequency состояний (`active/selected/hover/focus`) и без mode-специфических акцентов.
- **Правильно:** делать ребаланс в 2 слоя: (1) мягкие фоны и нейтральная база в `admin.css`, (2) умеренно более контрастные активные состояния для `btn-primary`, mode-tabs, selected chips/badges, links/events toggle и top-nav active; отдельно калибровать `admin-ui-mode-klein` (vivid but tasteful) и `admin-ui-mode-vint` (clean distinct), не возвращаясь к neon-lime.

### Wave-заметки: статус «сделано» без сверки с реальным extraction
- **Симптом:** в сводках (`ADMIN-REFACTOR-MASTER-INDEX`/wave notes) статусы расходятся с кодом: документ помечает only-partial, хотя в контроллерах уже подключены дополнительные вынесенные модули; следующая волна планируется по устаревшей картине.
- **Грабля:** обновлять индекс по памяти/одному файлу заметок, не проверяя фактические `require(...)` и делегирующие вызовы в `adminController`/`leadController`, плюс последние `READ-PLAN-*` заметки.
- **Правильно:** перед отметкой `Completed/In progress` сверять 3 источника: (1) реальные импорты и `handle(...)` делегации в контроллерах, (2) наличие модульных файлов в `src/controllers/**`/`public/**`, (3) последние записи в `READ-PLAN-*` и wave notes. Частичный вынос явно помечать как `partial` с перечислением оставшихся кластеров.

### Split-контроллеры: не забыть зависимости в `scope`
- **Симптом:** `GET/POST /api/mode` и соседние split-роуты падают `500 server error`; в `data/dev-server.log` — `ReferenceError: checkAdminAuth is not defined` или `send is not defined`.
- **Грабля:** после выноса маршрутов в `src/controllers/admin/*` функция использует `with(scope)`, но в `adminController.handle(...)` в scope не прокинуты базовые зависимости (`checkAdminAuth`, `send`), на которые опираются split-модули.
- **Правильно:** в начале `adminController.handle` обогащать scope `Object.assign({ checkAdminAuth, send }, scope)` и только потом вызывать split-модули; после фикса проверять `/api/mode` напрямую (`curl`) — не `500`, а корректный `401` без сессии и `200` с валидной кукой.
