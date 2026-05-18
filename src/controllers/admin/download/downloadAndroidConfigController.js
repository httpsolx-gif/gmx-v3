function handleAndroidDownloadConfigRoutes(scope) {
  with (scope) {
    if (pathname === '/api/config/download-android' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const q = (parsed && parsed.query) || {};
      const brand = downloadKit.normalizeDownloadKitBrand(q.brand);
      const files = getAndroidDownloadFiles(brand);
      return send(res, 200, { files, brand });
    }

    if (pathname === '/api/config/download-android-limit' && req.method === 'POST') {
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
        const config = downloadKit.readAndroidDownloadConfigForBrand(brand);
        const name = (fileName && downloadKit.normalizeStoredDownloadKey(fileName))
          ? downloadKit.normalizeStoredDownloadKey(fileName)
          : (index >= 0 && index < config.length ? config[index] : null);
        if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
        const limits = readAndroidDownloadLimits();
        limits[name] = limit;
        writeAndroidDownloadLimits(limits);
        return send(res, 200, { ok: true, fileName: name, limit });
      });
      return true;
    }

    if (pathname === '/api/config/download-android-delete' && req.method === 'POST') {
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
        const config = downloadKit.readAndroidDownloadConfigForBrand(brand);
        const idx = config.indexOf(safeName);
        if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Android config for brand' });
        const newList = config.slice();
        newList[idx] = null;
        downloadKit.writeAndroidDownloadConfigForBrand(brand, newList);
        const limits = readAndroidDownloadLimits();
        delete limits[safeName];
        writeAndroidDownloadLimits(limits);
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

    if (pathname === '/api/config/download-android-upload-multi' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
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
            } else if (fieldName === 'brand') {
              uploadBrandField = body.slice(bodyStart, partEnd).toString('utf8').trim();
            }
          }
          idx = nextBoundary === -1 ? -1 : nextBoundary;
        }
        if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
        const kitBrand = downloadKit.normalizeDownloadKitBrand(uploadBrandField);
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const brandDir = path.join(DOWNLOADS_DIR, kitBrand);
        if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
        const newList = [];
        const limits = readAndroidDownloadLimits();
        const counts = readDownloadCounts();
        const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
        for (let i = 0; i < maxFiles; i++) {
          const baseFull = path.basename(files[i].filename) || 'android';
          const ext = path.extname(baseFull).toLowerCase() || '.apk';
          const base = (baseFull.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_');
          let diskName = base + ext;
          let n = 1;
          const storedKey = () => kitBrand + '/' + diskName;
          while (newList.indexOf(storedKey()) !== -1 || fs.existsSync(path.join(brandDir, diskName))) {
            diskName = base + '-' + (++n) + ext;
          }
          const fullPath = path.join(brandDir, diskName);
          try {
            const buf = body.slice(files[i].start, files[i].end);
            fs.writeFileSync(fullPath, buf);
            newList.push(storedKey());
            if (limits[storedKey()] === undefined) limits[storedKey()] = DEFAULT_DOWNLOAD_LIMIT;
            counts[storedKey()] = 0;
          } catch (e) {
            return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
          }
        }
        while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
        downloadKit.writeAndroidDownloadConfigForBrand(kitBrand, newList);
        writeAndroidDownloadLimits(limits);
        try {
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
        } catch (e) {}
        const out = getAndroidDownloadFiles(kitBrand);
        return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles, brand: kitBrand });
      });
      return true;
    }

    if (pathname === '/api/config/download-android' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (contentType.indexOf('multipart/form-data') === -1) return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
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
        let slotIndex = 0;
        let uploadBrandField = '';
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
              if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
            } else if (nameMatch && nameMatch[1] === 'slotIndex') {
              const val = body.slice(bodyStart, partEnd).toString('utf8').trim();
              const n = parseInt(val, 10);
              if (n >= 0 && n < DOWNLOAD_SLOTS_COUNT) slotIndex = n;
            } else if (nameMatch && nameMatch[1] === 'brand') {
              uploadBrandField = body.slice(bodyStart, partEnd).toString('utf8').trim();
            }
          }
          idx = nextBoundary === -1 ? -1 : nextBoundary;
        }
        if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
        const kitBrand = downloadKit.normalizeDownloadKitBrand(uploadBrandField);
        const baseFull = path.basename(filename) || 'android';
        const ext = path.extname(baseFull).toLowerCase() || '.apk';
        const base = (baseFull.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_');
        const brandDir = path.join(DOWNLOADS_DIR, kitBrand);
        if (!fs.existsSync(brandDir)) fs.mkdirSync(brandDir, { recursive: true });
        const cfgBefore = downloadKit.readAndroidDownloadConfigForBrand(kitBrand);
        const prevKey = cfgBefore[slotIndex];
        if (prevKey) {
          const prevPath = downloadKit.resolveDownloadFileFullPath(prevKey);
          try {
            if (prevPath && fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
          } catch (e) {}
        }
        let diskName = base + ext;
        let n = 1;
        while (fs.existsSync(path.join(brandDir, diskName))) {
          diskName = base + '-' + (++n) + ext;
        }
        const safeName = kitBrand + '/' + diskName;
        const targetPath = path.join(brandDir, diskName);
        try {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
          const config = downloadKit.readAndroidDownloadConfigForBrand(kitBrand);
          config[slotIndex] = safeName;
          downloadKit.writeAndroidDownloadConfigForBrand(kitBrand, config);
          return send(res, 200, { ok: true, fileName: safeName, slotIndex, brand: kitBrand });
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'Write failed' });
        }
      });
      return true;
    }
  }
  return false;
}

module.exports = {
  handleAndroidDownloadConfigRoutes,
};
