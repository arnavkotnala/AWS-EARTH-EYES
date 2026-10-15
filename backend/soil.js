/**
 * Earth Intelligence Platform — instant soil lookups for India (soil.js)
 * ======================================================================
 * Reads data/soil_india.bin (built by scripts/build-soil-india.py from ISRIC SoilGrids 2.0):
 * a ~2 km grid of topsoil (0-30 cm) properties for the India region. Lookups take < 1 ms
 * instead of 2-25 s from the SoilGrids REST API.
 *
 * SoilGrids leaves out water, rock, ice and built-up land, which is exactly where towns
 * and river channels are. lookup() therefore returns the NEAREST cell with soil data
 * (within maxKm) and says how far away it is.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'soil_india.bin');
const NODATA = -32768;
// SoilGrids integer units → real units
const SCALE = { clay: 10, sand: 10, silt: 10, cfvo: 10, bdod: 100, soc: 10, phh2o: 10 };

let grid;

function load() {
  if (grid !== undefined) return grid;
  try {
    const b = fs.readFileSync(FILE);
    if (b.toString('latin1', 0, 4) !== 'SOIL') throw new Error('bad header');
    const [W, S, E, N, res] = [0, 1, 2, 3, 4].map(k => b.readDoubleLE(8 + 8 * k));
    const width = b.readUInt32LE(48), height = b.readUInt32LE(52), nProps = b.readUInt32LE(56);
    let off = 60;
    const names = [];
    for (let k = 0; k < nProps; k++) { names.push(b.toString('latin1', off, off + 8).replace(/\0+$/, '')); off += 8; }
    const layers = {};
    for (const name of names) {
      layers[name] = new Int16Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + width * height * 2));
      off += width * height * 2;
    }
    grid = { W, S, E, N, res, width, height, layers };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[soil] could not load soil grid:', err.message);
    grid = null;
  }
  return grid;
}

function available() { return !!load(); }

function inside(lat, lon) {
  const g = load();
  return !!g && lon >= g.W && lon < g.E && lat >= g.S && lat < g.N;
}

/** USDA soil texture class from clay / silt / sand percentages. */
function textureClass(clay, silt, sand) {
  if (![clay, silt, sand].every(Number.isFinite)) return null;
  if (silt + 1.5 * clay < 15) return 'Sand';
  if (silt + 2 * clay < 30) return 'Loamy sand';
  if (clay >= 40 && silt >= 40) return 'Silty clay';
  if (clay >= 40 && sand <= 45) return 'Clay';
  if (clay >= 35 && sand > 45) return 'Sandy clay';
  if (clay >= 27 && sand <= 20) return 'Silty clay loam';
  if (clay >= 27 && sand <= 45) return 'Clay loam';
  if (clay >= 20 && silt < 28 && sand > 45) return 'Sandy clay loam';
  if (silt >= 80 && clay < 12) return 'Silt';
  if (silt >= 50) return 'Silt loam';
  if (clay >= 7 && silt >= 28 && sand <= 52) return 'Loam';
  return 'Sandy loam';
}

/**
 * Topsoil at (lat, lon), or at the nearest cell with data within maxKm.
 * Returns null outside the India grid or when nothing is found nearby.
 */
function lookup(lat, lon, maxKm = 5) {
  const g = load();
  if (!g || !inside(lat, lon)) return null;
  const col = Math.floor((lon - g.W) / g.res), row = Math.floor((g.N - lat) / g.res);
  const cellKm = g.res * 111.32 * Math.cos(lat * Math.PI / 180);
  const maxRing = Math.ceil(maxKm / Math.min(cellKm, g.res * 111.32));
  const has = (r, c) => r >= 0 && r < g.height && c >= 0 && c < g.width && g.layers.clay[r * g.width + c] !== NODATA;
  for (let ring = 0; ring <= maxRing; ring++) {
    let best = null, bestKm = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring || !has(row + dr, col + dc)) continue;
        const cLat = g.N - (row + dr + 0.5) * g.res, cLon = g.W + (col + dc + 0.5) * g.res;
        const km = Math.hypot((cLat - lat) * 111.32, (cLon - lon) * 111.32 * Math.cos(lat * Math.PI / 180));
        if (km < bestKm) { bestKm = km; best = (row + dr) * g.width + col + dc; }
      }
    }
    if (best !== null && bestKm <= maxKm + g.res * 111.32) {
      const v = name => {
        const x = g.layers[name]?.[best];
        return x === undefined || x === NODATA ? null : +(x / SCALE[name]).toFixed(name === 'bdod' ? 2 : 1);
      };
      const clay = v('clay'), silt = v('silt'), sand = v('sand');
      return {
        hasData: true,
        clayPct: clay, siltPct: silt, sandPct: sand,
        coarseFragmentsPct: v('cfvo'),
        bulkDensity: v('bdod'),
        organicCarbonGkg: v('soc'),
        pH: v('phh2o'),
        textureClass: textureClass(clay, silt, sand),
        distanceKm: ring === 0 ? 0 : +bestKm.toFixed(1),
        source: 'ISRIC SoilGrids 2.0, India grid (~2 km, top 30 cm)',
      };
    }
  }
  return null;
}

module.exports = { load, available, inside, lookup, textureClass };
