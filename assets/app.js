/**
 * 추석 연휴 문여는 병원·약국 — 안양시 전체
 *
 * 화면은 지도가 거의 전부를 차지하고, 검색·필터·버튼은 지도 위 오버레이로 띄운다.
 * 좌표는 빌드 시점에 카카오 지오코딩으로 구워 두었으므로 런타임 지오코딩은 하지 않는다.
 */
(() => {
  "use strict";

  const ALWAYS_OPEN = "응급실운영";

  /** 분류 -> 마커 글자·색. 색만으로는 구분이 어려워 글자를 함께 쓴다. */
  const CATS = {
    "응급실":   { ch: "E", color: "#b52b43", set: "anyang" },
    "병원":     { ch: "H", color: "#235cb4", set: "anyang" },
    "의원":     { ch: "＋", color: "#177c8e", set: "anyang" },
    "치과":     { ch: "치", color: "#af4a83", set: "anyang" },
    "한방":     { ch: "한", color: "#6c50a3", set: "anyang" },
    "약국":     { ch: "약", color: "#197344", set: "anyang" },
    "권역센터": { ch: "권", color: "#7c1327", set: "er" },
    "지역센터": { ch: "지", color: "#c0453f", set: "er" },
    "지역기관": { ch: "기", color: "#d4786a", set: "er" },
    "달빛":     { ch: "달", color: "#b9701c", set: "moon" },
  };
  const ORDER = Object.keys(CATS);
  const ANYANG_CATS = ORDER.filter((c) => CATS[c].set === "anyang");
  const PRIORITY = new Map(ORDER.map((c, i) => [c, i]));   // 묶인 마커의 대표 분류 선정용

  const state = {
    meta: null,
    all: [],                 // 세 데이터셋을 하나로 합친 배열
    dayIndex: 0,
    cats: new Set(ANYANG_CATS),
    query: "",
    origin: null,            // [lat, lon] — 내 위치
    visible: [],
    groups: [],
    selected: null,          // 선택된 그룹
    sheetMode: null,         // 'list' | 'detail'
    chipsOpen: false,        // 넘친 필터 펼침 여부
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ─────────── 시간 ─────────── */

  const localISO = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** 해당 날짜에 여는지. 경기 레이어는 날짜와 무관하게 항상 대상이다. */
  function opensOn(f, dayIndex) {
    if (f.set !== "anyang") return true;
    return Boolean(f.hours[dayIndex]);
  }

  function hoursText(f, dayIndex) {
    if (f.set === "er") return "24시간";
    if (f.set === "moon") return (f.holiday || f.weekday || "").replace(/^\([^)]*\)\s*/, "");
    const h = f.hours[dayIndex];
    if (!h) return "휴무";
    return h === ALWAYS_OPEN ? "24시간" : h;
  }

  /* ─────────── 거리 ─────────── */

  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);

  const shortAddr = (addr) =>
    String(addr || "").replace(/^(?:경기도\s*)?안양시\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();

  /** 카카오맵 버튼은 주소로만 검색한다 — 기관명을 섞으면 동명 업소로 튄다. */
  const kakaoLink = (f) =>
    "https://map.kakao.com/?q=" + encodeURIComponent(f.addr ? f.addr : `${f.gu} ${f.name}`);

  /* ─────────── 지도 ─────────── */

  let map, overlays = [], meOverlay = null;

  function initMap() {
    map = new kakao.maps.Map($("#map"), {
      center: new kakao.maps.LatLng(37.3935, 126.9465),
      level: 6,
    });
    kakao.maps.event.addListener(map, "click", closeSheet);

    // 헤더가 얇아 레이아웃이 늦게 잡히면 지도가 0 크기로 굳는다. 크기 변화를 따라간다.
    new ResizeObserver(() => map.relayout()).observe($("#map"));
  }

  /** 같은 좌표에 여러 기관이 있으면 흩뿌리지 않고 하나로 묶어 +N 으로 표시한다. */
  function buildGroups(list) {
    const byPos = new Map();
    for (const f of list) {
      const key = `${f.lat.toFixed(5)},${f.lon.toFixed(5)}`;
      if (!byPos.has(key)) byPos.set(key, { key, lat: f.lat, lon: f.lon, items: [] });
      byPos.get(key).items.push(f);
    }
    const groups = [...byPos.values()];
    for (const g of groups) {
      g.items.sort((a, b) => PRIORITY.get(a.cat) - PRIORITY.get(b.cat));
      g.head = g.items[0];
    }
    return groups;
  }

  function renderMarkers() {
    overlays.forEach((o) => o.setMap(null));
    overlays = [];

    for (const g of state.groups) {
      const meta = CATS[g.head.cat];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pin";
      el.style.setProperty("--c", meta.color);
      el.title = g.items.map((f) => f.name).join(" · ");
      el.setAttribute("aria-label", g.items.map((f) => f.name).join(", "));
      el.innerHTML = esc(meta.ch) + (g.items.length > 1 ? `<sup>${g.items.length}</sup>` : "");
      // 마커를 누를 때는 지도를 움직이지 않는다 (이미 보고 있는 위치라 흔들리기만 한다).
      el.addEventListener("click", (e) => { e.stopPropagation(); selectGroup(g, { pan: false }); });

      const ov = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(g.lat, g.lon),
        content: el,
        yAnchor: 1,
        xAnchor: 0.5,
        clickable: true,
        // 응급실처럼 급할 때 찾는 분류가 약국 더미에 묻히지 않도록 우선순위를 z 로 준다
        zIndex: 100 - PRIORITY.get(g.head.cat),
      });
      ov.setMap(map);
      g.el = el;
      overlays.push(ov);
    }
    markSelection();
  }

  function markSelection() {
    for (const g of state.groups) {
      if (g.el) g.el.classList.toggle("is-on", Boolean(state.selected) && g.key === state.selected.key);
    }
  }

  /** 모바일에선 시트가 아래를 덮으므로 그만큼 지도를 밀어 마커가 가리지 않게 한다. */
  function panToWithSheet(lat, lon) {
    const pos = new kakao.maps.LatLng(lat, lon);
    map.panTo(pos);
    setTimeout(() => {
      const sheet = $("#sheet");
      if (sheet.hidden || window.innerWidth > 760) return;
      const shift = sheet.getBoundingClientRect().height / 2;
      const proj = map.getProjection();
      const pt = proj.containerPointFromCoords(pos);
      map.panTo(proj.coordsFromContainerPoint(new kakao.maps.Point(pt.x, pt.y + shift)));
    }, 240);
  }

  /* ─────────── 필터 ─────────── */

  function apply() {
    const q = state.query.trim().toLowerCase();
    state.visible = state.all.filter((f) =>
      state.cats.has(f.cat) &&
      opensOn(f, state.dayIndex) &&
      (!q || f.name.toLowerCase().includes(q) || (f.addr || "").toLowerCase().includes(q) ||
        f.gu.includes(q) || f.kind.includes(q))
    );
    state.groups = buildGroups(state.visible);

    if (state.selected) {
      const again = state.groups.find((g) => g.key === state.selected.key);
      state.selected = again || null;
      if (!again && state.sheetMode === "detail") closeSheet();
    }
    renderMarkers();
    renderChips();
    $("#fab-count").textContent = state.visible.length;
    if (state.sheetMode === "list") renderSheetList();
  }

  /* ─────────── 렌더 ─────────── */

  function renderDays() {
    const today = localISO(new Date());
    $("#days").innerHTML = state.meta.days.map((d, i) => `
      <button type="button" class="day" role="tab" data-i="${i}" aria-selected="${i === state.dayIndex}">
        <strong>${d.label}</strong><em>${d.dow}${d.holiday ? " " + d.holiday : ""}${d.date === today ? " 오늘" : ""}</em>
      </button>`).join("");
    $("#days").querySelectorAll(".day").forEach((b) => b.addEventListener("click", () => {
      state.dayIndex = +b.dataset.i;
      renderDays();
      apply();
      if (state.sheetMode === "detail" && state.selected) renderSheetDetail(state.selected);
    }));
  }

  function renderChips() {
    const counts = new Map();
    for (const f of state.all) if (opensOn(f, state.dayIndex)) counts.set(f.cat, (counts.get(f.cat) || 0) + 1);
    const bar = $("#chips");
    bar.innerHTML = "";
    $("#chips-panel").innerHTML = "";

    for (const c of ORDER) {
      if (!counts.get(c)) continue;
      const m = CATS[c];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.cat = c;
      b.style.setProperty("--c", m.color);
      b.setAttribute("aria-pressed", String(state.cats.has(c)));
      b.innerHTML = `<i></i>${esc(c)}<b>${counts.get(c)}</b>`;
      b.addEventListener("click", () => {
        if (state.cats.has(c)) state.cats.delete(c); else state.cats.add(c);
        apply();
      });
      bar.appendChild(b);
    }
    layoutChips();
  }

  /**
   * 칩이 한 줄에 안 들어가면 넘치는 만큼 패널로 옮기고 +N 버튼을 띄운다.
   * 폭을 재야 해서 DOM 에 붙인 뒤에 계산한다.
   */
  function layoutChips() {
    const bar = $("#chips"), panel = $("#chips-panel"), more = $("#chips-more");
    while (panel.firstChild) bar.appendChild(panel.firstChild);

    const avail = document.querySelector('.ov--top').clientWidth;
    const kids = [...bar.children];
    const GAP = 5, MORE_W = 58;
    let used = 0, cut = kids.length;
    for (let i = 0; i < kids.length; i++) {
      const w = kids[i].offsetWidth + (i ? GAP : 0);
      const budget = avail - (i < kids.length - 1 ? MORE_W + GAP : 0);
      if (used + w > budget) { cut = i; break; }
      used += w;
    }

    if (cut >= kids.length) {
      more.hidden = true;
      panel.hidden = true;
      state.chipsOpen = false;
      more.setAttribute("aria-expanded", "false");
      return;
    }
    kids.slice(cut).forEach((k) => panel.appendChild(k));
    const onCount = kids.slice(cut).filter((k) => k.getAttribute("aria-pressed") === "true").length;
    more.hidden = false;
    more.innerHTML = `+${kids.length - cut}` + (onCount ? `<b>${onCount}</b>` : "");
    more.classList.toggle("has-on", onCount > 0);
    more.setAttribute("aria-expanded", String(state.chipsOpen));
    panel.hidden = !state.chipsOpen;
  }

  function schedHtml(f) {
    if (f.set === "er") {
      return `<div class="sched"><div class="sel">24시간 응급실 운영<span>${esc(f.cat)}</span></div></div>`;
    }
    if (f.set === "moon") {
      const rows = [];
      if (f.holiday) rows.push(`<div class="sel">${esc(f.holiday.replace(/^\([^)]*\)\s*/, ""))}<span>연휴(토·일·공)</span></div>`);
      else rows.push(`<div class="off">미표기<span>연휴 시간</span></div>`);
      if (f.weekday) rows.push(`<div class="off">${esc(f.weekday.replace(/^\([^)]*\)\s*/, ""))}<span>평일</span></div>`);
      return `<div class="sched">${rows.join("")}</div>`;
    }
    return `<div class="sched">${state.meta.days.map((d, i) => {
      const h = f.hours[i];
      const cls = i === state.dayIndex ? "sel" : (h ? "" : "off");
      return `<div class="${cls}">${h ? (h === ALWAYS_OPEN ? "24시간" : esc(h)) : "휴무"}<span>${d.label} ${d.dow}</span></div>`;
    }).join("")}</div>`;
  }

  function cardHtml(f) {
    const m = CATS[f.cat];
    const tel = f.erTel || f.tel;
    return `<article class="card">
      <div class="card__top">
        <span class="tag" style="--c:${m.color}">${esc(m.ch)}</span>
        <span class="card__name">${esc(f.name)}</span>
        <span class="card__kind">${esc(f.kind)}</span>
      </div>
      <div class="card__addr"><em>${esc(f.gu)}</em> ${esc(shortAddr(f.addr)) || "주소 미표기"}${
        f.partner ? ` · 협약약국 ${esc(f.partner)}` : ""}</div>
      ${schedHtml(f)}
      <div class="acts">
        ${tel ? `<a class="call" href="tel:${tel.replace(/[^0-9+]/g, "")}">전화 ${esc(tel)}</a>` : ""}
        <a href="${kakaoLink(f)}" target="_blank" rel="noopener">카카오맵</a>
      </div>
    </article>`;
  }

  function openSheet() {
    clearTimeout(closeTimer);
    const sheet = $("#sheet");
    sheet.classList.remove("is-closing");
    sheet.hidden = false;
  }

  let closeTimer = null;

  function closeSheet() {
    const sheet = $("#sheet");
    state.sheetMode = null;
    state.selected = null;
    $("#btn-list").classList.remove("on");
    markSelection();
    if (sheet.hidden) return;
    // 아래로 내려가는 느낌을 주고 나서 감춘다
    sheet.classList.add("is-closing");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      sheet.classList.remove("is-closing");
      sheet.hidden = true;
    }, 190);
  }

  function renderSheetDetail(g) {
    state.sheetMode = "detail";
    const many = g.items.length > 1;
    $("#sheet-body").innerHTML =
      `<div class="sheet__head">${many ? `<b>같은 위치 ${g.items.length}곳</b>` : `<b>${esc(g.head.name)}</b>`}
        <button type="button" class="sheet__back" id="to-list">목록</button></div>` +
      g.items.map(cardHtml).join("");
    $("#to-list").addEventListener("click", renderSheetList);
    openSheet();
  }

  function renderSheetList() {
    state.sheetMode = "list";
    state.selected = null;
    markSelection();
    $("#btn-list").classList.add("on");

    let rows = state.visible;
    if (state.origin) {
      rows = rows.map((f) => ({ ...f, _d: distanceM(state.origin, [f.lat, f.lon]) }))
        .sort((a, b) => a._d - b._d);
    }
    const day = state.meta.days[state.dayIndex];
    $("#sheet-body").innerHTML =
      `<div class="sheet__head"><b>${day.label} ${day.dow}</b> · ${state.visible.length}곳${
        state.origin ? " · 가까운 순" : ""}</div>` +
      (rows.length
        ? `<ul class="rows">${rows.map((f) => {
            const m = CATS[f.cat];
            return `<li><button type="button" data-id="${f.id}">
              <span class="tag" style="--c:${m.color}">${esc(m.ch)}</span>
              <span><span class="nm">${esc(f.name)}</span><br>
                <span class="sub">${esc(f.gu)} · ${esc(f.kind)}</span></span>
              <span class="${state.origin ? "dist" : "hr"}">${
                state.origin ? fmtDist(f._d) : esc(hoursText(f, state.dayIndex))}</span>
            </button></li>`;
          }).join("")}</ul>`
        : `<p class="empty">조건에 맞는 곳이 없습니다.</p>`);

    $("#sheet-body").querySelectorAll("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = +b.dataset.id;
        const g = state.groups.find((x) => x.items.some((y) => y.id === id));
        if (g) selectGroup(g, { pan: true });
      }));
    openSheet();
  }

  function selectGroup(g, opts = {}) {
    state.selected = g;
    renderSheetDetail(g);
    markSelection();
    if (opts.pan) panToWithSheet(g.lat, g.lon);
  }

  function renderInfo() {
    const m = state.meta;
    $("#info-body").innerHTML = `
      <p><strong>${esc(m.disclaimer)}</strong></p>
      <p>출처: ${esc(m.source)} · ${esc(m.sourceAsOf)} 기준 ·
         <a href="${m.sourceUrl}" target="_blank" rel="noopener">원문 공지</a></p>
      <p><b>경기 응급의료기관</b>(권역센터·지역센터·지역기관)은 24시간 운영이라 날짜 탭과 무관합니다.
         <b>달빛어린이병원</b>은 야간·휴일 소아 진료 기관으로, 9.24~9.27 은 모두 공휴일이라
         (토/일/공) 운영시간이 적용됩니다.</p>
      <ul>${m.contacts.map((c) => c.url
        ? `<li>${esc(c.label)} — <a href="${c.url}" target="_blank" rel="noopener">${c.url.replace(/^https?:\/\//, "")}</a></li>`
        : `<li>${esc(c.label)} — <a href="tel:${c.tel.replace(/[^0-9]/g, "")}">${esc(c.tel)}</a></li>`).join("")}</ul>
      <p>좌표는 카카오 지오코딩으로 만들었고 지도는 카카오맵을 씁니다.</p>`;
  }

  /* ─────────── 내 위치 ─────────── */

  function locate() {
    const btn = $("#btn-locate");
    if (state.origin) {
      state.origin = null;
      if (meOverlay) { meOverlay.setMap(null); meOverlay = null; }
      btn.classList.remove("on");
      if (state.sheetMode === "list") renderSheetList();
      return;
    }
    if (!navigator.geolocation) { alert("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        state.origin = [pos.coords.latitude, pos.coords.longitude];
        const dot = document.createElement("div");
        dot.style.cssText = "width:16px;height:16px;border-radius:50%;background:#1a6fd4;" +
          "border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15),0 2px 6px rgba(0,0,0,.3)";
        if (meOverlay) meOverlay.setMap(null);
        meOverlay = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(state.origin[0], state.origin[1]),
          content: dot, yAnchor: 0.5, xAnchor: 0.5,
        });
        meOverlay.setMap(map);
        btn.classList.add("on");
        map.setLevel(4);
        map.panTo(new kakao.maps.LatLng(state.origin[0], state.origin[1]));
        if (state.sheetMode === "list") renderSheetList();
      },
      () => { btn.disabled = false; alert("위치를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요."); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  /* ─────────── 시작 ─────────── */

  function pickDefaultDay() {
    const today = localISO(new Date());
    const i = state.meta.days.findIndex((d) => d.date === today);
    state.dayIndex = i >= 0 ? i : (today < state.meta.days[0].date ? 0 : state.meta.days.length - 1);
  }

  function fitToAnyang() {
    const pts = state.all.filter((f) => f.set === "anyang");
    if (!pts.length) return;
    const b = new kakao.maps.LatLngBounds();
    for (const f of pts) b.extend(new kakao.maps.LatLng(f.lat, f.lon));
    map.setBounds(b, 26, 26, 26, 26);
  }

  async function boot() {
    let doc;
    try {
      const res = await fetch("data/facilities.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (err) {
      document.body.insertAdjacentHTML("beforeend",
        `<p style="padding:20px">데이터를 불러오지 못했습니다: ${esc(err.message)}</p>`);
      return;
    }

    state.meta = doc.meta;
    state.all = [
      ...doc.facilities.map((f) => ({ ...f, set: "anyang" })),
      ...doc.er.map((f) => ({ ...f, set: "er" })),
      ...doc.moon.map((f) => ({ ...f, set: "moon" })),
    ];

    pickDefaultDay();
    initMap();
    fitToAnyang();
    renderDays();
    renderInfo();
    apply();

    let t;
    $("#search").addEventListener("input", (e) => {
      $("#search-clear").hidden = !e.target.value;
      clearTimeout(t);
      t = setTimeout(() => { state.query = e.target.value; apply(); }, 140);
    });
    $("#search-clear").addEventListener("click", () => {
      $("#search").value = "";
      $("#search-clear").hidden = true;
      state.query = "";
      apply();
      $("#search").focus();
    });
    $("#chips-more").addEventListener("click", (e) => {
      e.stopPropagation();
      state.chipsOpen = !state.chipsOpen;
      layoutChips();
    });
    document.addEventListener("click", (e) => {
      if (!state.chipsOpen) return;
      if (e.target.closest("#chips-panel") || e.target.closest("#chips-more")) return;
      state.chipsOpen = false;
      layoutChips();
    });
    new ResizeObserver(() => layoutChips()).observe($(".ov--top"));

    $("#btn-list").addEventListener("click", () =>
      (state.sheetMode === "list" ? closeSheet() : renderSheetList()));
    $("#btn-locate").addEventListener("click", locate);
    $("#sheet-close").addEventListener("click", closeSheet);
    $("#btn-info").addEventListener("click", () => $("#info").showModal());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  }

  if (!window.kakao || !window.kakao.maps) {
    document.body.insertAdjacentHTML("beforeend",
      `<p style="padding:20px;font-size:14px">카카오맵을 불러오지 못했습니다.
       이 도메인이 카카오 개발자 콘솔의 웹 플랫폼에 등록되어 있는지 확인해 주세요.</p>`);
  } else {
    kakao.maps.load(boot);
  }
})();
