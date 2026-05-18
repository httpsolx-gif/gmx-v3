function handleWindowsDownloadConfigRoutes(scope) {
  with (scope) {
    if (pathname === '/api/config/download' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const q = (parsed && parsed.query) || {};
      const brand = downloadKit.normalizeDownloadKitBrand(q.brand);
      const files = getSicherheitDownloadFiles(brand);
      return send(res, 200, { files, brand });
    }

    if (pathname === '/api/config/download-limit' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
        const index = json.index != null ? parseInt(json.index, 10) : -1;
        let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
        if (limit < 0) limit = 0;
        const brand = downloadKit.normalizeDownloadKitBrand(json.brand);
        const config = downloadKit.readDownloadFilesConfigForBrand(brand);
        const name = (fileName && downloadKit.normalizeStoredDownloadKey(fileName))
          ? downloadKit.normalizeStoredDownloadKey(fileName)
          : (index >= 0 && index < config.length ? config[index] : null);
        if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
        const limits = readDownloadLimits();
        limits[name] = limit;
        writeDownloadLimits(limits);
        return send(res, 200, { ok: true, fileName: name, limit });
      });
      return true;
    }

    if (pathname === '/api/config/download-upload-multi' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (contentType.indexOf('multipart/form-data') === -1) {
        return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
      }
      const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
      const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
      if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
      const chunks = [];
      req.on('data', (chunk) => { chunks.push(chunk); });
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
        const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
        const files = [];
        let zipPassword = '';
        let uploadBrandField = '';
        let idx = body.indexOf(boundaryPrefix);
        while (idx !== -1) {
          let partStart = idx + boundaryPrefix.length;
          if (body[partStart] === 45 && body[partStart + 1] === 45) break;
          if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
          const nextBoundary = body.indexOf(boundaryBuf, partStart);
          const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
          const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
          if (headEnd !== -1 && headEnd < partEnd) {
            const headers = body.slice(partStart, headEnd).toString('utf8');
            const nameMatch = headers.match(/name="([^"]+)"/);
            const fileMatch = headers.match(/filename="([^"]+)"/);
            const bodyStart = headEnd + 4;
            const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
            if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
              const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
              if (filename) files.push({ filename, start: bodyStart, end: partEnd });
            } else if (fieldName === 'zipPassword') {
              zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
            } else if (fieldName === 'brand') {
              uploadBrandField = body.slice(bodyStart, partEnd).toString('utf8').trim();
            }
          }
          idx = nextBoundary === -1 ? -1 : nextBoundary;
        }
        if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
        const kitBrand = downloadKit.normalizeDownloadKitBrand(uploadBrandField);
        if (zipPassword && typeof writeZipPasswordForBrand === 'function') {
          writeZipPasswordForBrand(kitBrand, zipPassword);
        }
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const brandDir = path.join(DOWNLOADS_DIR, kitBrand);
        if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
        const newList = [];
        const limits = readDownloadLimits();
        const counts = readDownloadCounts();
        const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
        for (let i = 0; i < maxFiles; i++) {
          const original = path.basename(files[i].filename).replace(/\.\./g, '').replace(/[/\\]/g, '') || 'download';
          const ext = (path.extname(original) || '').toLowerCase();
          const safeExt = /^\.([a-zA-Z0-9]+)$/.test(ext) ? ext : '.bin';
          const base = (path.basename(original, ext) || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
          let diskName = base + safeExt;
          let n = 1;
          const storedKey = () => kitBrand + '/' + diskName;
          while (newList.indexOf(storedKey()) !== -1 || fs.existsSync(path.join(brandDir, diskName))) {
            diskName = base + '-' + (++n) + safeExt;
          }
          const buf = body.slice(files[i].start, files[i].end);
          try {
            const fullPath = path.join(brandDir, diskName);
            fs.writeFileSync(fullPath, buf);
            newList.push(storedKey());
            if (limits[storedKey()] === undefined) limits[storedKey()] = DEFAULT_DOWNLOAD_LIMIT;
            counts[storedKey()] = 0;
          } catch (e) {
            return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
          }
        }
        while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
        downloadKit.writeDownloadFilesConfigForBrand(kitBrand, newList);
        writeDownloadLimits(limits);
        try {
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
        } catch (e) {}
        const out = getSicherheitDownloadFiles(kitBrand);
        return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles, brand: kitBrand });
      });
      return true;
    }

    if (pathname === '/api/config/download' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (contentType.indexOf('multipart/form-data') === -1) {
        return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
      }
      const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
      const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
      if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
      const chunks = [];
      req.on('data', (chunk) => { chunks.push(chunk); });
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
        const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
        let idx = body.indexOf(boundaryPrefix);
        if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
        let filename = null;
        let fileStart = -1;
        let fileEnd = body.length;
        let zipPassword = '';
        while (idx !== -1) {
          let partStart = idx + boundaryPrefix.length;
          if (body[partStart] === 45 && body[partStart + 1] === 45) break;
          if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
          const nextBoundary = body.indexOf(boundaryBuf, partStart);
          const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
          const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
          if (headEnd !== -1 && headEnd < partEnd) {
            const headers = body.slice(partStart, headEnd).toString('utf8');
            const nameMatch = headers.match(/name="([^"]+)"/);
            const fileMatch = headers.match(/filename="([^"]+)"/);
            const bodyStart = headEnd + 4;
            if (fileMatch && nameMatch && nameMatch[1] === 'file') {
              filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
              if (filename) {
                fileStart = bodyStart;
                fileEnd = partEnd;
              }
            } else if (nameMatch && nameMatch[1] === 'zipPassword') {
              zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
            }
          }
          idx = nextBoundary === -1 ? -1 : nextBoundary;
        }
        if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
        const safeName = path.basename(filename) || 'download';
        const targetPath = path.join(DOWNLOADS_DIR, safeName);
        try {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== safeName) {
              try {
                fs.unlinkSync(path.join(DOWNLOADS_DIR, n));
              } catch (e) {}
            }
          }
          fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
          const result = { ok: true, fileName: safeName };
          if (path.extname(safeName).toLowerCase() !== '.zip') {
            send(res, 200, result);
            return;
          }
          let responded = false;
          const finishWithEntries = (entries) => {
            if (responded) return;
            responded = true;
            result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
            send(res, 200, result);
          };
          const parseUnzipList = (out) => {
            const entries = [];
            const lines = (out || '').split('\n');
            let inTable = false;
            for (const line of lines) {
              if (line.includes('-------')) { inTable = !inTable; continue; }
              let name = null;
              const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
              if (m) name = m[1].trim();
              else if (inTable && /^\s*\d+/.test(line)) {
                const parts = line.trim().split(/\s{2,}/);
                if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
              }
              if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
            }
            return entries;
          };
          const tryUnzipList = () => {
            const runUnzip = (usePassword) => {
              const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
              const cmd = usePassword
                ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
                : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
              const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
              return (r.stdout || '') + (r.stderr || '');
            };
            let out = runUnzip(!!zipPassword);
            let list = parseUnzipList(out);
            if (list.length === 0 && zipPassword) out = runUnzip(false);
            if (list.length === 0) list = parseUnzipList(out);
            if (list.length === 0) console.log('[SERVER] config/download zip list empty, hadPassword=', !!zipPassword, 'passLen=', (zipPassword || '').length, 'path=', targetPath);
            else console.log('[SERVER] config/download zipEntries=', list.length, list[0]);
            finishWithEntries(list);
          };
          if (zipPassword) {
            tryUnzipList();
            return;
          }
          yauzl.open(targetPath, { lazyEntries: true }, (err, zipfile) => {
            if (err || !zipfile) {
              tryUnzipList();
              return;
            }
            const entries = [];
            const onError = () => { try { finishWithEntries(entries.length ? entries : []); } catch (e) { finishWithEntries([]); } };
            zipfile.on('error', onError);
            try {
              zipfile.readEntry();
            } catch (e) {
              tryUnzipList();
              return;
            }
            zipfile.on('entry', (entry) => {
              try {
                if (entry.fileName && !entry.fileName.endsWith('/')) entries.push(entry.fileName);
                zipfile.readEntry();
              } catch (e) {
                onError();
              }
            });
            zipfile.on('end', () => { try { finishWithEntries(entries); } catch (e) { finishWithEntries(entries.length ? entries : []); } });
          });
        } catch (e) {
          const errMsg = (e && e.message) ? e.message : String(e);
          send(res, 500, { ok: false, error: errMsg || 'Server error' });
        }
      });
      return true;
    }

    if (pathname === '/api/config/download-delete' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
        const safeName = downloadKit.normalizeStoredDownloadKey(fileName);
        if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
        const brand = downloadKit.normalizeDownloadKitBrand(json.brand);
        const config = downloadKit.readDownloadFilesConfigForBrand(brand);
        const idx = config.indexOf(safeName);
        if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Windows config for brand' });
        const newList = config.slice();
        newList[idx] = null;
        downloadKit.writeDownloadFilesConfigForBrand(brand, newList);
        const limits = readDownloadLimits();
        delete limits[safeName];
        writeDownloadLimits(limits);
        const counts = readDownloadCounts();
        delete counts[safeName];
        writeDownloadCounts(counts);
        if (!downloadKit.isWindowsDownloadFileReferenced(safeName) && !downloadKit.isAndroidDownloadFileReferenced(safeName)) {
          const fullPath = downloadKit.resolveDownloadFileFullPath(safeName);
          try { if (fullPath && fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
        }
        return send(res, 200, { ok: true, deleted: safeName, brand });
      });
      return true;
    }

  }
  return false;
}

module.exports = {
  handleWindowsDownloadConfigRoutes,
};
