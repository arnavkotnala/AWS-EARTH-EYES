/**
 * Forest Eyes — Tree loss year replay (Tree Loss Form = "Year replay")
 * ====================================================================
 * Loaded AFTER app.js. Plays UMD/Hansen tree cover loss year by year, 2001 → 2024:
 *   - bright red dots  = loss in the year on screen
 *   - dim red dots     = loss in earlier years (optional trail)
 * The GFW loss tiles store each pixel's loss year in the BLUE channel (year − 2000) and the
 * loss intensity in RED. Each tile is decoded once; changing the year only repaints the canvases.
 *
 * Tiles come from v1.12 (2001–2024) through our own server (/tiles/gfw-loss/v1.12/…), because
 * reading pixels needs CORS, which the GFW tile server does not send. v1.12 tiles also contain
 * pixels with year 0 (no loss year); those are skipped. 2D map only, not the 3D Earth.
 */
(function () {
  'use strict';

  const CONFIG = {
    firstYear: 2001,
    lastYear: 2024,
    proxyUrl: '/tiles/gfw-loss/v1.12/{z}/{x}/{y}.png',
    directUrl: 'https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.12/tcd_30/{z}/{x}/{y}.png',
    maxNativeZoom: 12,
    // Seconds per year: slow enough to see each year's pattern before the next one replaces it
    speeds: { slow: 2.5, normal: 1.5, fast: 0.8 },
    defaultSpeed: 'normal',
    holdLastYear: 2.5,  // seconds 2024 stays on screen before the replay stops
    current: [255, 45, 35, 255],
    trail: [150, 20, 20, 120],
  };

  // ---------------------------------------------------------------------
  // Pure helpers (no DOM / map access)
  // ---------------------------------------------------------------------
  /** RGBA tile pixels → pixel indices grouped by loss year (index 0 = firstYear). */
  function bucketByYear(rgba, first = CONFIG.firstYear, last = CONFIG.lastYear) {
    const counts = new Uint32Array(last - first + 1);
    const n = rgba.length / 4;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (rgba[p + 3] === 0 || rgba[p] === 0) continue;
      const y = 2000 + rgba[p + 2] - first;
      if (y >= 0 && y < counts.length) counts[y]++;
    }
    const buckets = Array.from(counts, c => new Uint32Array(c));
    const fill = new Uint32Array(counts.length);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (rgba[p + 3] === 0 || rgba[p] === 0) continue;
      const y = 2000 + rgba[p + 2] - first;
      if (y >= 0 && y < counts.length) buckets[y][fill[y]++] = i;
    }
    return buckets;
  }

  /** Dot radius (in tile pixels) by zoom: single pixels are invisible when zoomed far out. */
  function dotRadius(z, tileWidth) {
    // In tile pixels (512 px tiles are shown at 256 px, so 1 = a 1.5 px dot on screen). Bigger dots
    // flood whole continents red at world zoom, hiding the pattern.
    return z <= 6 && tileWidth > 256 ? 1 : 0;
  }

  function paint(out, w, h, idx, rgba, r) {
    const [cr, cg, cb, ca] = rgba;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x0 = i % w, y0 = (i - x0) / w;
      for (let dy = -r; dy <= r; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = x0 + dx;
          if (x < 0 || x >= w) continue;
          const p = (y * w + x) * 4;
          if (out[p + 3] >= ca) continue; // never paint a trail dot over a current-year dot
          out[p] = cr; out[p + 1] = cg; out[p + 2] = cb; out[p + 3] = ca;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    year: CONFIG.firstYear,
    playing: false,
    trail: true,
    speed: CONFIG.defaultSpeed,
    timer: 0,
    active: false,
    failed: 0,
  };
  const tiles = new Map(); // tile key → { canvas, buckets, z }

  function renderTile(t) {
    const { canvas, buckets, z } = t;
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const yi = state.year - CONFIG.firstYear;
    const r = dotRadius(z, w);
    paint(img.data, w, h, buckets[yi] || [], CONFIG.current, r);
    if (state.trail) {
      const tr = Math.max(0, r - 1);
      for (let k = 0; k < yi; k++) paint(img.data, w, h, buckets[k], CONFIG.trail, tr);
    }
    ctx.putImageData(img, 0, 0);
  }

  function renderAll() { tiles.forEach(renderTile); }

  // ---------------------------------------------------------------------
  // Map layer
  // ---------------------------------------------------------------------
  const ReplayLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      const img = new Image();
      const served = location.protocol.startsWith('http');
      if (!served) img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = img.naturalWidth || 256, h = img.naturalHeight || 256;
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const buckets = bucketByYear(ctx.getImageData(0, 0, w, h).data);
          canvas.width = w; canvas.height = h;
          const t = { canvas, buckets, z: coords.z };
          tiles.set(this._tileCoordsToKey(coords), t);
          renderTile(t); // drawn at the year on screen now, even mid-replay
          done(null, canvas);
        } catch (err) {
          noteFailure();
          done(err, canvas);
        }
      };
      img.onerror = () => { noteFailure(); done(new Error('tile failed'), canvas); };
      img.src = L.Util.template(served ? CONFIG.proxyUrl : CONFIG.directUrl, coords);
      return canvas;
    },
  });

  const layer = new ReplayLayer({
    tileSize: 256,
    maxNativeZoom: CONFIG.maxNativeZoom,
    maxZoom: 19,
    zIndex: 6,
    className: 'fw-replay-layer',
    attribution: 'Tree Cover Loss 2001–2024 &copy; UMD/Hansen/Google/USGS/NASA',
  });
  layer.on('tileunload', e => tiles.delete(layer._tileCoordsToKey(e.coords)));

  // ---------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.className = 'fw-replay-panel hidden';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Tree loss year replay');
  panel.innerHTML = `
    <div class="fw-replay-top">
      <button type="button" class="fw-replay-play" aria-label="Play">▶</button>
      <div class="fw-replay-year" aria-live="polite">${CONFIG.firstYear}</div>
      <div class="fw-replay-stat"></div>
    </div>
    <input class="fw-replay-slider" type="range" min="${CONFIG.firstYear}" max="${CONFIG.lastYear}" step="1"
      value="${CONFIG.firstYear}" aria-label="Year">
    <div class="fw-replay-ticks"><span>${CONFIG.firstYear}</span><span>${CONFIG.lastYear}</span></div>
    <div class="fw-replay-options">
      <label>Speed
        <select class="fw-replay-speed" aria-label="Replay speed">
          <option value="slow">Slow (${CONFIG.speeds.slow} s/year)</option>
          <option value="normal" selected>Normal (${CONFIG.speeds.normal} s/year)</option>
          <option value="fast">Fast (${CONFIG.speeds.fast} s/year)</option>
        </select>
      </label>
      <label><input type="checkbox" class="fw-replay-trail" checked> Earlier years</label>
    </div>
    <div class="fw-replay-key">
      <span><i class="fw-replay-dot current"></i>Loss in this year</span>
      <span><i class="fw-replay-dot trail"></i>Earlier years</span>
    </div>
    <div class="fw-replay-note">UMD/Hansen tree cover loss (≥30 % canopy) via Global Forest Watch.
      Zoomed out, each dot stands for a larger area; zoom in for detail. The method changed over
      2011–2015, so early and late years are not strictly comparable.</div>
    <div class="fw-replay-error hidden"></div>`;
  document.body.appendChild(panel);

  const $play = panel.querySelector('.fw-replay-play');
  const $year = panel.querySelector('.fw-replay-year');
  const $stat = panel.querySelector('.fw-replay-stat');
  const $slider = panel.querySelector('.fw-replay-slider');
  const $speed = panel.querySelector('.fw-replay-speed');
  const $trail = panel.querySelector('.fw-replay-trail');
  const $error = panel.querySelector('.fw-replay-error');

  function noteFailure() {
    state.failed++;
    if (state.failed < 4 || !$error.classList.contains('hidden')) return;
    $error.textContent = location.protocol.startsWith('http')
      ? 'Some loss tiles could not be loaded. Check the connection and try again.'
      : 'Open Forest Eyes through the app server (npm start) to use the replay.';
    $error.classList.remove('hidden');
  }

  // Hectares for the analysed area, when the latest analysis has this year (app.js global)
  function analysedHa(year) {
    const rows = typeof latestLossRows !== 'undefined' ? latestLossRows : [];
    const row = rows.find(r => Number(r.year) === year);
    return row ? row.ha : null;
  }

  function updatePanel() {
    $year.textContent = state.year;
    $slider.value = state.year;
    $play.textContent = state.playing ? '❚❚' : '▶';
    $play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    const ha = analysedHa(state.year);
    $stat.textContent = ha == null ? '' : `${ha.toFixed(1)} ha lost in the analysed area`;
  }

  function setYear(year) {
    state.year = Math.min(Math.max(year, CONFIG.firstYear), CONFIG.lastYear);
    renderAll();
    updatePanel();
  }

  function tick() {
    state.timer = 0;
    if (!state.playing) return;
    if (state.year >= CONFIG.lastYear) { pause(); return; }
    setYear(state.year + 1);
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    const s = state.year >= CONFIG.lastYear ? CONFIG.holdLastYear : CONFIG.speeds[state.speed];
    state.timer = setTimeout(tick, s * 1000);
  }

  function play() {
    if (state.year >= CONFIG.lastYear) setYear(CONFIG.firstYear); // replay from the start
    state.playing = true;
    updatePanel();
    schedule();
  }

  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    state.timer = 0;
    updatePanel();
  }

  $play.addEventListener('click', () => (state.playing ? pause() : play()));
  $slider.addEventListener('input', e => { pause(); setYear(Number(e.target.value)); });
  $speed.addEventListener('change', e => {
    state.speed = e.target.value;
    if (state.playing) schedule();
  });
  $trail.addEventListener('change', e => { state.trail = e.target.checked; renderAll(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ---------------------------------------------------------------------
  // Public API — app.js calls refresh() from syncTreeLossLayer() and clearMapLayers()
  // ---------------------------------------------------------------------
  function isReplayVisible() {
    const enabled = document.getElementById('toggle-tree-loss')?.checked ?? true;
    return enabled && document.getElementById('tree-loss-mode')?.value === 'replay';
  }

  function sync() {
    const visible = isReplayVisible();
    if (visible && !state.active) {
      state.active = true;
      state.failed = 0;
      $error.classList.add('hidden');
      map.addLayer(layer);
      panel.classList.remove('hidden');
      setYear(CONFIG.firstYear);
      play(); // start straight away; tiles join at the current year as they arrive
    } else if (!visible && state.active) {
      state.active = false;
      pause();
      map.removeLayer(layer);
      panel.classList.add('hidden');
    }
    if (visible) updatePanel();
  }

  window.ForestReplay = {
    refresh: sync,
    play,
    pause,
    setYear,
    // Exposed for testing / reuse
    bucketByYear,
    dotRadius,
  };
})();
