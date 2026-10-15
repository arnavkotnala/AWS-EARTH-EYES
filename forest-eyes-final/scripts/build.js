/**
 * Build the two upload packages for AWS (no npm install needed):
 *   node scripts/build.js
 *
 *   dist/site/        frontend files only (what visitors download)
 *   dist/site.zip     → upload to AWS Amplify Hosting ("Deploy without Git")
 *   dist/lambda.zip   → upload to AWS Lambda (handler: lambda.handler)
 *
 * The backend code, server.js, .env and docs are never put in the site package.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FRONTEND_EXT = new Set(['.html', '.css', '.js']);
const NEVER_PUBLIC = new Set(['server.js']);

// --- minimal ZIP writer (deflate) -------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0o100644 << 16 >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// --- collect files ------------------------------------------------------------
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    if (d.name.startsWith('.')) return [];
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

const siteFiles = [
  ...fs.readdirSync(ROOT).filter(f => FRONTEND_EXT.has(path.extname(f)) && !NEVER_PUBLIC.has(f) && !f.startsWith('.'))
    .map(f => path.join(ROOT, f)),
  ...(fs.existsSync(path.join(ROOT, 'assets')) ? walk(path.join(ROOT, 'assets')) : []),
];
const lambdaFiles = [...['core.js', 'lambda.js'].map(f => path.join(ROOT, 'api', f)), path.join(ROOT, 'treeko-brain.js')];

// Safety net: refuse to publish anything that looks like a secret.
const SECRET_PATTERNS = [/AIza[0-9A-Za-z_-]{30,}/, /AQ\.[0-9A-Za-z_-]{30,}/, /x-api-key['"]?\s*[:=]\s*['"][0-9a-f-]{20,}/i];
for (const f of siteFiles) {
  const text = path.extname(f) === '.png' ? '' : fs.readFileSync(f, 'utf8');
  const hit = SECRET_PATTERNS.find(re => re.test(text));
  if (hit) { console.error(`✖ Refusing to build: ${path.relative(ROOT, f)} looks like it contains an API key.`); process.exit(1); }
}

fs.rmSync(DIST, { recursive: true, force: true });
const siteDir = path.join(DIST, 'site');
for (const f of siteFiles) {
  const out = path.join(siteDir, path.relative(ROOT, f));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(f, out);
}
const read = (files, base) => files.map(f => ({ name: path.relative(base, f), data: fs.readFileSync(f) }));
fs.writeFileSync(path.join(DIST, 'site.zip'), zip(read(siteFiles, ROOT)));
fs.writeFileSync(path.join(DIST, 'lambda.zip'), zip(lambdaFiles.map(f => ({ name: path.basename(f), data: fs.readFileSync(f) }))));

const kb = f => `${Math.round(fs.statSync(path.join(DIST, f)).size / 1024)} KB`;
console.log(`✔ dist/site.zip   (${siteFiles.length} files, ${kb('site.zip')})  → AWS Amplify Hosting`);
console.log(`✔ dist/lambda.zip (${lambdaFiles.length} files, ${kb('lambda.zip')})  → AWS Lambda, handler "lambda.handler"`);
