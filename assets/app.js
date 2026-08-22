/* ==========================================================================
   EQ WATCH — application logic
   Data flow: try live USGS GeoJSON feeds first (client-side fetch, USGS
   feeds are CORS-enabled). If that fails (network blocked, offline, rate
   limited) fall back to the local snapshot in /data/*.json, which a
   scheduled GitHub Action keeps in sync every ~10 minutes.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     Config
     --------------------------------------------------------------------- */

  const FEEDS = {
    hour: {
      label: "Past Hour",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson",
      cached: "data/hour.json",
    },
    day: {
      label: "Past Day",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      cached: "data/day.json",
    },
    major: {
      label: "M4.5+ Day",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      cached: "data/major.json",
    },
  };

  const REFRESH_MS = 60_000;      // re-poll live feed every 60s
  const NEW_QUAKE_WINDOW_MS = 15 * 60_000; // "new" ripple badge window

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */

  const state = {
    feedKey: "day",
    minMag: 2.5,
    features: [],       // currently loaded, unfiltered
    focusedId: null,
    lastSync: null,      // Date
    isLive: false,
  };

  /* ---------------------------------------------------------------------
     Small utilities
     --------------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function magColor(mag) {
    if (mag >= 6) return "#ff5468";
    if (mag >= 5) return "#ffb238";
    if (mag >= 4) return "#3fd8c4";
    return "#7d8aa8";
  }

  function magColorHex(mag) {
    if (mag >= 6) return 0xff5468;
    if (mag >= 5) return 0xffb238;
    if (mag >= 4) return 0x3fd8c4;
    return 0x7d8aa8;
  }

  function magRadius(mag) {
    return Math.max(2.6, Math.sqrt(Math.max(mag, 0.1)) * 3.1);
  }

  function timeAgo(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function fmtDepth(km) {
    if (km == null || isNaN(km)) return "—";
    return `${km.toFixed(0)} km`;
  }

  // Smoothly animates a number counter's textContent from its current
  // displayed value to `to`. Used so the sidebar reads like a live
  // instrument rather than a page that just re-renders.
  function animateNumber(el, to, { decimals = 0, prefix = "", suffix = "" } = {}) {
    if (!el) return;
    const from = parseFloat(el.dataset.animVal || "0") || 0;
    if (Math.abs(from - to) < 0.001) {
      el.textContent = `${prefix}${to.toFixed(decimals)}${suffix}`;
      el.dataset.animVal = String(to);
      return;
    }
    const dur = 550;
    const start = performance.now();
    function step(ts) {
      const t = clamp((ts - start) / dur, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      el.textContent = `${prefix}${val.toFixed(decimals)}${suffix}`;
      if (t < 1) requestAnimationFrame(step);
      else el.dataset.animVal = String(to);
    }
    requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------------------
     Data loading
     --------------------------------------------------------------------- */

  async function fetchJSON(url, { timeoutMs = 8000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, mode: "cors", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function loadFeed(feedKey) {
    const feed = FEEDS[feedKey];
    try {
      const data = await fetchJSON(feed.live);
      state.isLive = true;
      return data;
    } catch (err) {
      console.warn(`Live fetch failed for ${feedKey}, falling back to cache:`, err.message);
      try {
        const data = await fetchJSON(feed.cached, { timeoutMs: 5000 });
        state.isLive = false;
        return data;
      } catch (err2) {
        console.error(`Cached fallback also failed for ${feedKey}:`, err2.message);
        state.isLive = false;
        return null;
      }
    }
  }

  /* ---------------------------------------------------------------------
     Globe module — realistic textured 3-D Earth (Three.js / WebGL)
     --------------------------------------------------------------------- */

  const Globe = (() => {
    const TEX_BASE =
      "https://raw.githubusercontent.com/mrdoob/three.js/r128/examples/textures/planets/";
    const EARTH_R = 1;

    let renderer, scene, camera, earthGroup, cloudsMesh, markersGroup;
    let raycaster, pointerNDC;
    let panelEl, canvasEl;
    let width = 0, height = 0;

    let glowTexture, ringTexture;
    let markerMeshes = [];

    let initialQuat = null;
    let focusAnim = null;         // { startQuat, targetQuat, start, dur }
    let autoRotateEnabled = true;
    let dragging = false, hovering = false, dragMoved = false;
    let lastX = 0, lastY = 0;
    let velYaw = 0, velPitch = 0;

    const DEFAULT_ZOOM = 3.05;
    let zoomDist = DEFAULT_ZOOM;
    const ZOOM_MIN = 1.85, ZOOM_MAX = 5.4;

    const clock = new THREE.Clock();

    function latLonToVec3(lat, lon, r) {
      const phi = (90 - lat) * (Math.PI / 180);
      const theta = (lon + 180) * (Math.PI / 180);
      return new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }

    function makeGlowTexture() {
      const size = 128;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.32, "rgba(255,255,255,0.9)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    }

    function makeRingTexture() {
      const size = 128;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      for (let i = 0; i < 5; i++) {
        const rr = size / 2 - 4 - i * 3;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255,255,255,${0.5 - i * 0.09})`;
        ctx.lineWidth = 2.4;
        ctx.arc(size / 2, size / 2, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    }

    function makeStarfield() {
      const N = 3400;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const r = 30 + Math.random() * 55;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        pos[i * 3 + 2] = r * Math.cos(phi);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xdfe8ff,
        size: 0.05,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      });
      return new THREE.Points(geo, mat);
    }

    function makeAtmosphere() {
      const geo = new THREE.SphereGeometry(EARTH_R * 1.16, 64, 64);
      const mat = new THREE.ShaderMaterial({
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.64 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);
            gl_FragColor = vec4(0.35, 0.66, 1.0, 1.0) * clamp(intensity, 0.0, 1.0);
          }`,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      });
      return new THREE.Mesh(geo, mat);
    }

    function init() {
      panelEl = $("#mapPanel");
      canvasEl = $("#globeCanvas");
      width = panelEl.clientWidth;
      height = panelEl.clientHeight;

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
      camera.position.set(0, 0, zoomDist);

      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      if ("outputEncoding" in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

      scene.add(new THREE.AmbientLight(0x8fa6d0, 0.68));
      const sun = new THREE.DirectionalLight(0xffffff, 1.25);
      sun.position.set(5, 2.4, 3.2);
      scene.add(sun);

      scene.add(makeStarfield());
      scene.add(makeAtmosphere());

      earthGroup = new THREE.Group();
      const initEuler = new THREE.Euler(-0.24, 0.4, 0, "XYZ");
      initialQuat = new THREE.Quaternion().setFromEuler(initEuler);
      earthGroup.quaternion.copy(initialQuat);
      scene.add(earthGroup);

      const loader = new THREE.TextureLoader();
      loader.crossOrigin = "anonymous";
      const dayMap = loader.load(TEX_BASE + "earth_atmos_2048.jpg");
      const specMap = loader.load(TEX_BASE + "earth_specular_2048.jpg");
      const normalMap = loader.load(TEX_BASE + "earth_normal_2048.jpg");
      const cloudsMap = loader.load(TEX_BASE + "earth_clouds_1024.png");
      if ("sRGBEncoding" in THREE) dayMap.encoding = THREE.sRGBEncoding;

      const earthGeo = new THREE.SphereGeometry(EARTH_R, 96, 96);
      const earthMat = new THREE.MeshPhongMaterial({
        map: dayMap,
        specularMap: specMap,
        specular: new THREE.Color(0x2b3040),
        shininess: 14,
        normalMap: normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
      });
      const earthMesh = new THREE.Mesh(earthGeo, earthMat);
      earthGroup.add(earthMesh);

      const cloudGeo = new THREE.SphereGeometry(EARTH_R * 1.008, 96, 96);
      const cloudMat = new THREE.MeshLambertMaterial({
        map: cloudsMap,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      });
      cloudsMesh = new THREE.Mesh(cloudGeo, cloudMat);
      earthGroup.add(cloudsMesh);

      // Faint scientific-instrument graticule, hugging the surface.
      const gridGeo = new THREE.SphereGeometry(EARTH_R * 1.002, 24, 16);
      const gridEdges = new THREE.EdgesGeometry(gridGeo, 1);
      const grid = new THREE.LineSegments(
        gridEdges,
        new THREE.LineBasicMaterial({ color: 0x3fd8c4, transparent: true, opacity: 0.05 })
      );
      earthGroup.add(grid);

      markersGroup = new THREE.Group();
      earthGroup.add(markersGroup);

      glowTexture = makeGlowTexture();
      ringTexture = makeRingTexture();

      raycaster = new THREE.Raycaster();
      if (raycaster.params.Sprite) raycaster.params.Sprite.threshold = 0.04;
      pointerNDC = new THREE.Vector2();

      wireInteraction();
      onResize();
      window.addEventListener("resize", onResize);
      requestAnimationFrame(animate);
    }

    function onResize() {
      width = panelEl.clientWidth;
      height = panelEl.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    }

    /* ---------------- markers ---------------- */

    function magSize(mag) {
      return clamp(0.02 + Math.sqrt(Math.max(mag, 0.1)) * 0.013, 0.024, 0.088);
    }

    function disposeMarker(m) {
      [m.core, m.beam].forEach((mesh) => {
        if (!mesh) return;
        mesh.geometry.dispose();
        mesh.material.dispose();
      });
    }

    function clearMarkers() {
      markerMeshes.forEach((m) => {
        markersGroup.remove(m.group);
        disposeMarker(m);
      });
      markerMeshes = [];
    }

    function buildMarkers(features) {
      clearMarkers();
      const now = Date.now();
      features.forEach((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const mag = f.properties.mag || 0;
        const color = magColorHex(mag);
        const size = magSize(mag);
        const pos = latLonToVec3(lat, lon, EARTH_R * 1.004);
        const normal = pos.clone().normalize();

        const group = new THREE.Group();
        group.position.copy(pos);

        const glowMat = new THREE.SpriteMaterial({
          map: glowTexture, color, transparent: true,
          depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const glow = new THREE.Sprite(glowMat);
        const baseGlowScale = size * 2.7;
        glow.scale.set(baseGlowScale, baseGlowScale, 1);
        group.add(glow);

        const coreGeo = new THREE.CircleGeometry(size * 0.5, 16);
        const coreMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        group.add(core);

        const isNew = now - f.properties.time < NEW_QUAKE_WINDOW_MS;
        let ring = null;
        if (isNew) {
          const ringMat = new THREE.SpriteMaterial({
            map: ringTexture, color, transparent: true,
            depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9,
          });
          ring = new THREE.Sprite(ringMat);
          const baseRingScale = size * 2.2;
          ring.scale.set(baseRingScale, baseRingScale, 1);
          ring.userData.base = baseRingScale;
          group.add(ring);
        }

        let beam = null;
        if (mag >= 5) {
          const beamHeight = 0.05 + (mag - 5) * 0.045;
          const beamGeo = new THREE.CylinderGeometry(size * 0.1, size * 0.26, beamHeight, 10, 1, true);
          const beamMat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.32,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
          });
          beam = new THREE.Mesh(beamGeo, beamMat);
          beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
          beam.position.copy(normal.clone().multiplyScalar(beamHeight / 2));
          group.add(beam);
        }

        markersGroup.add(group);
        markerMeshes.push({
          feature: f, id: f.id, group, glow, core, ring, beam,
          baseGlowScale, phase: Math.random() * Math.PI * 2,
          ringStart: performance.now() - Math.random() * 2200,
        });
      });
    }

    function getFiltered() {
      return state.features.filter((f) => (f.properties.mag || 0) >= state.minMag);
    }

    function refresh() {
      buildMarkers(getFiltered());
    }

    /* ---------------- interaction ---------------- */

    function wireInteraction() {
      const el = canvasEl;
      el.style.touchAction = "none";

      el.addEventListener("pointerdown", (e) => {
        dragging = true;
        dragMoved = false;
        lastX = e.clientX;
        lastY = e.clientY;
        velYaw = 0; velPitch = 0;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      });

      el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
        const s = 0.0052;
        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * s);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * s);
        earthGroup.quaternion.premultiply(qYaw).premultiply(qPitch);
        velYaw = dx * s * 0.5;
        velPitch = dy * s * 0.5;
        lastX = e.clientX;
        lastY = e.clientY;
        focusAnim = null;
      });

      el.addEventListener("pointerup", (e) => {
        dragging = false;
        if (!dragMoved) handlePick(e);
      });
      el.addEventListener("pointercancel", () => (dragging = false));
      el.addEventListener("mouseenter", () => (hovering = true));
      el.addEventListener("mouseleave", () => (hovering = false));

      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        zoomDist = clamp(zoomDist * (e.deltaY < 0 ? 0.91 : 1.09), ZOOM_MIN, ZOOM_MAX);
      }, { passive: false });

      $("#zoomIn").addEventListener("click", () => {
        zoomDist = clamp(zoomDist * 0.84, ZOOM_MIN, ZOOM_MAX);
      });
      $("#zoomOut").addEventListener("click", () => {
        zoomDist = clamp(zoomDist * 1.19, ZOOM_MIN, ZOOM_MAX);
      });
      $("#resetView").addEventListener("click", () => {
        state.focusedId = null;
        Sidebar.setFocused(null);
        autoRotateEnabled = true;
        zoomDist = DEFAULT_ZOOM;
        focusAnim = {
          startQuat: earthGroup.quaternion.clone(),
          targetQuat: initialQuat.clone(),
          start: performance.now(),
          dur: 800,
        };
      });
    }

    function handlePick(e) {
      const rect = canvasEl.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const targets = markerMeshes.map((m) => m.glow);
      const hits = raycaster.intersectObjects(targets, false);
      if (!hits.length) return;
      const hit = markerMeshes.find((m) => m.glow === hits[0].object);
      if (hit) focusQuake(hit.feature);
    }

    function focusQuake(feature) {
      state.focusedId = feature.id;
      const [lon, lat] = feature.geometry.coordinates;
      const normal = latLonToVec3(lat, lon, 1).normalize();
      const targetQuat = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, 1));
      focusAnim = {
        startQuat: earthGroup.quaternion.clone(),
        targetQuat,
        start: performance.now(),
        dur: 900,
      };
      autoRotateEnabled = false;
      Sidebar.setFocused(feature.id);
    }

    function focusById(id) {
      const f = state.features.find((x) => x.id === id);
      if (f) focusQuake(f);
    }

    /* ---------------- render loop ---------------- */

    function animate() {
      requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.06);
      const now = performance.now();

      cloudsMesh.rotation.y += dt * 0.0075;

      markerMeshes.forEach((m) => {
        const t = now / 1000;
        const pulse = 0.86 + Math.sin(t * 2.1 + m.phase) * 0.16;
        const isFocused = state.focusedId === m.id;
        const focusBoost = isFocused ? 1.35 : 1;
        m.glow.scale.set(m.baseGlowScale * pulse * focusBoost, m.baseGlowScale * pulse * focusBoost, 1);
        if (isFocused) {
          m.core.material.opacity = 1;
        }
        if (m.ring) {
          const period = 2200;
          const rt = ((now - m.ringStart) % period) / period;
          const s = m.ring.userData.base * (1 + rt * 3.1);
          m.ring.scale.set(s, s, 1);
          m.ring.material.opacity = (1 - rt) * 0.85;
        }
      });

      if (focusAnim) {
        const t = clamp((now - focusAnim.start) / focusAnim.dur, 0, 1);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        earthGroup.quaternion.copy(focusAnim.startQuat).slerp(focusAnim.targetQuat, eased);
        if (t >= 1) focusAnim = null;
      } else if (autoRotateEnabled && !dragging && !hovering) {
        earthGroup.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.052)
        );
      } else if (!dragging && (Math.abs(velYaw) > 0.00005 || Math.abs(velPitch) > 0.00005)) {
        earthGroup.quaternion
          .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), velYaw))
          .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), velPitch));
        velYaw *= 0.9;
        velPitch *= 0.9;
      }

      camera.position.z += (zoomDist - camera.position.z) * 0.14;
      renderer.render(scene, camera);
    }

    return { init, refresh, focusById };
  })();

  /* ---------------------------------------------------------------------
     Sidebar module — stats, list, filters
     --------------------------------------------------------------------- */

  const Sidebar = (() => {
    function render() {
      renderStats();
      renderList();
    }

    function filteredSorted() {
      return state.features
        .filter((f) => (f.properties.mag || 0) >= state.minMag)
        .slice()
        .sort((a, b) => b.properties.time - a.properties.time);
    }

    function renderStats() {
      const feats = state.features.filter((f) => (f.properties.mag || 0) >= state.minMag);
      animateNumber($("#statCount"), feats.length);

      if (feats.length === 0) {
        $("#statMax").textContent = "—";
        $("#statMaxPlace").textContent = "";
        $("#statDepth").textContent = "—";
        animateNumber($("#statMajor"), 0);
        return;
      }

      let strongest = feats[0];
      let depthSum = 0, majorCount = 0;
      for (const f of feats) {
        if ((f.properties.mag || 0) > (strongest.properties.mag || 0)) strongest = f;
        depthSum += f.geometry.coordinates[2] || 0;
        if ((f.properties.mag || 0) >= 5) majorCount++;
      }

      const strongMag = strongest.properties.mag || 0;
      animateNumber($("#statMax"), strongMag, { decimals: 1, prefix: "M" });
      $("#statMax").style.color = magColor(strongMag);
      $("#statMaxPlace").textContent = strongest.properties.place || "—";
      animateNumber($("#statDepth"), depthSum / feats.length, { decimals: 0, suffix: " km" });
      animateNumber($("#statMajor"), majorCount);
    }

    function renderList() {
      const list = $("#quakeList");
      const feats = filteredSorted();
      $("#listCount").textContent = feats.length ? `(${feats.length})` : "";

      if (feats.length === 0) {
        list.innerHTML = `<div class="empty-note">No events at or above M${state.minMag.toFixed(1)} in this window.</div>`;
        return;
      }

      const existingIds = new Set(
        Array.from(list.querySelectorAll(".q-item")).map((el) => el.dataset.id)
      );

      list.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const f of feats.slice(0, 200)) {
        const p = f.properties;
        const el = document.createElement("div");
        const isFirstPaint = existingIds.size === 0;
        el.className = "q-item" + (state.focusedId === f.id ? " is-focused" : "");
        el.dataset.id = f.id;
        const isNew = Date.now() - p.time < NEW_QUAKE_WINDOW_MS;
        el.innerHTML = `
          <div class="q-mag" style="background:${magColor(p.mag || 0)}">${(p.mag || 0).toFixed(1)}</div>
          <div class="q-body">
            <div class="q-place">${escapeHtml(p.place || "Unknown location")}</div>
            <div class="q-meta">
              <span>${timeAgo(p.time)}</span>
              <span>${fmtDepth(f.geometry.coordinates[2])}</span>
              ${isNew ? '<span class="new-badge">● NEW</span>' : ""}
            </div>
          </div>`;
        el.addEventListener("click", () => Globe.focusById(f.id));
        if (!existingIds.has(f.id) && !isFirstPaint) {
          el.classList.add("q-entering");
          requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("q-entering")));
        }
        frag.appendChild(el);
      }
      list.appendChild(frag);
    }

    function setFocused(id) {
      state.focusedId = id;
      document.querySelectorAll(".q-item").forEach((el) => {
        el.classList.toggle("is-focused", el.dataset.id === id);
      });
      if (id) {
        const el = document.querySelector(`.q-item[data-id="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    return { render, setFocused };
  })();

  /* ---------------------------------------------------------------------
     Seismograph ticker (canvas)
     --------------------------------------------------------------------- */

  const Ticker = (() => {
    let canvas, ctx, W, H, dpr;
    let buffer = [];
    const BUFFER_LEN = 260;
    let pending = null; // {value, ticksLeft}
    let quakeQueue = [];
    let quakeQueueIdx = 0;
    let msSinceLastSpike = 0;
    let nextSpikeIn = 1200;

    function init() {
      canvas = $("#tickerCanvas");
      ctx = canvas.getContext("2d");
      buffer = new Array(BUFFER_LEN).fill(0).map(() => (Math.random() - 0.5) * 0.06);
      resize();
      window.addEventListener("resize", resize);
      requestAnimationFrame(loop);
      setInterval(tickBuffer, 45);
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setQuakes(feats) {
      quakeQueue = feats.slice().sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0)).slice(0, 40);
      quakeQueueIdx = 0;
    }

    function ambient() {
      return (Math.random() - 0.5) * 0.07;
    }

    function tickBuffer() {
      buffer.shift();

      let val = ambient();
      if (pending && pending.ticksLeft > 0) {
        const decay = pending.ticksLeft / pending.totalTicks;
        val += pending.value * decay * decay;
        pending.ticksLeft--;
      }
      buffer.push(val);

      msSinceLastSpike += 45;
      if (msSinceLastSpike > nextSpikeIn && quakeQueue.length) {
        const q = quakeQueue[quakeQueueIdx % quakeQueue.length];
        quakeQueueIdx++;
        const mag = q.properties.mag || 2.5;
        pending = { value: clamp(mag / 7.5, 0.15, 1) * (0.8 + Math.random() * 0.4), ticksLeft: 26, totalTicks: 26 };
        msSinceLastSpike = 0;
        nextSpikeIn = 900 + Math.random() * 2200;
      }
    }

    function loop() {
      draw();
      requestAnimationFrame(loop);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      ctx.strokeStyle = "rgba(63,216,196,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      const midY = H / 2;
      const ampScale = H * 0.42;
      const step = W / (BUFFER_LEN - 1);

      ctx.beginPath();
      ctx.strokeStyle = "#ffb238";
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(255,178,56,0.55)";
      ctx.shadowBlur = 6;

      for (let i = 0; i < BUFFER_LEN; i++) {
        const x = i * step;
        const y = midY - buffer[i] * ampScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      const lastX = (BUFFER_LEN - 1) * step;
      const lastY = midY - buffer[BUFFER_LEN - 1] * ampScale;
      ctx.beginPath();
      ctx.fillStyle = "#ffd889";
      ctx.shadowColor = "rgba(255,178,56,0.9)";
      ctx.shadowBlur = 8;
      ctx.arc(lastX, lastY, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    return { init, setQuakes };
  })();

  /* ---------------------------------------------------------------------
     Clock
     --------------------------------------------------------------------- */

  function startClock() {
    function tick() {
      const now = new Date();
      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mm = String(now.getUTCMinutes()).padStart(2, "0");
      const ss = String(now.getUTCSeconds()).padStart(2, "0");
      $("#clockUtc").textContent = `${hh}:${mm}:${ss}`;
      if (state.lastSync) {
        $("#syncAgo").textContent = timeAgo(state.lastSync.getTime());
      }
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------------------------------------------------------------
     Status pill
     --------------------------------------------------------------------- */

  function setStatus(mode, text) {
    const pill = $("#statusPill");
    pill.classList.remove("is-live", "is-cached", "is-error");
    pill.classList.add(`is-${mode}`);
    $("#statusText").textContent = text;

    const liveChip = $("#liveChip");
    if (liveChip) liveChip.classList.toggle("is-dim", mode !== "live");
  }

  function checkAlerts() {
    const bar = $("#alertBar");
    const tsunamiQuakes = state.features.filter((f) => f.properties.tsunami === 1);
    if (tsunamiQuakes.length) {
      const strongest = tsunamiQuakes.slice().sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0))[0];
      $("#alertText").textContent =
        `TSUNAMI ADVISORY FLAG — M${(strongest.properties.mag || 0).toFixed(1)} ${strongest.properties.place || ""} · via USGS`;
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  }

  /* ---------------------------------------------------------------------
     Feed / filter wiring
     --------------------------------------------------------------------- */

  function wireControls() {
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.feedKey = chip.dataset.feed;
        $("#snapshotWindow").textContent = `— ${FEEDS[state.feedKey].label}`;
        refreshData();
      });
    });

    const magEl = $("#magFilter");
    magEl.addEventListener("input", () => {
      state.minMag = parseFloat(magEl.value);
      $("#magFilterVal").textContent = state.minMag.toFixed(1);
      Sidebar.render();
      Globe.refresh();
    });
  }

  /* ---------------------------------------------------------------------
     Main refresh cycle
     --------------------------------------------------------------------- */

  async function refreshData() {
    setStatus("cached", "Syncing…");
    const data = await loadFeed(state.feedKey);
    if (data && Array.isArray(data.features)) {
      state.features = data.features;
      state.lastSync = new Date();
      if (state.isLive) {
        setStatus("live", "Live · USGS");
      } else {
        setStatus("cached", "Cached snapshot");
      }
    } else {
      setStatus("error", "Feed unavailable");
    }
    Sidebar.render();
    Globe.refresh();
    Ticker.setQuakes(state.features);
    checkAlerts();
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */

  async function boot() {
    startClock();
    wireControls();
    Globe.init();
    Ticker.init();

    await refreshData();
    setInterval(refreshData, REFRESH_MS);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
