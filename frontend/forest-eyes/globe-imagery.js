/**
 * Forest Eyes — 3D Earth uses the same imagery as the 2D map (globe-imagery.js)
 * ============================================================================
 * Loaded AFTER app.js. Builds a whole-world texture from the exact base-map tiles the
 * 2D map shows (Esri satellite, or the dark basemap when Satellite is off), reprojected
 * from the map's Web Mercator to the globe's equirectangular layout, and puts it on the
 * original earth mesh. Same geometry, material, lights and controls; only the picture
 * changes, so 2D and 3D colours match.
 *
 * The texture is an <img> (blob URL), so heatmap.js can still recolour it for Heatmap
 * mode. If the tiles cannot be loaded, the globe keeps its original NASA texture.
 */
(function () {
  'use strict';

  const CONFIG = {
    maxZoom: 4,          // tile zoom → texture width 256·2^z (4 → 4096 × 2048)
    minCoverage: 0.95,   // share of tiles that must load before the texture is used
    jpegQuality: 0.92,
    fadeMs: 600,         // cross-fade when the picture changes while the globe is on screen
  };
  const MAX_MERC_LAT = 85.0511287798;

  const $ = id => document.getElementById(id);
  const entries = new Map(); // key → Promise<{ key, img } | null>
  let baseTex = null;        // texture the earth shows when not in Heatmap mode
  let originalTex = null;    // app.js's own texture (fallback)
  let wantedKey = '';

  function activeBase() {
    if (typeof map === 'undefined') return null;
    if (typeof satelliteBase !== 'undefined' && map.hasLayer(satelliteBase)) return satelliteBase;
    if (typeof darkBase !== 'undefined' && map.hasLayer(darkBase)) return darkBase;
    return typeof satelliteBase !== 'undefined' ? satelliteBase : null;
  }

  function textureZoom() {
    const maxTex = (typeof globeScene !== 'undefined' && globeScene?.renderer?.capabilities?.maxTextureSize) || 4096;
    let z = CONFIG.maxZoom;
    while (z > 2 && 256 * Math.pow(2, z) > maxTex) z--;
    return z;
  }

  function tileUrl(layer, x, y, z) {
    const subs = layer.options.subdomains || '';
    const s = subs.length ? subs[Math.abs(x + y) % subs.length] : '';
    return L.Util.template(layer._url, Object.assign({}, layer.options, {
      s, x, y, z, r: L.Browser.retina ? '@2x' : '', // same {r} rule as Leaflet
    }));
  }

  function loadTile(url) {
    return new Promise(resolve => {
      const img = new Image();
      let retried = false;
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        // The 2D map caches these tiles without CORS; a distinct URL fetches a CORS copy.
        if (retried) return resolve(null);
        retried = true;
        img.src = url + (url.includes('?') ? '&' : '?') + 'fwglobe=1';
      };
      img.src = url;
    });
  }

  /** Mercator tiles → equirectangular <img> (blob URL). Resolves null on failure. */
  function build(layer, z, key) {
    if (entries.has(key)) return entries.get(key);
    const job = (async () => {
      const n = Math.pow(2, z);
      const W = 256 * n;
      const jobs = [];
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) jobs.push(loadTile(tileUrl(layer, x, y, z)).then(img => ({ x, y, img })));
      }
      const tiles = await Promise.all(jobs);
      const ok = tiles.filter(t => t.img);
      if (ok.length / tiles.length < CONFIG.minCoverage) {
        console.warn('[globe-imagery] Base-map tiles could not be loaded for the 3D globe; keeping its original texture.');
        return null;
      }
      const merc = document.createElement('canvas');
      merc.width = merc.height = W;
      const mctx = merc.getContext('2d');
      ok.forEach(({ x, y, img }) => mctx.drawImage(img, x * 256, y * 256, 256, 256));

      const H = W / 2;
      const eq = document.createElement('canvas');
      eq.width = W;
      eq.height = H;
      const ectx = eq.getContext('2d');
      for (let j = 0; j < H; j++) {
        const lat = Math.min(Math.max(90 - ((j + 0.5) / H) * 180, -MAX_MERC_LAT), MAX_MERC_LAT) * Math.PI / 180;
        const my = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * W;
        ectx.drawImage(merc, 0, Math.min(Math.floor(my), W - 1), W, 1, 0, j, W, 1);
      }
      merc.width = merc.height = 0; // free memory

      try {
        ectx.getImageData(0, 0, 1, 1); // throws if a tile tainted the canvas (WebGL could not use it)
      } catch (err) {
        console.warn('[globe-imagery] Base-map tiles are not usable in 3D (CORS); keeping the original texture.');
        return null;
      }
      const blob = await new Promise(res => eq.toBlob(res, 'image/jpeg', CONFIG.jpegQuality));
      eq.width = eq.height = 0;
      if (!blob) return null;
      const img = new Image();
      img.src = URL.createObjectURL(blob); // kept: heatmap.js may reload it by src
      await img.decode();
      return { key, img };
    })().catch(err => {
      console.warn('[globe-imagery] Failed to build globe imagery:', err?.message || err);
      return null;
    });
    entries.set(key, job);
    job.then(e => { if (!e) entries.delete(key); }); // allow a later retry
    return job;
  }

  function globeOnScreen() {
    const container = $('globe-container');
    return !!container && !container.classList.contains('hidden') && globeScene.earth.visible &&
      !window.ForestGlobeTransition?.isRunning?.();
  }

  /** Put `tex` on the earth; cross-fade from the old picture if the globe is on screen. */
  function setEarthTexture(tex) {
    const earth = globeScene.earth;
    const old = earth.material.map;
    if (!globeOnScreen() || !old) {
      earth.material.map = tex;
      return;
    }
    const veil = new THREE.Mesh(earth.geometry, new THREE.MeshPhongMaterial({
      map: old,
      specular: earth.material.specular.clone(),
      shininess: earth.material.shininess,
      transparent: true,
      depthWrite: false,
    }));
    veil.scale.setScalar(1.0008);
    veil.renderOrder = 1;
    earth.add(veil); // rotates with the earth; below the loss / heat overlays
    earth.material.map = tex;
    const t0 = performance.now();
    const fade = () => {
      const f = Math.min((performance.now() - t0) / CONFIG.fadeMs, 1);
      veil.material.opacity = 1 - f * f * (3 - 2 * f);
      if (f < 1) return requestAnimationFrame(fade);
      earth.remove(veil);
      veil.material.dispose(); // geometry is the earth's own: not disposed
    };
    requestAnimationFrame(fade);
  }

  /** Make the globe show the imagery of the 2D map's current base layer. */
  function apply() {
    if (typeof THREE === 'undefined' || typeof globeScene === 'undefined' || !globeScene) return;
    const earth = globeScene.earth;
    // Adopt app.js's photo texture as the original; never heatmap.js's canvas texture.
    const isPhoto = t => typeof t?.image?.src === 'string';
    if (!originalTex && isPhoto(earth.material.map)) originalTex = baseTex = earth.material.map;
    if (!baseTex) return; // Heatmap mode is showing; retried when the mode changes
    const layer = activeBase();
    if (!layer) return;
    const z = textureZoom();
    const key = `${layer._url}|${z}`;
    wantedKey = key;
    build(layer, z, key).then(entry => {
      if (!entry || wantedKey !== key || !globeScene) return;
      if (baseTex?.userData?.fwKey === key) return; // already showing it
      // In Heatmap mode heatmap.js shows its own texture; swap once it restores ours.
      if (earth.material.map !== baseTex) return;
      const tex = new THREE.Texture(entry.img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = globeScene.renderer.capabilities.getMaxAnisotropy?.() || 1;
      tex.needsUpdate = true;
      tex.userData.fwKey = key;
      const previous = baseTex;
      baseTex = tex;
      setEarthTexture(tex);
      if (previous && previous !== originalTex) setTimeout(() => previous.dispose(), CONFIG.fadeMs + 100);
    });
  }

  /** Start building early (e.g. when the 2D map nears the world view). */
  function preload() {
    if (typeof THREE === 'undefined') return;
    const layer = activeBase();
    if (layer) build(layer, textureZoom(), `${layer._url}|${textureZoom()}`);
  }

  // Re-check whenever something that affects the globe's picture changes.
  ['toggle-globe', 'toggle-satellite', 'tree-loss-mode', 'toggle-tree-loss'].forEach(id => {
    $(id)?.addEventListener('change', apply);
  });

  window.ForestGlobeImagery = { apply, preload };
})();
