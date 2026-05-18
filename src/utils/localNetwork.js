'use strict';

/** Loopback и частные сети (RFC1918) — локальная отладка по IP. */
function isLocalHost(host) {
  if (!host) return false;
  const raw = String(host).trim().toLowerCase();
  if (!raw) return false;
  const noPort = raw.split(':')[0];
  if (noPort === 'localhost' || noPort.endsWith('.localhost')) return true;
  if (noPort === '127.0.0.1' || noPort === '0.0.0.0' || noPort === '::1') return true;
  if (noPort.startsWith('192.168.') || noPort.startsWith('10.')) return true;
  if (noPort.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(noPort)) return true;
  return false;
}

module.exports = { isLocalHost };
