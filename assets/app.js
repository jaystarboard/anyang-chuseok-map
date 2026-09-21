(() => {
  "use strict";

  const CAT_COLOR = {
    "응급실": "var(--er)",
    "병원": "var(--clinic)", "의원": "var(--clinic)", "치과": "var(--clinic)", "한방": "var(--clinic)",
    "약국": "var(--pharm)",
  };
  const CAT_ORDER = ["응급실", "병원", "의원", "치과", "한방", "약국"];
  const ALWAYS_OPEN = "응급실운영";

  const state = {
    meta: null,
    all: [],
    dayIndex: 0,
    cats: new Set(CAT_ORDER),
    query: "",
    openNow: false,
    selectedId: null,
    origin: null,          // [lon, lat] of the user, when granted
    visible: [],
  };

  const $ = (sel) => document.querySelector(sel);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (cat) => cssVar(CAT_COLOR[cat].replace(/^var\(|\)$/g, ""));

  /* ---------------- time helpers ---------------- */

  const localISO = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** "09:00~16:00" -> {from, to} in minutes; `to` may exceed 1440 when it crosses midnight. */
  function parseRange(text) {
    const m = /^(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})$/.exec((text || "").trim());
    if (!m) return null;
    const from = +m[1] * 60 + +m[2];
    let to = +m[3] * 60 + +m[4];
    if (to <= from) to += 1440;
    return { from, to };
  }

  /**
   * 선택한 날짜 `dayIdx` 의 `minutes` 시점에 영업중인지.
   * 전날 영업시간이 자정을 넘겨 이어지는 경우(예: 10:00~01:00)도 포함한다.
   */
  function isOpenAt(fac, dayIdx, minutes) {
    const today = fac.hours[dayIdx];
    if (today === ALWAYS_OPEN) return true;
    const r = parseRange(today);
    if (r && minutes >= r.from && minutes < r.to) return true;

    const prev = dayIdx > 0 ? fac.hours[dayIdx - 1] : null;
    if (prev && prev !== ALWAYS_OPEN) {
      const pr = parseRange(prev);
      if (pr && pr.to > 1440 && minutes + 1440 < pr.to) return true;
    }
    return false;
  }

  const opensOn = (fac, dayIdx) => Boolean(fac.hours[dayIdx]);

  /* ---------------- geo helpers ---------------- */

  function distanceMeters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const la1 = a[1] * rad, la2 = b[1] * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
  const shortAddr = (addr) => addr.replace(/^경기도\s*안양시\s*동안구\s*/, "").replace(/\s*\([^)]*\)\s*$/, "");

  /** 같은 건물에 여러 기관이 있으면 겹쳐서 클릭할 수 없으므로 작은 원으로 흩는다. */
  function spread(list) {
    const buckets = new Map();
    for (const f of list) {
      const key = `${f.lat.toFixed(5)},${f.lon.toFixed(5)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(f);
    }
    for (const group of buckets.values()) {
      if (group.length < 2) {
        group[0].mapLon = group[0].lon; group[0].mapLat = group[0].lat;
        continue;
      }
      const radius = 9 + group.length * 1.2;                       // metres
      group.forEach((f, i) => {
        const a = (2 * Math.PI * i) / group.length;
        f.mapLat = f.lat + (radius * Math.cos(a)) / 111320;
        f.mapLon = f.lon + (radius * Math.sin(a)) / (111320 * Math.cos(f.lat * Math.PI / 180));
      });
    }
  }

  /* ---------------- map ---------------- */

  let map, vectorSource, popupOverlay, meFeature, meLayer;

  function buildMap() {
    vectorSource = new ol.source.Vector();

    const vectorLayer = new ol.layer.Vector({
      source: vectorSource,
      style: featureStyle,
      declutter: false,
    });

    meLayer = new ol.layer.Vector({ source: new ol.source.Vector(), style: meStyle });

    map = new ol.Map({
      target: "map",
      layers: [
        new ol.layer.Tile({
          source: new ol.source.OSM({
            attributions: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자',
          }),
        }),
        vectorLayer,
        meLayer,
      ],
      view: new ol.View({
        center: ol.proj.fromLonLat([126.9565, 37.3905]),
        zoom: 13.2,
        minZoom: 11,
        maxZoom: 19,
      }),
      controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: true } }),
    });

    // 데이터 fetch 뒤에 지도를 만들기 때문에 레이아웃이 아직 확정되지 않은 순간이 있다.
    // 크기 0 으로 초기화되면 타일 레이어가 빈 채로 굳고 updateSize() 만으로는 다시 그리지 않으므로,
    // 크기가 잡히는 순간 명시적으로 renderSync() 를 한 번 돌려 준다.
    let hadSize = false;
    new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      map.updateSize();
      if (!hadSize && width > 0 && height > 0) { hadSize = true; map.renderSync(); }
    }).observe(document.getElementById("map"));

    popupOverlay = new ol.Overlay({
      element: $("#popup"),
      autoPan: { animation: { duration: 220 }, margin: 20 },
      stopEvent: true,
    });
    map.addOverlay(popupOverlay);

    map.on("click", (evt) => {
      const hit = map.forEachFeatureAtPixel(evt.pixel, (f) => f, { hitTolerance: 6 });
      if (hit && hit.get("facility")) select(hit.get("facility").id, { fly: false });
      else select(null);
    });
    map.on("pointermove", (evt) => {
      const hit = map.hasFeatureAtPixel(evt.pixel, { hitTolerance: 6 });
      map.getTargetElement().style.cursor = hit ? "pointer" : "";
    });
  }

  function featureStyle(feature) {
    const f = feature.get("facility");
    const selected = f.id === state.selectedId;
    const color = colorOf(f.cat);
    const r = f.cat === "응급실" ? 9 : 7;
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: selected ? r + 3 : r,
        fill: new ol.style.Fill({ color }),
        stroke: new ol.style.Stroke({
          color: selected ? cssVar("--text") : cssVar("--surface"),
          width: selected ? 3 : 2,
        }),
      }),
      zIndex: selected ? 100 : f.cat === "응급실" ? 50 : 10,
    });
  }

  function meStyle() {
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 7,
        fill: new ol.style.Fill({ color: cssVar("--accent") }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
      }),
      zIndex: 200,
    });
  }

  function syncMap() {
    vectorSource.clear();
    vectorSource.addFeatures(state.visible.map((f) => {
      const feat = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([f.mapLon, f.mapLat])) });
      feat.set("facility", f);
      feat.setId(f.id);
      return feat;
    }));
  }

  /* ---------------- rendering ---------------- */

  function renderDays() {
    const today = localISO(new Date());
    $("#daybar").innerHTML = state.meta.days.map((d, i) => `
      <button type="button" class="day" role="tab" data-i="${i}" aria-selected="${i === state.dayIndex}">
        <strong>${d.label}</strong>
        <span>${d.dow}${d.holiday ? ` · ${d.holiday}` : ""}${d.date === today ? " · 오늘" : ""}</span>
      </button>`).join("");
    $("#daybar").querySelectorAll(".day").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.dayIndex = +btn.dataset.i;
        renderDays(); renderChips(); syncOpenNowAvailability(); apply();
      });
    });
  }

  function renderChips() {
    const counts = new Map();
    for (const f of state.all) if (opensOn(f, state.dayIndex)) counts.set(f.cat, (counts.get(f.cat) || 0) + 1);
    $("#cat-chips").innerHTML = CAT_ORDER.filter((c) => counts.get(c))
      .map((c) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${state.cats.has(c)}"
        style="--c:${CAT_COLOR[c]}"><i style="background:${CAT_COLOR[c]}"></i>${c}<b>${counts.get(c)}</b></button>`)
      .join("");
    $("#cat-chips").querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const c = btn.dataset.cat;
        if (state.cats.has(c)) state.cats.delete(c); else state.cats.add(c);
        if (state.cats.size === 0) CAT_ORDER.forEach((x) => state.cats.add(x));
        renderChips(); apply();
      });
    });
  }

  function renderLegend() {
    $("#legend").innerHTML = [["응급실", "--er"], ["병·의원", "--clinic"], ["약국", "--pharm"]]
      .map(([label, v]) => `<span><i style="background:var(${v})"></i>${label}</span>`).join("");
  }

  function hoursLabel(fac, dayIdx) {
    const h = fac.hours[dayIdx];
    if (!h) return "휴무";
    if (h === ALWAYS_OPEN) return "24시간 응급실";
    return h;
  }

  function renderList() {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const isToday = state.meta.days[state.dayIndex].date === localISO(new Date());

    $("#result-count").textContent =
      `${state.meta.days[state.dayIndex].label} · ${state.visible.length}곳` +
      (state.origin ? " · 가까운 순" : "");

    if (!state.visible.length) {
      $("#list").innerHTML = `<li class="empty">조건에 맞는 곳이 없습니다.<br>필터를 넓혀 보세요.</li>`;
      return;
    }

    $("#list").innerHTML = state.visible.map((f) => {
      const open = isToday && isOpenAt(f, state.dayIndex, nowMin);
      const badge = f.cat === "응급실"
        ? `<span class="badge badge--er">24시간</span>`
        : isToday ? `<span class="badge badge--${open ? "open" : "closed"}">${open ? "영업중" : "영업전·종료"}</span>` : "";
      const dist = state.origin ? `<span class="item__dist">${fmtDist(f._dist)}</span>` : "";
      return `<li><button type="button" data-id="${f.id}" aria-current="${f.id === state.selectedId}">
        <span class="item__top"><span class="item__name">${esc(f.name)}</span>
        <span class="item__kind">${esc(f.kind)}</span></span>
        <span class="item__addr">${esc(shortAddr(f.addr))}</span>
        <span class="item__meta"><span class="item__hours">${hoursLabel(f, state.dayIndex)}</span>${badge}${dist}</span>
      </button></li>`;
    }).join("");

    $("#list").querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => select(+btn.dataset.id, { fly: true }));
    });
  }

  function renderPopup(fac) {
    const popup = $("#popup");
    if (!fac) { popup.hidden = true; popupOverlay.setPosition(undefined); return; }

    const rows = state.meta.days.map((d, i) => {
      const h = fac.hours[i];
      return `<tr data-sel="${i === state.dayIndex}"><th>${d.label}(${d.dow})</th>
        <td class="${h ? "" : "off"}">${h ? (h === ALWAYS_OPEN ? "24시간" : h) : "휴무"}</td></tr>`;
    }).join("");

    const kakao = `https://map.kakao.com/?q=${encodeURIComponent(`${fac.name} ${shortAddr(fac.addr)}`)}`;
    const approx = fac.acc === "approx"
      ? `<span class="popup__approx" title="${esc(fac.accSrc)} — 정확한 위치는 주소·전화로 확인하세요">위치 근사</span>` : "";

    popup.innerHTML = `
      <button type="button" class="popup__close" aria-label="닫기">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <h3>${esc(fac.name)}</h3>
      <div class="popup__sub"><i style="width:8px;height:8px;border-radius:50%;background:${CAT_COLOR[fac.cat]};display:inline-block"></i>${esc(fac.kind)}</div>
      <p class="popup__addr">${esc(shortAddr(fac.addr))}${approx}</p>
      <table class="sched"><tbody>${rows}</tbody></table>
      <div class="popup__acts">
        ${fac.tel ? `<a class="primary" href="tel:${fac.tel.replace(/[^0-9+]/g, "")}">전화 ${esc(fac.tel)}</a>` : ""}
        <a href="${kakao}" target="_blank" rel="noopener">카카오맵</a>
      </div>`;
    popup.hidden = false;
    popup.querySelector(".popup__close").addEventListener("click", () => select(null));
    popupOverlay.setPosition(ol.proj.fromLonLat([fac.mapLon, fac.mapLat]));
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- interaction ---------------- */

  function select(id, opts = {}) {
    state.selectedId = id;
    const fac = state.visible.find((f) => f.id === id) || null;
    vectorSource.changed();
    $("#list").querySelectorAll("button[data-id]").forEach((b) => {
      const on = +b.dataset.id === id;
      b.setAttribute("aria-current", on);
      if (on && opts.fly) b.scrollIntoView({ block: "nearest" });
    });

    if (!fac || !opts.fly) { renderPopup(fac); return; }

    // 팝업을 먼저 띄우면 뒤이은 뷰 이동이 오버레이의 autoPan 을 덮어써 하단이 잘린다.
    // 이동을 한 번의 animate 로 합치고, 끝난 뒤에 위치를 잡아 autoPan 이 마지막에 오게 한다.
    const view = map.getView();
    view.cancelAnimations();
    view.animate({
      center: ol.proj.fromLonLat([fac.mapLon, fac.mapLat]),
      zoom: Math.max(view.getZoom(), 16),
      duration: 320,
    }, () => renderPopup(fac));
  }

  function apply() {
    const q = state.query.trim().toLowerCase();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const isToday = state.meta.days[state.dayIndex].date === localISO(new Date());

    let list = state.all.filter((f) =>
      opensOn(f, state.dayIndex) &&
      state.cats.has(f.cat) &&
      (!q || f.name.toLowerCase().includes(q) || f.addr.toLowerCase().includes(q)) &&
      (!(state.openNow && isToday) || isOpenAt(f, state.dayIndex, nowMin))
    );

    if (state.origin) {
      for (const f of list) f._dist = distanceMeters(state.origin, [f.lon, f.lat]);
      list.sort((a, b) => a._dist - b._dist);
    } else {
      list.sort((a, b) => (a.cat === "응급실" ? -1 : b.cat === "응급실" ? 1 : 0) || a.name.localeCompare(b.name, "ko"));
    }

    state.visible = list;
    spread(list);
    syncMap();
    renderList();

    if (state.selectedId) {
      // 날짜를 바꾸면 열린 팝업의 운영시간 표도 새 날짜 기준으로 다시 그려야 한다.
      const still = list.find((f) => f.id === state.selectedId);
      if (still) renderPopup(still); else select(null);
    }
  }

  function syncOpenNowAvailability() {
    const isToday = state.meta.days[state.dayIndex].date === localISO(new Date());
    const btn = $("#btn-opennow");
    btn.disabled = !isToday;
    btn.title = isToday ? "현재 시각에 영업중인 곳만 보기" : "오늘(연휴 중) 날짜를 선택했을 때만 사용할 수 있습니다";
    if (!isToday && state.openNow) { state.openNow = false; btn.setAttribute("aria-pressed", "false"); }
  }

  function pickDefaultDay() {
    const today = localISO(new Date());
    const days = state.meta.days;
    const idx = days.findIndex((d) => d.date === today);
    if (idx >= 0) { state.dayIndex = idx; return; }
    const notice = $("#today-notice");
    if (today < days[0].date) {
      state.dayIndex = 0;
      notice.textContent = `오늘(${today.slice(5).replace("-", ".")})은 연휴 시작 전입니다. 연휴 첫날 ${days[0].label} 기준으로 표시합니다.`;
    } else {
      state.dayIndex = days.length - 1;
      notice.textContent = `연휴(${days[0].label}~${days.at(-1).label})가 지났습니다. 마지막 날 기준 정보이며, 현재 진료 여부는 전화로 확인하세요.`;
    }
    notice.hidden = false;
  }

  function locate() {
    const btn = $("#btn-locate");
    if (state.origin) {                       // 이미 켜져 있으면 해제
      state.origin = null; meLayer.getSource().clear(); btn.classList.remove("on"); apply(); return;
    }
    if (!navigator.geolocation) { btn.disabled = true; btn.textContent = "위치 미지원"; return; }
    btn.textContent = "찾는 중…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.origin = [pos.coords.longitude, pos.coords.latitude];
        meLayer.getSource().clear();
        meLayer.getSource().addFeature(new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat(state.origin)),
        }));
        btn.textContent = "내 위치"; btn.classList.add("on");
        map.getView().animate({ center: ol.proj.fromLonLat(state.origin), zoom: 15, duration: 400 });
        apply();
      },
      () => { btn.textContent = "내 위치"; alert("위치 정보를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요."); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  function renderInfo() {
    const m = state.meta;
    $("#info-body").innerHTML = `
      <p><strong>${esc(m.disclaimer)}</strong></p>
      <p>출처: ${esc(m.source)} (${esc(m.sourceAsOf)} 기준)</p>
      <ul>${m.contacts.map((c) => c.url
        ? `<li>${esc(c.label)} — <a href="${c.url}" target="_blank" rel="noopener">${c.url.replace(/^https?:\/\//, "")}</a></li>`
        : `<li>${esc(c.label)} — <a href="tel:${c.tel.replace(/[^0-9]/g, "")}">${esc(c.tel)}</a></li>`).join("")}</ul>
      <p>지도 위 마커 위치는 도로명주소를 OpenStreetMap 주소 데이터에 대조해 계산했습니다.
      일부 항목은 <em>위치 근사</em>로 표시되며, 이 경우 팝업의 주소와 전화번호를 기준으로 확인하세요.</p>`;
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    let doc;
    try {
      const res = await fetch("data/facilities.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (err) {
      $("#list").innerHTML = `<li class="empty">데이터를 불러오지 못했습니다.<br>${esc(err.message)}</li>`;
      return;
    }

    state.meta = doc.meta;
    state.all = doc.facilities;
    document.title = `${doc.meta.title}`;

    pickDefaultDay();
    buildMap();
    renderDays();
    renderChips();
    renderLegend();
    renderInfo();
    syncOpenNowAvailability();
    apply();

    let t;
    $("#search").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => { state.query = e.target.value; apply(); }, 140);
    });
    $("#btn-opennow").addEventListener("click", (e) => {
      state.openNow = !state.openNow;
      e.currentTarget.setAttribute("aria-pressed", String(state.openNow));
      apply();
    });
    $("#btn-locate").addEventListener("click", locate);
    $("#btn-info").addEventListener("click", () => $("#info-dialog").showModal());
    $("#btn-sheet").addEventListener("click", (e) => {
      const panel = document.querySelector(".panel");
      panel.classList.toggle("collapsed");
      e.currentTarget.setAttribute("aria-expanded", String(!panel.classList.contains("collapsed")));
      setTimeout(() => map.updateSize(), 220);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") select(null); });
    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => { vectorSource.changed(); meLayer.getSource().changed(); });
  }

  boot();
})();
