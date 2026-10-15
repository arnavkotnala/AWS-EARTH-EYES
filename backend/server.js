/**
 * Earth Intelligence Platform — Unified Master Server (server.js)
 * ===============================================================
 * Serves the web app in ../frontend and the APIs of Forest Eyes, River Eyes and the Hazard Lens.
 * Run (from the project root): npm start   — or: node backend/server.js
 * Open: http://localhost:8080
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');            // project root
const FRONTEND = path.join(ROOT, 'frontend');       // the only folder served to browsers

// Keys live in .env at the project root (or backend/.env); on a host, in its environment settings.
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(__dirname, '.env'));

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

const PORT = Number(process.env.PORT) || 8080;

// Load Forest Eyes core API
let forestCore = null;
try {
  forestCore = require('./forest-api.js');
} catch (err) {
  console.warn('Forest Eyes core API load note:', err.message);
}

// Shared Gemma 4 client — Treeko, Aqua and the Hazard Lens all answer through it
const gemma = require('./gemma.js');
forestCore?.setGenerator(gemma.generate);
const hazard = require('./hazard.js');
const dam = require('./dam.js');
const site = require('./site.js');
const rivers = require('./rivers.js');
const traceCache = new Map();
const networkCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.md':   'text/markdown; charset=utf-8',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        req.resume();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';

  // Only frontend/ is public, and never hidden files (.env, .git…).
  if (rel.split(/[\\/]/).some(seg => seg.startsWith('.') || seg === 'node_modules')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('404 Not Found');
  }
  const file = path.normalize(path.join(FRONTEND, rel));

  if (!file.startsWith(FRONTEND + path.sep)) {
    res.writeHead(403); return res.end('Access denied');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache, no-store, must-revalidate'
    });
    res.end(buf);
  });
}

// Aqua for River Eyes — answers through the shared Gemma 4 client (gemma.js)
async function handleAquaChat(body) {
  const query = String(body.query || '').slice(0, 2000).trim();
  const riverName = String(body.context?.riverName || 'River Basin').slice(0, 120);
  const coords = JSON.stringify(body.context?.coordinates || []).slice(0, 300);
  if (!query) return { status: 400, json: { error: 'Ask a question first.' } };

  const system = `You are Aqua, the hydrology and dam-siting assistant inside River Eyes.
Context river: ${riverName}
Coordinates: ${coords}
Give a concise expert answer on hydrology, water quality (WQI), floods or hydropower/dam siting.
Use markdown bullet points and formulas where helpful. Say clearly when you are estimating rather than using measured data. Never invent measurements.`;

  try {
    const { text, model, gemma: isGemma } = await gemma.generate({
      system,
      contents: [{ role: 'user', parts: [{ text: query }] }],
    });
    return { status: 200, json: { text, model, gemma: isGemma } };
  } catch (err) {
    return { status: err.status || 502, json: { error: err.message } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // 1. Forest Eyes APIs (/api/...)
  if (url.pathname.startsWith('/api/treeko') || url.pathname.startsWith('/api/gfw') || url.pathname === '/api/health') {
    if (forestCore) {
      try {
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, 64 * 1024) : '';
        const result = await forestCore.handleApi({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body
        }, fetch);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(result.headers || {})
        });
        return res.end(JSON.stringify(result.json));
      } catch (err) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 2. River Eyes APIs (/api/v1/...)
  if (url.pathname === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'HEALTHY',
      service: 'Earth Intelligence Platform (Forest Eyes + River Eyes)',
      version: '2.5.0',
      ai: gemma.describe(),
      timestamp: new Date().toISOString()
    }));
  }

  if (url.pathname === '/api/v1/aqua/chat' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 64 * 1024);
      const parsed = JSON.parse(raw);
      const ans = await handleAquaChat(parsed);
      res.writeHead(ans.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(ans.json));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Ground conditions at a site: soil, earthquakes, river flow (/api/v1/site)
  if (url.pathname === '/api/v1/site' && req.method === 'POST') {
    try {
      const result = await site.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Site data failed.' }));
    }
  }

  // City planner: dam sites to supply a city's demand (/api/v1/dam/plan) — { city, lat, lon, targetMw, radiusKm }
  if (url.pathname === '/api/v1/dam/plan' && req.method === 'POST') {
    try {
      const result = await dam.plan(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[dam plan]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Planning failed (elevation or river data unavailable). Try again.' }));
    }
  }

  // Hydropower site screening along the real river (/api/v1/dam/screen)
  if (url.pathname === '/api/v1/dam/screen' && req.method === 'POST') {
    try {
      const result = await dam.screen(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[dam]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Elevation data is unavailable right now. Try again.' }));
    }
  }

  // River network for the map (/api/v1/rivers/network?bbox=w,s,e,n&z=zoom) — gzipped, cached by tile-ish key
  if (url.pathname === '/api/v1/rivers/network' && req.method === 'GET') {
    const bbox = String(url.searchParams.get('bbox') || '').split(',').map(Number);
    const z = Math.max(0, Math.min(18, Math.round(Number(url.searchParams.get('z')))));
    if (bbox.length !== 4 || !bbox.every(Number.isFinite) || !Number.isFinite(z) || !rivers.available()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bbox=w,s,e,n and z are required' }));
    }
    // Snap the box outward to a grid that depends on zoom, so panning reuses cached answers
    const step = z <= 3 ? 360 : z <= 5 ? 10 : z <= 7 ? 2 : 0.5;
    const [w, s, e, n] = [
      Math.max(-180, Math.floor(bbox[0] / step) * step), Math.max(-90, Math.floor(bbox[1] / step) * step),
      Math.min(180, Math.ceil(bbox[2] / step) * step), Math.min(90, Math.ceil(bbox[3] / step) * step),
    ];
    // Categories to send (1 = small … 5 = largest); default all
    const classes = new Set(String(url.searchParams.get('classes') || '1,2,3,4,5').split(',').map(Number).filter(c => c >= 1 && c <= 5));
    const key = `${z}|${w},${s},${e},${n}|${[...classes].sort().join('')}`;
    let gz = networkCache.get(key);
    if (!gz) {
      gz = zlib.gzipSync(JSON.stringify(rivers.network([w, s, e, n], z, classes)));
      if (networkCache.size > 300) networkCache.delete(networkCache.keys().next().value);
      networkCache.set(key, gz);
    }
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}),
    });
    return res.end(acceptsGzip ? gz : zlib.gunzipSync(gz));
  }

  // Real river geometry from rough sketches (/api/v1/rivers/trace) — { sketches: { id: [[lat, lon], ...] } }
  if (url.pathname === '/api/v1/rivers/trace' && req.method === 'POST') {
    try {
      const { sketches } = JSON.parse(await readBody(req, 256 * 1024) || '{}');
      if (!sketches || typeof sketches !== 'object') throw Object.assign(new Error('sketches required'), { status: 400 });
      const out = {};
      for (const [id, sketch] of Object.entries(sketches).slice(0, 50)) {
        if (!Array.isArray(sketch) || sketch.length < 2 || !sketch.every(p => Array.isArray(p) && p.every(Number.isFinite))) continue;
        const key = JSON.stringify(sketch);
        if (!traceCache.has(key)) traceCache.set(key, rivers.traceAlong(sketch));
        out[id] = traceCache.get(key);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ rivers: out, source: 'HydroRIVERS v1.0 (HydroSHEDS)' }));
    } catch (err) {
      res.writeHead(err.status || 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Hazard Lens (/api/v1/hazard) — satellite image + global data → Gemma 4 hazard reading
  if (url.pathname === '/api/v1/hazard' && req.method === 'POST') {
    try {
      const result = await hazard.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Hazard Lens failed.' }));
    }
  }

  // Global soil profile (/api/v1/soil) — reuses Forest Eyes' ISRIC SoilGrids client
  if (url.pathname === '/api/v1/soil' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!forestCore || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Valid lat and lon are required.' }));
    }
    // A full SoilGrids profile often takes 20+ s, so allow longer than Treeko's 5 s budget.
    const soil = await require('../frontend/forest-eyes/treeko-brain.js').getSoil(lat, lon, fetch, 35000);
    res.writeHead(soil ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(soil || { error: 'SoilGrids is unavailable right now.' }));
  }

  // Weather Proxy (/api/v1/weather)
  if (url.pathname === '/api/v1/weather') {
    const lat = url.searchParams.get('lat') || '30.38';
    const lon = url.searchParams.get('lon') || '79.32';
    try {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m`;
      const wRes = await fetch(weatherUrl);
      const wData = await wRes.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(wData));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3. Static Files Serving
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`🌍 Earth Intelligence Platform (Forest Eyes ⇄ River Eyes)`);
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Forest Eyes: 3D Globe, Hansen Tree Loss, Treeko AI`);
  console.log(`   River Eyes:  High-Precision Centerlines, Dam Siting, Aqua AI`);
  console.log(`   Transition:  Fluid Water Flood ⇄ Tree Absorption Engine`);
  console.log(`================================================================\n`);
});
