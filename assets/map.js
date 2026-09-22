window.MapEngine = (() => {
  "use strict";

  const OL_JS = "https://cdn.jsdelivr.net/npm/ol@10.3.1/dist/ol.js";
  const OL_CSS = "https://cdn.jsdelivr.net/npm/ol@10.3.1/ol.css";
  const KAKAO_LOAD_TIMEOUT = 5000;

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error(`load fail: ${src}`));
    document.head.appendChild(s);
  });

  function kakaoReady() {
    return new Promise((resolve) => {
      if (!window.kakao || !window.kakao.maps || typeof kakao.maps.load !== "function") {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => resolve(false), KAKAO_LOAD_TIMEOUT);
      try {
        kakao.maps.load(() => {
          clearTimeout(timer);
          resolve(Boolean(kakao.maps.Map && kakao.maps.CustomOverlay));
        });
      } catch (_) {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  function kakaoAdapter(el, opts) {

    const toLevel = (zoom) => Math.max(1, Math.min(14, Math.round(20 - zoom)));
    const toZoom = (level) => 20 - level;

    const map = new kakao.maps.Map(el, {
      center: new kakao.maps.LatLng(opts.center[0], opts.center[1]),
      level: toLevel(opts.zoom),
    });
    const ll = (p) => new kakao.maps.LatLng(p[0], p[1]);

    return {
      name: "kakao",
      label: "카카오맵",
      raw: map,
      on(evt, cb) {
        const name = { click: "click", idle: "idle", userpan: "dragend" }[evt];
        if (name) kakao.maps.event.addListener(map, name, cb);
      },
      relayout() { map.relayout(); },
      getZoom() { return toZoom(map.getLevel()); },
      setZoom(z) { map.setLevel(toLevel(z)); },
      zoomAround(pos, z) { map.setLevel(toLevel(z), { anchor: ll(pos), animate: true }); },
      flyTo(pos, z) { map.setLevel(toLevel(z)); map.panTo(ll(pos)); },
      panTo(pos) { map.panTo(ll(pos)); },
      setCenter(pos) { map.setCenter(ll(pos)); },
      getCenter() { const c = map.getCenter(); return [c.getLat(), c.getLng()]; },
      destroy() { el.innerHTML = ""; },
      fitBounds(points, pad = 26, maxZoom) {
        if (!points.length) return;
        const [t, r, bt, l] = Array.isArray(pad) ? pad : [pad, pad, pad, pad];
        const b = new kakao.maps.LatLngBounds();
        points.forEach((p) => b.extend(ll(p)));
        map.setBounds(b, t, r, bt, l);
        if (maxZoom != null && toZoom(map.getLevel()) > maxZoom) map.setLevel(toLevel(maxZoom));
      },
      addOverlay(element, pos, o = {}) {
        const ov = new kakao.maps.CustomOverlay({
          position: ll(pos), content: element,
          yAnchor: o.yAnchor ?? 1, xAnchor: o.xAnchor ?? 0.5,
          clickable: o.clickable ?? true, zIndex: o.zIndex ?? 1,
        });
        ov.setMap(map);
        return ov;
      },
      removeOverlay(h) { if (h) h.setMap(null); },
      moveOverlay(h, pos) { if (h) h.setPosition(ll(pos)); },
      setOverlayZ(h, z) { if (h) h.setZIndex(z); },
      project(pos) {
        const p = map.getProjection().containerPointFromCoords(ll(pos));
        return { x: p.x, y: p.y };
      },
      unproject(pt) {
        const c = map.getProjection().coordsFromContainerPoint(new kakao.maps.Point(pt.x, pt.y));
        return [c.getLat(), c.getLng()];
      },
    };
  }

  function olAdapter(el, opts) {
    const view = new ol.View({
      center: ol.proj.fromLonLat([opts.center[1], opts.center[0]]),
      zoom: opts.zoom, minZoom: 9, maxZoom: 19,
    });
    const map = new ol.Map({
      target: el,
      layers: [new ol.layer.Tile({
        source: new ol.source.OSM({
          attributions: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자',
        }),
      })],
      view,
      controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: true } }),
    });
    const coord = (p) => ol.proj.fromLonLat([p[1], p[0]]);

    return {
      name: "osm",
      label: "OpenStreetMap",
      raw: map,
      on(evt, cb) {
        if (evt === "click") {
          map.on("click", (e) => { if (!e.dragging) cb(); });
        } else if (evt === "idle") {
          map.on("moveend", cb);
        } else if (evt === "userpan") {
          map.on("pointerdrag", cb);
        }
      },
      relayout() { map.updateSize(); },
      getZoom() { return view.getZoom(); },
      setZoom(z) { view.animate({ zoom: z, duration: 220 }); },
      zoomAround(pos, z) {
        const a = coord(pos), c0 = view.getCenter();
        const k = view.getResolutionForZoom(z) / view.getResolution();
        view.animate({ center: [a[0] + (c0[0] - a[0]) * k, a[1] + (c0[1] - a[1]) * k], zoom: z, duration: 260 });
      },
      flyTo(pos, z) { view.animate({ center: coord(pos), zoom: z, duration: 260 }); },
      panTo(pos) { view.animate({ center: coord(pos), duration: 260 }); },
      setCenter(pos) { view.setCenter(coord(pos)); },
      getCenter() { const c = ol.proj.toLonLat(view.getCenter()); return [c[1], c[0]]; },
      destroy() { map.setTarget(null); el.innerHTML = ""; },
      fitBounds(points, pad = 26, maxZoom = 17) {
        if (!points.length) return;
        const p4 = Array.isArray(pad) ? pad : [pad, pad, pad, pad];
        const lons = points.map((p) => p[1]), lats = points.map((p) => p[0]);
        view.fit(ol.proj.transformExtent(
          [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
          "EPSG:4326", "EPSG:3857"), { size: map.getSize(), padding: p4, maxZoom, duration: 260 });
      },
      addOverlay(element, pos, o = {}) {

        const v = (o.yAnchor ?? 1) >= 1 ? "bottom" : (o.yAnchor ?? 1) <= 0 ? "top" : "center";
        const h = (o.xAnchor ?? 0.5) >= 1 ? "right" : (o.xAnchor ?? 0.5) <= 0 ? "left" : "center";
        const ov = new ol.Overlay({
          element, position: coord(pos), positioning: `${v}-${h}`,
          stopEvent: o.clickable ?? true, className: "ol-overlay-plain",
        });
        if (o.zIndex) element.style.zIndex = String(o.zIndex);
        map.addOverlay(ov);
        return ov;
      },
      removeOverlay(h) { if (h) map.removeOverlay(h); },
      moveOverlay(h, pos) { if (h) h.setPosition(coord(pos)); },
      setOverlayZ(h, z) { if (h && h.getElement()) h.getElement().style.zIndex = String(z); },
      project(pos) {
        const p = map.getPixelFromCoordinate(coord(pos));
        return p ? { x: p[0], y: p[1] } : { x: -1e6, y: -1e6 };
      },
      unproject(pt) {
        const c = ol.proj.toLonLat(map.getCoordinateFromPixel([pt.x, pt.y]));
        return [c[1], c[0]];
      },
    };
  }

  async function create(el, opts) {
    if (opts.force !== "osm" && await kakaoReady()) {
      try {
        return kakaoAdapter(el, opts);
      } catch (err) {
        console.warn("카카오 지도 생성 실패, OSM 으로 전환합니다.", err);
      }
    }
    if (!window.ol) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = OL_CSS;
      document.head.appendChild(link);
      await loadScript(OL_JS);
    }
    return olAdapter(el, opts);
  }

  return { create };
})();
