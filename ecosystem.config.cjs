module.exports = {
  apps: [
    {
      name: 'gmx-net',
      script: 'server.js',
      cwd: '/var/www/gmx-net.help-v2',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 1000,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      /** PM2 при max_memory_restart шлёт SIGINT; при тяжёлом Node/Chromium иногда несколько попыток kill. */
      kill_timeout: 15000,
      /**
       * Параллельный автовход + админка + рассылка дают пики RSS у одного процесса Node (см. лог PM2: current_memory vs max_memory_limit).
       * Если в логе лимит ~734003200 (700MiB), а в файле больше — процесс поднят со старым дампом: деплой через `pm2 reload ecosystem.config.cjs --only gmx-net`, не `pm2 restart gmx-net`.
       */
      max_memory_restart: '4096M',
      env: {
        /** Меньше риска потери последнего коммита в SQLite при SIGKILL; чуть больше I/O. */
        GMW_SQLITE_SYNCHRONOUS: 'full',
        NODE_ENV: 'production',
        PORT: '3001',
        /** Обязателен для выпуска отдельного Let's Encrypt на каждый новый домен (nginx). Только HTTP: ALLOW_HTTP_ONLY_NGINX=1 */
        CERTBOT_EMAIL: 'https.olx@gmail.com',
        SHORT_DOMAIN_STOP_APACHE: '1',
        SHORT_SERVER_IP: '45.249.90.215',
        /** ADMIN_USERNAME, ADMIN_PASSWORD, WORKER_SECRET — только в .env (не дублировать сюда). */
        BACKUP_KEEP_COUNT: '1',
        GMW_MAX_POST_BODY_MB: '200',
        /** Основной домен GMX; при наличии data/brand-domains.json поля там имеют приоритет — держите в sync с админкой. */
        GMX_DOMAIN: 'gmx-net.club',
        /** Только старые хосты (без www), не дублировать основной домен — редирект на GMX_DOMAIN. */
        GMX_DOMAINS:
          'gmxde.cfd\ngmx-net.click\ngmx-net.cv\ngmx-net.one\ngmx-net.info\ngmx-de.info\ngmx-net.help\ngmx-de.help',
        WEBDE_DOMAIN: 'web-de.click',
        WEBDE_DOMAINS: 'web-de.one\nweb-de.biz',
        KLEIN_DOMAIN: '847932.de',
        KLEIN_DOMAINS: 'choigamevi.com\nkleinanzeigen-de.sbs\nkleinanzeigen-anmelden.de'
      }
    }
  ]
};
