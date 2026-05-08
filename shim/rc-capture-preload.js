// rc-capture-preload.js — capture HTTP traffic out of CC's bundle.
//
// Constraints we hit empirically:
//   - Loaded via Bun's Inspector Runtime.evaluate, which runs in an ESM-only
//     context where `require` is undefined.
//   - We can't `import()` dynamically from this snippet either (sync IIFE).
//   - But globalThis.fetch, globalThis.process, globalThis.Buffer all exist,
//     and process.binding('http_parser') is accessible if we needed it.
//
// Strategy: don't write files from in-process. Emit one line per event on
// stderr prefixed with `[vk-cap-data] ` followed by JSON. The host
// (bin/vk-rc-capture) splits stderr and routes those lines into the
// capture file. Avoids fs/require entirely.

(() => {
  const stderr = (msg) => { try { process.stderr.write(msg + '\n'); } catch {} };
  const mark = (msg) => stderr(`[vk-cap] ${msg}`);

  if (globalThis.__VAKKA_RC_CAPTURE_INSTALLED) { mark('already installed; skipping'); return; }
  globalThis.__VAKKA_RC_CAPTURE_INSTALLED = true;
  mark('install begin');

  let seq = 0;
  const log = (obj) => {
    try { stderr('[vk-cap-data] ' + JSON.stringify({ ts: Date.now(), pid: process.pid, ...obj })); }
    catch (e) { stderr('[vk-cap-data-err] ' + (e && e.message)); }
  };

  const truncate = (s, n) => {
    if (typeof s !== 'string') return s;
    return s.length > n ? s.slice(0, n) + `…[+${s.length - n}b]` : s;
  };

  const headersToObj = (h) => {
    const out = {};
    try {
      if (h && typeof h === 'object' && !Array.isArray(h) && !(h instanceof Headers)) {
        for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
        return out;
      }
      const it = (h instanceof Headers) ? h : new Headers(h || {});
      for (const [k, v] of it.entries()) out[k] = v;
    } catch {}
    return out;
  };

  // --- patch globalThis.fetch ---
  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = async function vakkaFetch(input, init) {
      const id = ++seq;
      const url = typeof input === 'string' ? input : (input && (input.url || input.toString && input.toString())) || '';
      const reqMethod = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      const reqHeaders = headersToObj((init && init.headers) || (input && typeof input === 'object' && input.headers) || {});
      let reqBody;
      try {
        const b = init && init.body;
        if (typeof b === 'string') reqBody = truncate(b, 16384);
        else if (b && b.byteLength !== undefined) reqBody = `<bytes:${b.byteLength}>`;
        else if (b) reqBody = `<${b.constructor && b.constructor.name || typeof b}>`;
      } catch {}
      log({ id, transport: 'fetch', event: 'req', url, method: reqMethod, headers: reqHeaders, body: reqBody });
      let res;
      try { res = await origFetch.call(this, input, init); }
      catch (e) { log({ id, transport: 'fetch', event: 'err', url, msg: String(e && e.message || e) }); throw e; }
      const resHeaders = headersToObj(res.headers);
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (ct.includes('text/event-stream') && res.body && typeof res.body.tee === 'function') {
        log({ id, transport: 'fetch', event: 'sse.open', url, status: res.status, headers: resHeaders });
        const [a, b] = res.body.tee();
        (async () => {
          const reader = b.getReader();
          const dec = new TextDecoder();
          let buf = '', frameSeq = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let idx;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                frameSeq++;
                log({ id, transport: 'fetch', event: 'sse.frame', seq: frameSeq, frame: truncate(frame, 32768) });
              }
            }
            log({ id, transport: 'fetch', event: 'sse.close', frames: frameSeq });
          } catch (e) { log({ id, transport: 'fetch', event: 'sse.err', msg: String(e && e.message || e) }); }
        })();
        return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      let resBody;
      try { resBody = truncate(await res.clone().text(), 32768); }
      catch (e) { resBody = `<unreadable:${String(e && e.message || e)}>`; }
      log({ id, transport: 'fetch', event: 'res', url, status: res.status, headers: resHeaders, body: resBody });
      return res;
    };
    mark('fetch wrapped');
    // Also overwrite Bun.fetch if it's a distinct reference — some bundled
    // adapters capture Bun.fetch directly.
    try {
      if (globalThis.Bun && typeof globalThis.Bun.fetch === 'function') {
        const sameRef = globalThis.Bun.fetch === origFetch;
        const desc = Object.getOwnPropertyDescriptor(globalThis.Bun, 'fetch');
        const wantedRef = globalThis.fetch;
        let took = 'none';
        // 1. assign
        try { globalThis.Bun.fetch = wantedRef; if (globalThis.Bun.fetch === wantedRef) took = 'assign'; } catch {}
        // 2. defineProperty
        if (took === 'none') {
          try {
            Object.defineProperty(globalThis.Bun, 'fetch', { value: wantedRef, writable: true, configurable: true });
            if (globalThis.Bun.fetch === wantedRef) took = 'defineProperty';
          } catch (e) { log({ event: 'diag.bunfetch.dp.err', msg: String(e && e.message) }); }
        }
        log({ event: 'diag.bunfetch', sameRef, hasBunFetch: true, descriptor: desc ? { writable: desc.writable, configurable: desc.configurable, hasGetter: typeof desc.get === 'function' } : null, installed: took, verifySame: globalThis.Bun.fetch === wantedRef });
      } else {
        log({ event: 'diag.bunfetch', hasBunFetch: false });
      }
    } catch (e) { log({ event: 'diag.bunfetch.err', msg: String(e && e.message || e) }); }
  } else {
    mark('globalThis.fetch is not a function — skipping fetch patch');
  }

  // --- patch node:http and node:https via dynamic import (async, fire-and-forget) ---
  const patchHttpModule = (mod, schemeDefault) => {
    if (!mod || mod.__vakka_patched) return;
    const origRequest = mod.request;
    if (typeof origRequest !== 'function') { mark(`${schemeDefault} no .request`); return; }
    // Diagnose the property descriptor — Bun standalone may freeze these.
    try {
      const d = Object.getOwnPropertyDescriptor(mod, 'request');
      log({ event: 'diag.httpdesc', scheme: schemeDefault, descriptor: d ? { writable: d.writable, configurable: d.configurable, hasGetter: typeof d.get === 'function', hasSetter: typeof d.set === 'function' } : null });
    } catch {}
    mod.__vakka_patched = true;
    const wrapped = function vakkaHttpRequest(...args) {
      const id = ++seq;
      let opts = {};
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        try {
          const u = args[0] instanceof URL ? args[0] : new URL(args[0]);
          opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET' };
        } catch {}
        if (typeof args[1] === 'object' && args[1] !== null) Object.assign(opts, args[1]);
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        opts = args[0];
      }
      const protocol = opts.protocol || `${schemeDefault}:`;
      const url = `${protocol}//${opts.hostname || opts.host || 'unknown'}${opts.port ? ':' + opts.port : ''}${opts.path || '/'}`;
      const method = (opts.method || 'GET').toUpperCase();
      const reqHeaders = headersToObj(opts.headers || {});
      log({ id, transport: 'http', event: 'req', url, method, headers: reqHeaders });

      const req = origRequest.apply(this, args);
      const reqBodyChunks = [];
      let bodyBytes = 0;
      const origWrite = req.write.bind(req);
      const origEnd = req.end.bind(req);
      req.write = function (chunk, ...rest) {
        try {
          if (chunk) {
            const buf = (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) ? chunk : (typeof Buffer !== 'undefined' ? Buffer.from(chunk) : null);
            if (buf) { bodyBytes += buf.length; if (reqBodyChunks.length < 32 && bodyBytes < 65536) reqBodyChunks.push(buf); }
          }
        } catch {}
        return origWrite(chunk, ...rest);
      };
      req.end = function (chunk, ...rest) {
        try {
          if (chunk) {
            const buf = (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) ? chunk : (typeof Buffer !== 'undefined' ? Buffer.from(chunk) : null);
            if (buf) { bodyBytes += buf.length; if (reqBodyChunks.length < 32 && bodyBytes < 65536) reqBodyChunks.push(buf); }
          }
        } catch {}
        try {
          const body = (typeof Buffer !== 'undefined') ? Buffer.concat(reqBodyChunks).toString('utf8') : '';
          if (body) log({ id, transport: 'http', event: 'reqbody', url, body: truncate(body, 32768), bytes: bodyBytes });
        } catch {}
        return origEnd(chunk, ...rest);
      };

      req.on('response', (res) => {
        const resHeaders = {};
        try { for (const [k, v] of Object.entries(res.headers || {})) resHeaders[k] = String(v); } catch {}
        const ct = String(res.headers && res.headers['content-type'] || '');
        if (ct.includes('text/event-stream')) {
          log({ id, transport: 'http', event: 'sse.open', url, status: res.statusCode, headers: resHeaders });
          let buf = '', frameSeq = 0;
          const dec = new TextDecoder();
          res.on('data', (chunk) => {
            try {
              buf += dec.decode(chunk, { stream: true });
              let idx;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                frameSeq++;
                log({ id, transport: 'http', event: 'sse.frame', seq: frameSeq, frame: truncate(frame, 32768) });
              }
            } catch {}
          });
          res.on('end', () => log({ id, transport: 'http', event: 'sse.close', frames: frameSeq }));
          return;
        }
        const chunks = [];
        let resBytes = 0;
        res.on('data', (c) => {
          try {
            const b = (typeof Buffer !== 'undefined' && Buffer.isBuffer(c)) ? c : (typeof Buffer !== 'undefined' ? Buffer.from(c) : null);
            if (b) { resBytes += b.length; if (chunks.length < 64 && resBytes < 131072) chunks.push(b); }
          } catch {}
        });
        res.on('end', () => {
          let body;
          try { body = truncate((typeof Buffer !== 'undefined') ? Buffer.concat(chunks).toString('utf8') : '', 32768); }
          catch (e) { body = `<unreadable:${e && e.message}>`; }
          log({ id, transport: 'http', event: 'res', url, status: res.statusCode, headers: resHeaders, body, bytes: resBytes });
        });
      });
      req.on('error', (e) => log({ id, transport: 'http', event: 'err', url, msg: String(e && e.message || e) }));
      return req;
    };
    // Module namespace binding is read-only in Bun standalone — patching
    // mod.request silently fails. Patch the prototype instead.
    const CR = mod.ClientRequest;
    if (CR && CR.prototype) {
      const proto = CR.prototype;
      const origWrite = proto.write;
      const origEnd = proto.end;
      const _vakkaInit = function (req) {
        if (req.__vakka_inited) return;
        req.__vakka_inited = true;
        const id = ++seq;
        req.__vakka_id = id;
        req.__vakka_chunks = [];
        req.__vakka_bytes = 0;
        // Best-effort URL reconstruction from outgoing message state.
        let url = '?';
        try {
          const host = (req.getHeader && req.getHeader('host')) || req.host || req._host || 'unknown';
          const path = req.path || '/';
          url = `${schemeDefault}://${host}${path}`;
        } catch {}
        req.__vakka_url = url;
        let headers = {};
        try {
          if (typeof req.getHeaders === 'function') headers = headersToObj(req.getHeaders());
          else if (req._headers) headers = headersToObj(req._headers);
        } catch {}
        log({ id, transport: 'http-proto', event: 'req', url, method: req.method, headers });
        req.on('response', (res) => {
          const resHeaders = {};
          try { for (const [k, v] of Object.entries(res.headers || {})) resHeaders[k] = String(v); } catch {}
          const ct = String(res.headers && res.headers['content-type'] || '');
          if (ct.includes('text/event-stream')) {
            log({ id, transport: 'http-proto', event: 'sse.open', url, status: res.statusCode, headers: resHeaders });
            let buf = '', frameSeq = 0;
            const dec = new TextDecoder();
            res.on('data', (chunk) => {
              try {
                buf += dec.decode(chunk, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                  const frame = buf.slice(0, idx); buf = buf.slice(idx + 2); frameSeq++;
                  log({ id, transport: 'http-proto', event: 'sse.frame', seq: frameSeq, frame: truncate(frame, 32768) });
                }
              } catch {}
            });
            res.on('end', () => log({ id, transport: 'http-proto', event: 'sse.close', frames: frameSeq }));
            return;
          }
          const chunks = []; let bytes = 0;
          res.on('data', (c) => {
            try {
              const b = (typeof Buffer !== 'undefined' && Buffer.isBuffer(c)) ? c : (typeof Buffer !== 'undefined' ? Buffer.from(c) : null);
              if (b) { bytes += b.length; if (chunks.length < 64 && bytes < 131072) chunks.push(b); }
            } catch {}
          });
          res.on('end', () => {
            let body;
            try { body = truncate((typeof Buffer !== 'undefined') ? Buffer.concat(chunks).toString('utf8') : '', 32768); }
            catch (e) { body = `<unreadable:${e && e.message}>`; }
            log({ id, transport: 'http-proto', event: 'res', url, status: res.statusCode, headers: resHeaders, body, bytes });
          });
        });
        req.on('error', (e) => log({ id, transport: 'http-proto', event: 'err', url, msg: String(e && e.message || e) }));
      };
      proto.write = function (chunk, ...rest) {
        try {
          _vakkaInit(this);
          if (chunk) {
            const buf = (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) ? chunk : (typeof Buffer !== 'undefined' ? Buffer.from(chunk) : null);
            if (buf) { this.__vakka_bytes += buf.length; if (this.__vakka_chunks.length < 32 && this.__vakka_bytes < 65536) this.__vakka_chunks.push(buf); }
          }
        } catch {}
        return origWrite.call(this, chunk, ...rest);
      };
      proto.end = function (chunk, ...rest) {
        try {
          _vakkaInit(this);
          if (chunk) {
            const buf = (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) ? chunk : (typeof Buffer !== 'undefined' ? Buffer.from(chunk) : null);
            if (buf) { this.__vakka_bytes += buf.length; if (this.__vakka_chunks.length < 32 && this.__vakka_bytes < 65536) this.__vakka_chunks.push(buf); }
          }
          const body = (typeof Buffer !== 'undefined') ? Buffer.concat(this.__vakka_chunks).toString('utf8') : '';
          if (body) log({ id: this.__vakka_id, transport: 'http-proto', event: 'reqbody', url: this.__vakka_url, body: truncate(body, 32768), bytes: this.__vakka_bytes });
        } catch {}
        return origEnd.call(this, chunk, ...rest);
      };
      log({ event: 'diag.protopatch', scheme: schemeDefault, ok: true });
    } else {
      log({ event: 'diag.protopatch', scheme: schemeDefault, ok: false, reason: 'no ClientRequest' });
    }
    mark(`${schemeDefault} prototype patched`);
  };

  // --- patch WebSocket ---
  const OrigWS = globalThis.WebSocket;
  if (typeof OrigWS === 'function') {
    function VakkaWS(url, protocols) {
      const id = ++seq;
      const urlStr = String(url);
      log({ id, transport: 'ws', event: 'open', url: urlStr, protocols: protocols ?? null });
      const ws = (protocols === undefined) ? new OrigWS(urlStr) : new OrigWS(urlStr, protocols);
      try {
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            let preview;
            if (typeof data === 'string') preview = truncate(data, 16384);
            else if (data && data.byteLength !== undefined) preview = `<bytes:${data.byteLength}>`;
            else preview = `<${data && data.constructor && data.constructor.name || typeof data}>`;
            log({ id, transport: 'ws', event: 'send', url: urlStr, data: preview });
          } catch {}
          return origSend(data);
        };
        ws.addEventListener('message', (ev) => {
          try {
            let preview;
            const d = ev.data;
            if (typeof d === 'string') preview = truncate(d, 32768);
            else if (d && d.byteLength !== undefined) preview = `<bytes:${d.byteLength}>`;
            else preview = `<${d && d.constructor && d.constructor.name || typeof d}>`;
            log({ id, transport: 'ws', event: 'recv', url: urlStr, data: preview });
          } catch {}
        });
        ws.addEventListener('close', (ev) => log({ id, transport: 'ws', event: 'close', url: urlStr, code: ev.code, reason: ev.reason }));
        ws.addEventListener('error', () => log({ id, transport: 'ws', event: 'error', url: urlStr }));
      } catch (e) { mark(`ws hook err: ${e && e.message}`); }
      return ws;
    }
    VakkaWS.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { VakkaWS[k] = OrigWS[k]; } catch {}
    }
    globalThis.WebSocket = VakkaWS;
    mark('WebSocket wrapped');
  } else {
    mark('globalThis.WebSocket not a function — skipping');
  }

  // --- patch XMLHttpRequest (axios's default browser-like adapter) ---
  const OrigXHR = globalThis.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    function VakkaXHR() {
      const xhr = new OrigXHR();
      const id = ++seq;
      let _method, _url, _reqHeaders = {};
      const origOpen = xhr.open.bind(xhr);
      const origSetHeader = xhr.setRequestHeader.bind(xhr);
      const origSend = xhr.send.bind(xhr);
      xhr.open = function (method, url, ...rest) { _method = method; _url = String(url); return origOpen(method, url, ...rest); };
      xhr.setRequestHeader = function (k, v) { try { _reqHeaders[String(k).toLowerCase()] = String(v); } catch {} return origSetHeader(k, v); };
      xhr.send = function (body) {
        let bodyPreview;
        try {
          if (typeof body === 'string') bodyPreview = truncate(body, 16384);
          else if (body && body.byteLength !== undefined) bodyPreview = `<bytes:${body.byteLength}>`;
          else if (body) bodyPreview = `<${body.constructor && body.constructor.name || typeof body}>`;
        } catch {}
        log({ id, transport: 'xhr', event: 'req', url: _url, method: _method, headers: _reqHeaders, body: bodyPreview });
        xhr.addEventListener('loadend', () => {
          try {
            const resHeaders = {};
            try {
              const raw = xhr.getAllResponseHeaders() || '';
              for (const line of raw.split('\r\n')) {
                const i = line.indexOf(':');
                if (i > 0) resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
              }
            } catch {}
            let resBody;
            try { resBody = truncate(typeof xhr.responseText === 'string' ? xhr.responseText : '', 32768); } catch {}
            log({ id, transport: 'xhr', event: 'res', url: _url, status: xhr.status, headers: resHeaders, body: resBody });
          } catch {}
        });
        return origSend(body);
      };
      return xhr;
    }
    VakkaXHR.prototype = OrigXHR.prototype;
    globalThis.XMLHttpRequest = VakkaXHR;
    mark('XMLHttpRequest wrapped');
  } else {
    mark('globalThis.XMLHttpRequest not a function — skipping');
  }

  // Diagnostic: which axios adapter is in scope?
  try {
    const probes = {
      hasFetch: typeof globalThis.fetch,
      hasXHR: typeof globalThis.XMLHttpRequest,
      hasWS: typeof globalThis.WebSocket,
      hasEventSource: typeof globalThis.EventSource,
      hasBunFetch: typeof (globalThis.Bun && globalThis.Bun.fetch),
      hasBunConnect: typeof (globalThis.Bun && globalThis.Bun.connect),
    };
    log({ event: 'env.probe', probes });
  } catch {}

  // Return the install promise so Runtime.evaluate(awaitPromise:true) blocks
  // until http/https patches are in place — otherwise CC's bundle resumes
  // before axios is hooked.
  return (async () => {
    let httpMod, httpsMod;
    try { httpMod = await import('node:http'); patchHttpModule(httpMod, 'http'); } catch (e) { mark(`http import failed: ${e && e.message}`); }
    try { httpsMod = await import('node:https'); patchHttpModule(httpsMod, 'https'); } catch (e) { mark(`https import failed: ${e && e.message}`); }
    try {
      const httpReqName = httpMod && httpMod.request && httpMod.request.name;
      const httpsReqName = httpsMod && httpsMod.request && httpsMod.request.name;
      log({ event: 'diag.httppatch', httpReq: httpReqName, httpsReq: httpsReqName });
    } catch {}
    log({ event: 'install.ok' });
    mark('install ok');
  })();
})();
