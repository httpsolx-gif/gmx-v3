'use strict';

/**
 * PM2/лог-ротация/закрытый пайп: запись в stdout/stderr может дать EPIPE → без обработчика
 * Node эмитит «error» на потоке и процесс падает (PM2 перезапуск, обрыв автовхода).
 */
function swallowBrokenPipeOnStream(stream, label) {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('error', function (err) {
    const code = err && err.code;
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') return;
    try {
      console.error('[stdio ' + label + ']', err && err.message ? err.message : err);
    } catch (_) {}
  });
}

swallowBrokenPipeOnStream(process.stdout, 'stdout');
swallowBrokenPipeOnStream(process.stderr, 'stderr');
