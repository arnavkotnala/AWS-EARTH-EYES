/**
 * Forest Eyes local server (server.js)
 * ====================================
 * Run:   node server.js            (Node 18 or newer, no npm install needed)
 * Open:  http://localhost:8080
 *
 * Serves the app's files and the backend API (api/core.js) on one origin, exactly like
 * the AWS setup (Amplify + API Gateway + Lambda) does when deployed. Secrets are read
 * from a .env file next to this one and never sent to the browser:
 *   GEMINI_API_KEY=...   GFW_API_KEY=...   GEMINI_MODEL=gemini-3.6-flash   PORT=8080
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));               // must run before api/core reads the settings
const core = require('./api/core');
const PORT = Number(process.env.PORT) || 8080;

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.md': 'text/markdown; charset=utf-8',
};
// Never served: dotfiles (.env), the backend code, build tooling and build output.
const PRIVATE_TOP = new Set(['server.js', 'api', 'scripts', 'dist', 'amplify.yml']);

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const parts = path.relative(ROOT, file).split(path.sep);
  if (!file.startsWith(ROOT + path.sep) || parts.some(p => p.startsWith('.')) || PRIVATE_TOP.has(parts[0])) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = c => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData);
        req.resume(); // discard the rest, but keep the connection so the 413 reply arrives
        reject(Object.assign(new Error('Message too long.'), { status: 413 }));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(fetchImpl = fetch) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      let result;
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, core.CONFIG.maxBodyBytes) : '';
        result = await core.handleApi({
          method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
        }, fetchImpl);
      } catch (err) {
        result = { status: err.status || 500, json: { error: err.status ? err.message : 'Something went wrong.' } };
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(result.headers || {}) });
      return res.end(JSON.stringify(result.json));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    res.writeHead(405); res.end();
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Forest Eyes running at http://localhost:${PORT}`);
    console.log(`Treeko: model ${core.CONFIG.model}, Gemini key ${core.CONFIG.apiKey ? 'loaded' : 'MISSING — add GEMINI_API_KEY to .env'}`);
    console.log(`GFW: key ${core.CONFIG.gfwKey ? 'loaded' : 'MISSING — add GFW_API_KEY to .env'}`);
  });
}

module.exports = { createServer, ...core };
