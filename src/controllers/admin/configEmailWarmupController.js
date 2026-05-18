function handleConfigEmailWarmupRoutes(scope) {
  with (scope) {
    if (pathname === '/api/config/email' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const data = readConfigEmail();
      const cur = data.current;
      const hasImg = !!(cur && cur.image1Base64);
      const out = {
        list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
        currentId: data.currentId || null,
        smtpLine: (cur && cur.smtpLine) || '',
        senderName: (cur && cur.senderName) || '',
        title: (cur && cur.title) || '',
        html: (cur && cur.html) || '',
        image1Present: hasImg,
        image1DataUrl: hasImg ? ('data:image/png;base64,' + String(cur.image1Base64)) : ''
      };
      return send(res, 200, out);
    }

    if (pathname === '/api/config/email' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const data = readConfigEmail();
        const configs = data.configs || [];
        let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
        let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
        if (!cfg) {
          configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
          cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', senderName: '', title: '', html: '' };
          configs.push(cfg);
        }
        if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
        if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
        if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
        if (json.title != null) cfg.title = String(json.title).trim();
        if (json.html != null) cfg.html = String(json.html);
        if (json.templateBase64 != null) {
          try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
        }
        if (json.image1Base64 != null) {
          const b64 = String(json.image1Base64).trim();
          if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
        }
        if (json.setCurrent === true) data.currentId = cfg.id;
        data.configs = configs;
        data.current = cfg;
        const wrCfg = writeConfigEmail(data);
        if (!wrCfg || wrCfg.ok === false) {
          return send(res, 500, { ok: false, error: (wrCfg && wrCfg.error) || 'Не удалось записать config-email.json' });
        }
        const hasImg = !!(cfg && cfg.image1Base64);
        const imageTouched = Object.prototype.hasOwnProperty.call(json, 'image1Base64');
        const out = { ok: true, id: configId };
        if (imageTouched) {
          out.image1Present = hasImg;
          out.image1DataUrl = hasImg ? ('data:image/png;base64,' + String(cfg.image1Base64)) : '';
        }
        return send(res, 200, out);
      });
      return true;
    }

    if (pathname === '/api/config/email' && req.method === 'DELETE') {
      if (!checkAdminAuth(req, res)) return true;
      const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const data = readConfigEmail();
      const configs = (data.configs || []).filter(function (c) { return c.id != id; });
      if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
      const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
      data.configs = configs;
      data.currentId = newCurrent;
      data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
      const wrDelCfg = writeConfigEmail(data);
      if (!wrDelCfg || wrDelCfg.ok === false) {
        return send(res, 500, { ok: false, error: (wrDelCfg && wrDelCfg.error) || 'Не удалось записать config-email.json' });
      }
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/config/email/select' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const id = (json.id != null) ? String(json.id).trim() : '';
        const data = readConfigEmail();
        const cfg = (data.configs || []).find(function (c) { return c.id == id; });
        if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
        data.currentId = cfg.id;
        data.current = cfg;
        const wrSelCfg = writeConfigEmail(data);
        if (!wrSelCfg || wrSelCfg.ok === false) {
          return send(res, 500, { ok: false, error: (wrSelCfg && wrSelCfg.error) || 'Не удалось записать config-email.json' });
        }
        return send(res, 200, { ok: true });
      });
      return true;
    }

    if (pathname === '/api/config/email/send-test' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let json = {};
        try {
          json = JSON.parse(body || '{}');
        } catch (e) {
          return send(res, 400, { ok: false, error: 'invalid json' });
        }
        const toRaw = json.to != null ? String(json.to).trim() : (json.toEmail != null ? String(json.toEmail).trim() : '');
        if (!toRaw) return send(res, 400, { ok: false, error: 'Укажите получателя (to)' });
        const configId = json.id != null && String(json.id).trim() !== '' ? String(json.id).trim() : null;
        const password = json.password != null ? String(json.password) : '';
        const result = await sendConfigEmailToAddress(toRaw, password, configId);
        if (result.ok) {
          console.log('[send-config-email-test] ' + result.fromEmail + ' → ' + result.toEmail);
          return send(res, 200, { ok: true, fromEmail: result.fromEmail, toEmail: result.toEmail });
        }
        const code = result.statusCode || 500;
        return send(res, code, { ok: false, error: result.error || 'Ошибка отправки' });
      });
      return true;
    }

    if (pathname === '/api/config/warmup-email' && req.method === 'GET') {
      if (!checkAdminAuth(req, res)) return true;
      const data = readWarmupEmailConfig();
      const cur = data.current;
      const out = {
        list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
        currentId: data.currentId || null,
        smtpLine: (cur && cur.smtpLine) || '',
        recipientsList: (cur && cur.recipientsList) || '',
        html: (cur && cur.html) || '',
        image1Present: !!(cur && cur.image1Base64),
        senderName: (cur && cur.senderName) || '',
        title: (cur && cur.title) || ''
      };
      return send(res, 200, out);
    }

    if (pathname === '/api/config/warmup-email' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const data = readWarmupEmailConfig();
        const configs = data.configs || [];
        let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
        let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
        if (!cfg) {
          configId = 'wcfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
          cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' };
          configs.push(cfg);
        }
        if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
        if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
        if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
        if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
        if (json.title != null) cfg.title = String(json.title).trim();
        if (json.html != null) cfg.html = String(json.html);
        if (json.templateBase64 != null) {
          try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
        }
        if (json.image1Base64 != null) {
          const b64 = String(json.image1Base64).trim();
          if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
        }
        if (json.setCurrent === true) data.currentId = cfg.id;
        data.configs = configs;
        data.current = cfg;
        writeWarmupEmailConfig(data);
        return send(res, 200, { ok: true, id: configId });
      });
      return true;
    }

    if (pathname === '/api/config/warmup-email' && req.method === 'DELETE') {
      if (!checkAdminAuth(req, res)) return true;
      const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const data = readWarmupEmailConfig();
      const configs = (data.configs || []).filter(function (c) { return c.id != id; });
      if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
      const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
      data.configs = configs;
      data.currentId = newCurrent;
      data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/config/warmup-email/select' && req.method === 'POST') {
      if (!checkAdminAuth(req, res)) return true;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch {}
        const id = (json.id != null) ? String(json.id).trim() : '';
        const data = readWarmupEmailConfig();
        const cfg = (data.configs || []).find(function (c) { return c.id == id; });
        if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
        data.currentId = cfg.id;
        data.current = cfg;
        writeWarmupEmailConfig(data);
        return send(res, 200, { ok: true });
      });
      return true;
    }
  }
  return false;
}

module.exports = {
  handleConfigEmailWarmupRoutes,
};
