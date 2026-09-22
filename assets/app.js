/**
 * 추석 연휴 문여는 병원·약국 — 안양시 전체
 *
 * 지도가 화면 대부분을 차지하고 검색·필터·버튼은 지도 위 오버레이로 띄운다.
 * 좌표는 빌드 시점에 카카오 지오코딩으로 구워 두어 런타임 지오코딩은 하지 않는다.
 * 지도 엔진(카카오 / OSM)은 assets/map.js 가 골라 주므로 여기서는 신경 쓰지 않는다.
 */
(() => {
  "use strict";

  const ALWAYS_OPEN = "응급실운영";
  const MAIL = "jaystarboard@gmail.com";

  /**
   * 분류 -> 마커 글자·색.
   * 글자는 분류명 앞 글자를 그대로 쓰고, 색은 서로 최대한 멀어지도록 색상환을 갈라 배치했다.
   * 경기 레이어(권/지/기/달)는 보조 자료라 무채·갈색 계열로 빼서 안양시 6종과 섞이지 않게 했다.
   */
  const CATS = {
    "응급실":   { ch: "응", color: "#c62828", set: "anyang" },
    "병원":     { ch: "병", color: "#1565c0", set: "anyang" },
    "의원":     { ch: "의", color: "#0f766e", set: "anyang" },
    "치과":     { ch: "치", color: "#ad1457", set: "anyang" },
    "한방":     { ch: "한", color: "#6a1b9a", set: "anyang" },
    "약국":     { ch: "약", color: "#2e7d32", set: "anyang" },
    "권역센터": { ch: "권", color: "#263238", set: "er" },
    "지역센터": { ch: "지", color: "#5d4037", set: "er" },
    "지역기관": { ch: "기", color: "#546e7a", set: "er" },
    "달빛":     { ch: "달", color: "#a15c00", set: "moon" },
  };

  /** 필터는 한 번에 하나만 고른다. "전체" 는 안양시 6종 전부. */
  const ALL = "전체";
  /** 필터 칩 순서. 전부 한 화면에 보이도록 줄바꿈으로 펼친다. */
  const CAT_LIST = [ALL, ...Object.keys(CATS)];

  /** 같은 지점에 묶였을 때 대표로 세울 분류. 급할 때 찾는 쪽이 앞, 약국이 맨 뒤. */
  const PRIORITY = new Map(
    ["응급실", "권역센터", "지역센터", "지역기관", "병원", "의원", "치과", "한방", "달빛", "약국"]
      .map((c, i) => [c, i]));

  // 격자가 넓으면 수 km 떨어진 곳까지 한 덩어리로 묶여 대표점이 실제 위치와 멀어진다.
  const CLUSTER_CELL = 44;      // px. 이 격자 안에 겹치는 지점만 묶는다
  const CLUSTER_MAX_ZOOM = 15;  // 이보다 확대하면 항상 개별 마커로 푼다
  const CLUSTER_SPAN_MAX = 46;  // px. 묶인 뒤에도 퍼짐이 이보다 크면 쪼갠다
  const GRID_LAT = 37.39;       // 격자 경도 스케일 기준 위도 (안양 부근)

  const state = {
    meta: null,
    all: [],
    dayIndex: 0,
    cat: ALL,                // 단일 선택 필터
    query: "",
    origin: null,
    visible: [],
    groups: [],
    selected: null,
    sheetMode: null,
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isDesktop = () => window.innerWidth > 760;

  /* ─────────── 시간 ─────────── */

  const localISO = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** 경기 레이어는 날짜와 무관하게 항상 대상이다. */
  const opensOn = (f, i) => (f.set !== "anyang" ? true : Boolean(f.hours[i]));

  /** "전체" 는 안양시 자료만 뜻한다. 경기 레이어는 해당 분류를 직접 골라야 보인다. */
  const inScope = (f) => (state.cat === ALL ? f.set === "anyang" : f.cat === state.cat);

  function hoursText(f, i) {
    if (f.set === "er") return "24시간";
    if (f.set === "moon") return (f.holiday || f.weekday || "").replace(/^\([^)]*\)\s*/, "");
    const h = f.hours[i];
    if (!h) return "휴무";
    return h === ALWAYS_OPEN ? "24시간" : h;
  }

  /* ─────────── 주소·거리 ─────────── */

  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);

  /** 카드에 구를 따로 보여 주므로 주소에서 시·도·구를 떼어 중복을 없앤다. */
  function shortAddr(f) {
    let a = String(f.addr || "").replace(/\s+/g, " ").replace(/^경기도\s*/, "");
    a = a.replace(/^안양시\s*(?:동안구|만안구)\s*/, "");
    if (f.gu) a = a.replace(new RegExp("^" + f.gu.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), "");
    return a.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  /** 동·호수가 붙으면 검색이 흐려지므로 도로명+건물번호까지만 남긴다. */
  function roadOnly(addr) {
    const a = String(addr || "").replace(/\s+/g, " ").replace(/(로|길)\s+(\d+번길)/, "$1$2");
    const m = a.match(/^(.*?(?:로|길)\d*번?길?)\s+(\d+(?:-\d+)?)/);
    return m ? `${m[1]} ${m[2]}` : a.split(",")[0].trim();
  }

  /** 카카오맵 버튼은 주소로만 검색한다 — 기관명을 섞으면 동명 업소로 튄다. */
  const kakaoLink = (f) =>
    "https://map.kakao.com/?q=" + encodeURIComponent(f.addr ? roadOnly(f.addr) : `${f.gu} ${f.name}`);

  /* ─────────── 지도 ─────────── */

  let engine, pinHandles = [], meHandle = null, popHandle = null, idleTimer = null;

  /** 같은 좌표의 기관들을 한 지점으로 묶는다 (흩뿌리면 서로 가려 클릭이 안 된다). */
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

  /** 화면 1px 이 지도상 몇 m 인지 엔진에서 실측한다 (줌에만 의존, 패닝과 무관). */
  function metersPerPixel() {
    const c = engine.getCenter();
    const p = engine.project(c);
    const a = engine.unproject({ x: p.x, y: p.y });
    const b = engine.unproject({ x: p.x + 64, y: p.y });
    return distanceM(a, b) / 64;
  }

  /**
   * 가까운 지점들을 묶는다. 확대할수록 자연히 풀린다.
   *
   * 격자는 반드시 **지도 좌표**에 고정해야 한다. 화면 픽셀로 격자를 만들면 패닝할 때마다
   * 격자선이 데이터 위를 미끄러져, 줌이 같은데도 묶임이 계속 바뀐다.
   * 셀 크기만 현재 줌의 m/px 로 환산해 화면상 크기를 일정하게 유지한다.
   */
  function clusterGroups() {
    if (!engine || engine.getZoom() >= CLUSTER_MAX_ZOOM) {
      return state.groups.map((g) => ({ single: g, groups: [g], lat: g.lat, lon: g.lon }));
    }
    const cellM = CLUSTER_CELL * metersPerPixel();
    const M_LAT = 111320;
    const M_LON = 111320 * Math.cos(GRID_LAT * Math.PI / 180);   // 기준 위도로 고정해 격자를 균일하게

    const cells = new Map();
    for (const g of state.groups) {
      const key = `${Math.floor((g.lon * M_LON) / cellM)},${Math.floor((g.lat * M_LAT) / cellM)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(g);
    }

    const spanLimitM = CLUSTER_SPAN_MAX * metersPerPixel();
    const out = [];
    for (const groups of cells.values()) {
      if (groups.length === 1) {
        out.push({ single: groups[0], groups, lat: groups[0].lat, lon: groups[0].lon });
        continue;
      }
      // 격자 모서리에 걸쳐 멀리 떨어진 것끼리 묶였으면 한 덩어리로 보여 주지 않는다
      const xs = groups.map((g) => g.lon * M_LON), ys = groups.map((g) => g.lat * M_LAT);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (span > spanLimitM) {
        groups.forEach((g) => out.push({ single: g, groups: [g], lat: g.lat, lon: g.lon }));
        continue;
      }
      out.push({
        single: null, groups,
        lat: groups.reduce((s, g) => s + g.lat, 0) / groups.length,
        lon: groups.reduce((s, g) => s + g.lon, 0) / groups.length,
      });
    }
    return out;
  }

  function renderPins() {
    pinHandles.forEach((h) => engine.removeOverlay(h));
    pinHandles = [];
    state.groups.forEach((g) => { g.el = null; });

    for (const c of clusterGroups()) {
      if (c.single) {
        const g = c.single, meta = CATS[g.head.cat];
        const el = document.createElement("button");
        el.type = "button";
        el.className = "pin";
        el.style.setProperty("--c", meta.color);
        el.title = g.items.map((f) => f.name).join(" · ");
        el.setAttribute("aria-label", g.items.map((f) => f.name).join(", "));
        el.innerHTML = esc(meta.ch) + (g.items.length > 1 ? `<sup>${g.items.length}</sup>` : "");
        el.addEventListener("click", (e) => { e.stopPropagation(); selectGroup(g); });
        g.el = el;
        pinHandles.push(engine.addOverlay(el, [g.lat, g.lon],
          { zIndex: 100 - PRIORITY.get(g.head.cat) }));
      } else {
        const total = c.groups.reduce((s, g) => s + g.items.length, 0);
        const top = c.groups.map((g) => g.head.cat)
          .sort((a, b) => PRIORITY.get(a) - PRIORITY.get(b))[0];
        const el = document.createElement("button");
        el.type = "button";
        el.className = "cluster" + (total >= 20 ? " is-lg" : total >= 8 ? " is-md" : "");
        el.style.setProperty("--c", CATS[top].color);
        el.textContent = total;
        el.setAttribute("aria-label", `이 부근 ${total}곳, 눌러서 확대`);
        el.title = `이 부근 ${total}곳`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          engine.zoomAround([c.lat, c.lon], Math.min(CLUSTER_MAX_ZOOM + 1, engine.getZoom() + 2));
        });
        pinHandles.push(engine.addOverlay(el, [c.lat, c.lon], { yAnchor: 0.5, zIndex: 40 }));
      }
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
    engine.panTo([lat, lon]);
    setTimeout(() => {
      const sheet = $("#sheet");
      if (sheet.hidden || isDesktop()) return;
      const shift = sheet.getBoundingClientRect().height / 2;
      const pt = engine.project([lat, lon]);
      engine.panTo(engine.unproject({ x: pt.x, y: pt.y + shift }));
    }, 260);
  }

  /* ─────────── 필터 ─────────── */

  function apply() {
    const q = state.query.trim().toLowerCase();
    state.visible = state.all.filter((f) =>
      inScope(f) &&
      opensOn(f, state.dayIndex) &&
      (!q || f.name.toLowerCase().includes(q) || (f.addr || "").toLowerCase().includes(q) ||
        f.gu.includes(q) || f.kind.includes(q))
    );
    state.groups = buildGroups(state.visible);

    if (state.selected) {
      const again = state.groups.find((g) => g.key === state.selected.key);
      state.selected = again || null;
      if (!again) closeDetail();
    }
    renderPins();
    renderChips();
    $("#fab-count").textContent = state.visible.length;
    if (state.sheetMode === "list") renderSheetList();
    else if (state.selected && isDesktop()) showPopup(state.selected);
  }

  /* ─────────── 렌더 ─────────── */

  function renderDays() {
    const today = localISO(new Date());
    $("#days").innerHTML = state.meta.days.map((d, i) => `
      <button type="button" class="day${d.holiday ? " is-holiday" : ""}" role="tab" data-i="${i}" aria-selected="${i === state.dayIndex}">
        <strong>${d.label}</strong><em>${d.dow}${d.holiday ? " " + d.holiday : ""}${d.date === today ? " 오늘" : ""}</em>
      </button>`).join("");
    $("#days").querySelectorAll(".day").forEach((b) => b.addEventListener("click", () => {
      state.dayIndex = +b.dataset.i;
      renderDays();
      apply();
      if (state.selected && !isDesktop() && state.sheetMode === "detail") renderSheetDetail(state.selected);
    }));
  }

  function renderChips() {
    const counts = new Map();
    for (const f of state.all) {
      if (!opensOn(f, state.dayIndex)) continue;
      counts.set(f.cat, (counts.get(f.cat) || 0) + 1);
      if (f.set === "anyang") counts.set(ALL, (counts.get(ALL) || 0) + 1);
    }

    const bar = $("#chips");
    bar.innerHTML = "";
    for (const c of CAT_LIST) {
      if (!counts.get(c)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (c === ALL ? " chip--all" : "");
      b.dataset.cat = c;
      if (c !== ALL) b.style.setProperty("--c", CATS[c].color);
      b.setAttribute("aria-pressed", String(state.cat === c));
      b.innerHTML = (c === ALL ? "" : "<i></i>") + `${esc(c)}<b>${counts.get(c)}</b>`;
      b.addEventListener("click", () => { state.cat = c; apply(); });
      bar.appendChild(b);
    }
  }

  /** 좁은 칸에서 "09:00~14:00" 이 넘치지 않도록 ~ 뒤에 줄바꿈 지점을 준다. */
  const timeHtml = (t) => esc(t).replace("~", "~<wbr>");

  function schedHtml(f) {
    if (f.set === "er") {
      return `<div class="sched"><div class="sel"><span>${esc(f.cat)}</span>24시간 응급실</div></div>`;
    }
    if (f.set === "moon") {
      const rows = f.holiday
        ? [`<div class="sel"><span>연휴(토·일·공)</span>${timeHtml(f.holiday.replace(/^\([^)]*\)\s*/, ""))}</div>`]
        : [`<div class="off"><span>연휴 시간</span>미표기</div>`];
      if (f.weekday) rows.push(`<div class="off"><span>평일</span>${timeHtml(f.weekday.replace(/^\([^)]*\)\s*/, ""))}</div>`);
      return `<div class="sched">${rows.join("")}</div>`;
    }
    return `<div class="sched">${state.meta.days.map((d, i) => {
      const h = f.hours[i];
      const cls = i === state.dayIndex ? "sel" : (h ? "" : "off");
      return `<div class="${cls}"><span>${d.label} ${d.dow}</span>${h ? (h === ALWAYS_OPEN ? "24시간" : timeHtml(h)) : "휴무"}</div>`;
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
      <div class="card__addr"><em>${esc(f.gu)}</em> ${esc(shortAddr(f)) || "주소 미표기"}${
        f.partner ? ` · 협약약국 ${esc(f.partner)}` : ""}</div>
      ${schedHtml(f)}
      <div class="acts">
        ${tel ? `<a class="call" href="tel:${tel.replace(/[^0-9+]/g, "")}">전화 ${esc(tel)}</a>` : ""}
        <a href="${kakaoLink(f)}" target="_blank" rel="noopener">카카오맵</a>
      </div>
    </article>`;
  }

  const headHtml = (g, withList) =>
    `<div class="sheet__head">${g.items.length > 1
      ? `<b>같은 위치 ${g.items.length}곳</b>` : `<b>${esc(g.head.name)}</b>`}${
      withList ? `<button type="button" class="sheet__back" id="to-list">목록</button>` : ""}</div>`;

  /* ─────────── PC 미니 팝업 ─────────── */

  function showPopup(g) {
    closePopup();
    const wrap = document.createElement("div");
    wrap.className = "popwrap";
    wrap.innerHTML = `<div class="pop">
      <button type="button" class="pop__close" aria-label="닫기">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="pop__body">${headHtml(g, false)}${g.items.map(cardHtml).join("")}</div></div>`;
    wrap.querySelector(".pop__close").addEventListener("click", (e) => {
      e.stopPropagation();
      state.selected = null;
      markSelection();
      closePopup();
    });
    popHandle = engine.addOverlay(wrap, [g.lat, g.lon], { yAnchor: 1, xAnchor: 0.5, zIndex: 300 });
  }

  function closePopup() {
    if (popHandle) { engine.removeOverlay(popHandle); popHandle = null; }
  }

  /* ─────────── 모바일 하단 시트 ─────────── */

  let closeTimer = null;

  function openSheet() {
    clearTimeout(closeTimer);
    const sheet = $("#sheet");
    sheet.classList.remove("is-closing");
    sheet.hidden = false;
  }

  function hideSheet() {
    const sheet = $("#sheet");
    if (sheet.hidden) return;
    sheet.classList.add("is-closing");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      sheet.classList.remove("is-closing");
      sheet.hidden = true;
    }, 190);
  }

  /** 지도 빈 곳 클릭·ESC — 팝업과 시트를 모두 닫는다. */
  function closeDetail() {
    closePopup();
    hideSheet();
    state.sheetMode = null;
    state.selected = null;
    $("#btn-list").classList.remove("on");
    markSelection();
  }

  function renderSheetDetail(g) {
    state.sheetMode = "detail";
    $("#sheet-body").innerHTML = headHtml(g, true) + g.items.map(cardHtml).join("");
    $("#to-list").addEventListener("click", renderSheetList);
    openSheet();
  }

  function renderSheetList() {
    closePopup();
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
              <span class="rows__txt"><span class="nm">${esc(f.name)}</span><br>
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
    markSelection();
    if (isDesktop()) {
      hideSheet();
      state.sheetMode = null;
      $("#btn-list").classList.remove("on");
      if (opts.pan) engine.panTo([g.lat, g.lon]);
      showPopup(g);
    } else {
      closePopup();
      renderSheetDetail(g);
      if (opts.pan) panToWithSheet(g.lat, g.lon);
    }
  }

  /* ─────────── 안내 ─────────── */

  function renderInfo() {
    const m = state.meta;
    const osm = engine.name === "osm";
    $("#info-body").innerHTML = `
      <p><strong>${esc(m.disclaimer)}</strong></p>
      <p>출처: ${esc(m.source)} · ${esc(m.sourceAsOf)} 기준 ·
         <a href="${m.sourceUrl}" target="_blank" rel="noopener">원문 공지</a></p>
      <p><b>경기 응급의료기관</b>(권역센터·지역센터·지역기관)은 24시간 운영이라 날짜 탭과 무관합니다.
         <b>달빛어린이병원</b>은 야간·휴일 소아 진료 기관으로, 9.24~9.27 은 모두 공휴일이라
         (토/일/공) 운영시간이 적용됩니다. 필터에서 해당 분류를 고르면 보입니다
         ("전체" 는 안양시 자료만 뜻합니다).</p>
      <p>현재 지도: <b>${esc(engine.label)}</b>.
         ${osm
           ? "카카오맵을 쓸 수 없어 OpenStreetMap 으로 자동 전환된 상태입니다."
           : "카카오 무료 쿼터를 모두 쓰면 자동으로 OpenStreetMap 지도로 전환됩니다."}</p>
      <ul>${m.contacts.map((c) => c.url
        ? `<li>${esc(c.label)} — <a href="${c.url}" target="_blank" rel="noopener">${c.url.replace(/^https?:\/\//, "")}</a></li>`
        : `<li>${esc(c.label)} — <a href="tel:${c.tel.replace(/[^0-9]/g, "")}">${esc(c.tel)}</a></li>`).join("")}</ul>
      <p>오류 제보·문의: <a href="mailto:${MAIL}">${MAIL}</a></p>`;
  }

  /* ─────────── 내 위치 ─────────── */

  function locate() {
    const btn = $("#btn-locate");
    if (state.origin) {
      state.origin = null;
      if (meHandle) { engine.removeOverlay(meHandle); meHandle = null; }
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
        dot.className = "medot";
        if (meHandle) engine.removeOverlay(meHandle);
        meHandle = engine.addOverlay(dot, state.origin, { yAnchor: 0.5, xAnchor: 0.5, zIndex: 20 });
        btn.classList.add("on");
        engine.zoomAround(state.origin, 16);
        if (state.sheetMode === "list") renderSheetList();
      },
      () => { btn.disabled = false; alert("위치를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요."); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  /* ─────────── 엔진 전환 ─────────── */

  /**
   * 지도 엔진을 세우거나 갈아끼운다. force 는 "osm" | "kakao" | undefined(자동).
   * 전환해도 보던 위치·줌·필터·내 위치는 그대로 유지한다.
   */
  async function setEngine(force) {
    const keep = engine ? { center: engine.getCenter(), zoom: engine.getZoom() } : null;
    if (engine) {
      pinHandles.forEach((h) => engine.removeOverlay(h));
      pinHandles = [];
      closePopup();
      if (meHandle) { engine.removeOverlay(meHandle); meHandle = null; }
      engine.destroy();
    }

    engine = await MapEngine.create($("#map"), {
      center: keep ? keep.center : [37.3935, 126.9465],
      zoom: keep ? keep.zoom : 13,
      force,
    });
    document.body.dataset.engine = engine.name;
    engine.on("click", closeDetail);
    engine.on("idle", () => {           // 확대/이동하면 클러스터를 다시 묶는다
      clearTimeout(idleTimer);
      idleTimer = setTimeout(renderPins, 90);
    });
    if (!keep) engine.fitBounds(state.all.filter((f) => f.set === "anyang").map((f) => [f.lat, f.lon]));

    if (state.origin) {                 // 내 위치 점도 새 엔진에 다시 얹는다
      const dot = document.createElement("div");
      dot.className = "medot";
      meHandle = engine.addOverlay(dot, state.origin, { yAnchor: 0.5, xAnchor: 0.5, zIndex: 20 });
    }
    renderInfo();
    renderPins();
    return engine.name;
  }

  /* ─────────── 시작 ─────────── */

  function pickDefaultDay() {
    const today = localISO(new Date());
    const i = state.meta.days.findIndex((d) => d.date === today);
    state.dayIndex = i >= 0 ? i : (today < state.meta.days[0].date ? 0 : state.meta.days.length - 1);
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

    await setEngine(new URLSearchParams(location.search).get("map") || undefined);
    new ResizeObserver(() => engine.relayout()).observe($("#map"));

    renderDays();
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
    $("#btn-list").addEventListener("click", () =>
      (state.sheetMode === "list" ? closeDetail() : renderSheetList()));
    $("#btn-locate").addEventListener("click", locate);
    $("#sheet-close").addEventListener("click", closeDetail);
    $("#btn-info").addEventListener("click", () => $("#info").showModal());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

    // 쿼터 소진 상황을 실제로 만들지 않고 폴백을 확인하려고 열어 둔 테스트 훅.
    window.mapEngine = {
      current: () => engine.name,
      useOSM: () => setEngine("osm"),
      useKakao: () => setEngine("kakao"),
      toggle: () => setEngine(engine.name === "kakao" ? "osm" : "kakao"),
    };
    console.info(
      "%c지도 엔진 전환 %c현재: " + engine.name,
      "background:#1a6fd4;color:#fff;padding:2px 6px;border-radius:4px",
      "color:#5a626d",
      "\n  mapEngine.useOSM()    무료 쿼터 소진 시 화면 (OpenStreetMap)" +
      "\n  mapEngine.useKakao()  카카오맵으로 복귀" +
      "\n  mapEngine.toggle()    번갈아 전환" +
      "\n  URL 에 ?map=osm 을 붙여도 같습니다.");
  }

  boot();
})();
