module.exports = {
  apps: [
    {
      name: 'gmx-v3',
      script: 'server.js',
      cwd: '/var/www/gmx-v3',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '15s',
      max_restarts: 1000,
      restart_delay: 3000,
      kill_timeout: 15000,
      max_memory_restart: '4096M',
      env: {
        NODE_ENV: 'production',
        PORT: '3010',
        GMW_SQLITE_SYNCHRONOUS: 'full'
      }
    }
  ]
};
