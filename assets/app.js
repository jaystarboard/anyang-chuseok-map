(() => {
  "use strict";

  const ALWAYS_OPEN = "응급실운영";
  const MAIL = "jaystarboard@gmail.com";

  const CATS = {
    "응급실":   { ch: "응", color: "#c62828", set: "anyang" },
    "병원":     { ch: "병", color: "#1565c0", set: "anyang" },
    "의원":     { ch: "의", color: "#b45309", set: "anyang" },
    "치과":     { ch: "치", color: "#ad1457", set: "anyang" },
    "한방":     { ch: "한", color: "#6a1b9a", set: "anyang" },
    "약국":     { ch: "약", color: "#2e7d32", set: "anyang" },
    "권역센터": { ch: "권", color: "#263238", set: "er" },
    "지역센터": { ch: "지", color: "#5d4037", set: "er" },
    "지역기관": { ch: "기", color: "#546e7a", set: "er" },
    "달빛":     { ch: "달", color: "#00695c", set: "moon" },
  };

  const ALL = "전체";

  const CAT_LIST = [ALL, ...Object.keys(CATS)];

  const PRIORITY = new Map(
    ["응급실", "권역센터", "지역센터", "지역기관", "병원", "의원", "치과", "한방", "달빛", "약국"]
      .map((c, i) => [c, i]));

  const ZOOM_MIN = 10, ZOOM_MAX = 19;
  const SELECTED_Z = 200;      // 마커(<=100)보다 위, 팝업(300)보다 아래
  // 화면상 중심 간 최소 간격(px). 가장 큰 클러스터 원(44px)보다 커야 서로 겹치지 않는다.
  const CLUSTER_GAP = 50;
  const CLUSTER_MAX_ZOOM = 15;

  const state = {
    meta: null,
    all: [],
    dayIndex: 0,
    cat: ALL,
    origin: null,
    visible: [],
    groups: [],
    selected: null,
    sheetMode: null,
  };

  /**
   * 페이지 자체가 확대/축소되지 않게 막는다. 지도는 자체 제스처를 쓰므로 영향이 없다.
   * - gesture* : iOS 사파리의 핀치 페이지 줌
   * - ctrl+wheel : 데스크톱 브라우저 줌
   * 더블탭 줌은 html/body 의 touch-action: manipulation 이 막는다.
   */
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isDesktop = () => window.innerWidth > 760;

  const localISO = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const opensOn = (f, i) => (f.set !== "anyang" ? true : Boolean(f.hours[i]));

  const inScope = (f) => (state.cat === ALL ? f.set === "anyang" : f.cat === state.cat);

  function hoursText(f, i) {
    if (f.set === "er") return "24시간";
    if (f.set === "moon") return (f.holiday || f.weekday || "").replace(/^\([^)]*\)\s*/, "");
    const h = f.hours[i];
    if (!h) return "휴무";
    return h === ALWAYS_OPEN ? "24시간" : h;
  }

  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);

  function shortAddr(f) {
    let a = String(f.addr || "").replace(/\s+/g, " ").replace(/^경기도\s*/, "");
    a = a.replace(/^안양시\s*(?:동안구|만안구)\s*/, "");
    if (f.gu) a = a.replace(new RegExp("^" + f.gu.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), "");
    return a.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  function roadOnly(addr) {
    const a = String(addr || "").replace(/\s+/g, " ").replace(/(로|길)\s+(\d+번길)/, "$1$2");
    const m = a.match(/^(.*?(?:로|길)\d*번?길?)\s+(\d+(?:-\d+)?)/);
    return m ? `${m[1]} ${m[2]}` : a.split(",")[0].trim();
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // 권한 정책으로 막히는 환경이 있어 아래 방식으로 한 번 더 시도한다
      }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  const fullAddr = (f) => String(f.addr || "").replace(/\s+/g, " ").trim();

  const kakaoLink = (f) =>
    "https://map.kakao.com/?q=" + encodeURIComponent(f.addr ? roadOnly(f.addr) : `${f.gu} ${f.name}`);

  let engine, pinHandles = [], meHandle = null, meEl = null, popHandle = null, idleTimer = null, watchId = null;

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

  /**
   * 화면 거리 기준으로 가까운 지점들을 묶는다.
   *
   * 격자로 자르면 경계에 걸친 두 셀의 무게중심이 몇 px 까지 붙어 원이 겹친다.
   * 그렇다고 흡수할 때마다 중심을 옮기면 연쇄로 덩어리가 계속 커진다.
   * 그래서 먼저 잡힌 지점을 리더로 고정해 반경을 묶고, 표시도 리더 자리에 한다.
   * 리더끼리는 CLUSTER_GAP 이상 떨어져 있으므로 원이 겹치지 않는다.
   * 패닝해도 점들 사이의 상대 거리는 그대로라 확대/축소할 때만 묶임이 바뀐다.
   */
  function clusterGroups() {
    if (!engine || engine.getZoom() >= CLUSTER_MAX_ZOOM) {
      return state.groups.map((g) => ({ single: g, groups: [g], lat: g.lat, lon: g.lon }));
    }

    const cells = [];
    for (const g of state.groups) {
      const p = engine.project([g.lat, g.lon]);
      let host = null;
      for (const c of cells) {
        if (Math.hypot(c.x - p.x, c.y - p.y) < CLUSTER_GAP) { host = c; break; }
      }
      if (host) host.groups.push(g);
      else cells.push({ groups: [g], x: p.x, y: p.y, lead: g });
    }

    return cells.map((c) => ({
      single: c.groups.length === 1 ? c.lead : null,
      groups: c.groups,
      lat: c.lead.lat,
      lon: c.lead.lon,
    }));
  }

  function renderPins() {
    pinHandles.forEach((h) => engine.removeOverlay(h));
    pinHandles = [];
    state.groups.forEach((g) => { g.el = null; g.ov = null; });

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
        bindTap(el, () => selectGroup(g));
        g.el = el;
        g.ov = engine.addOverlay(el, [g.lat, g.lon], { zIndex: baseZ(g), clickable: false });
        pinHandles.push(g.ov);
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
        bindTap(el, () => {
          engine.fitBounds(c.groups.map((g) => [g.lat, g.lon]), [96, 56, 64, 56], CLUSTER_MAX_ZOOM + 2);
        });
        pinHandles.push(engine.addOverlay(el, [c.lat, c.lon], { yAnchor: 0.5, zIndex: 40, clickable: false }));
      }
    }
    placeMeDot();
    syncZoomButtons();
    markSelection();
  }

  const baseZ = (g) => 100 - PRIORITY.get(g.head.cat);

  /**
   * 마커 오버레이는 이벤트를 통과시켜(clickable:false) 그 위에서도 지도를 끌 수 있게 해 뒀다.
   * 대신 끌고 나서 손을 떼는 것까지 클릭으로 잡히므로, 움직인 거리로 탭과 드래그를 가른다.
   */
  function bindTap(el, run) {
    let sx = 0, sy = 0, moved = false;
    const down = (e) => {
      const p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY; moved = false;
    };
    const move = (e) => {
      const p = e.touches ? e.touches[0] : e;
      if (Math.hypot(p.clientX - sx, p.clientY - sy) > 6) moved = true;
    };
    el.addEventListener("mousedown", down);
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("mousemove", move);
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!moved) run();
    });
  }

  function markSelection() {
    for (const g of state.groups) {
      if (!g.el) continue;
      const on = Boolean(state.selected) && g.key === state.selected.key;
      g.el.classList.toggle("is-on", on);
      // CSS z-index 는 오버레이 래퍼 안쪽이라 소용없다. 오버레이 자체를 올려야 가려지지 않는다.
      if (g.ov) engine.setOverlayZ(g.ov, on ? SELECTED_Z : baseZ(g));
    }
  }

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

  function apply() {
    state.visible = state.all.filter((f) => inScope(f) && opensOn(f, state.dayIndex));
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

      const ext = c !== ALL && CATS[c].set !== "anyang";
      b.className = "chip" + (c === ALL ? " chip--all" : "") + (ext ? " chip--ext" : "");
      b.dataset.cat = c;
      if (c !== ALL) b.style.setProperty("--c", CATS[c].color);
      b.setAttribute("aria-pressed", String(state.cat === c));
      b.innerHTML = (c === ALL ? "" : "<i></i>") + `${esc(c)}<b>${counts.get(c)}</b>`;
      b.addEventListener("click", () => { state.cat = c; apply(); });
      bar.appendChild(b);
    }
  }

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
        f.addr ? `<button type="button" class="copy" data-copy="${esc(fullAddr(f))}" aria-label="주소 복사" title="주소 복사">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
        </button>` : ""}${f.partner ? ` · 협약약국 ${esc(f.partner)}` : ""}</div>
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

    for (const ev of ["wheel", "mousewheel", "DOMMouseScroll", "mousedown", "dblclick", "touchmove"]) {
      wrap.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }

    popHandle = engine.addOverlay(wrap, [g.lat, g.lon], { yAnchor: 1, xAnchor: 0.5, zIndex: 300 });
  }

  function closePopup() {
    if (popHandle) { engine.removeOverlay(popHandle); popHandle = null; }
  }

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

  function placeMeDot() {
    if (!state.origin) return;
    if (meHandle && meEl && meEl.isConnected) {
      engine.moveOverlay(meHandle, state.origin);
      return;
    }
    if (meHandle) engine.removeOverlay(meHandle);
    meEl = document.createElement("div");
    meEl.className = "medot";
    meHandle = engine.addOverlay(meEl, engine.getCenter(), { yAnchor: 0.5, xAnchor: 0.5, zIndex: 20, clickable: false });
    engine.moveOverlay(meHandle, state.origin);
  }

  function clearMeDot() {
    if (meHandle) engine.removeOverlay(meHandle);
    meHandle = null;
    meEl = null;
  }

  function stopWatch() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  function nudgeZoom(step) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(engine.getZoom()) + step));
    engine.setZoom(z);
    setTimeout(syncZoomButtons, 300);
  }

  function syncZoomButtons() {
    if (!engine) return;
    const z = Math.round(engine.getZoom());
    $("#btn-zoom-in").disabled = z >= ZOOM_MAX;
    $("#btn-zoom-out").disabled = z <= ZOOM_MIN;
  }

  function locateOff() {
    stopWatch();
    state.origin = null;
    clearMeDot();
    $("#btn-locate").classList.remove("on");
    if (state.sheetMode === "list") renderSheetList();
  }

  function locate() {
    const btn = $("#btn-locate");
    if (state.origin) { locateOff(); return; }
    if (!navigator.geolocation) { alert("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }

    btn.disabled = true;
    let first = true;
    stopWatch();
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        btn.disabled = false;
        state.origin = [pos.coords.latitude, pos.coords.longitude];
        placeMeDot();
        btn.classList.add("on");
        if (first) {
          first = false;
          engine.flyTo(state.origin, 16);
        }
        if (state.sheetMode === "list") renderSheetList();
      },
      (err) => {
        btn.disabled = false;
        if (first) {
          stopWatch();
          alert("위치를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요.");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  async function setEngine(force) {
    const keep = engine ? { center: engine.getCenter(), zoom: engine.getZoom() } : null;
    if (engine) {
      pinHandles.forEach((h) => engine.removeOverlay(h));
      pinHandles = [];
      closePopup();
      clearMeDot();
      engine.destroy();
    }

    engine = await MapEngine.create($("#map"), {
      center: keep ? keep.center : [37.3935, 126.9465],
      zoom: keep ? keep.zoom : 13,
      force,
    });
    document.body.dataset.engine = engine.name;
    engine.on("click", closeDetail);
    engine.on("userpan", () => { if (state.origin) locateOff(); });
    engine.on("idle", () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(renderPins, 90);
    });
    if (!keep) engine.fitBounds(state.all.filter((f) => f.set === "anyang").map((f) => [f.lat, f.lon]));

    if (state.origin) placeMeDot();
    renderInfo();
    renderPins();
    return engine.name;
  }

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

    $("#btn-list").addEventListener("click", () =>
      (state.sheetMode === "list" ? closeDetail() : renderSheetList()));
    $("#btn-zoom-in").addEventListener("click", () => nudgeZoom(1));
    $("#btn-zoom-out").addEventListener("click", () => nudgeZoom(-1));
    $("#btn-locate").addEventListener("click", locate);
    $("#sheet-close").addEventListener("click", closeDetail);
    $("#btn-info").addEventListener("click", () => $("#info").showModal());
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      e.stopPropagation();
      const ok = await copyText(btn.dataset.copy);
      btn.classList.add(ok ? "is-done" : "is-fail");
      setTimeout(() => btn.classList.remove("is-done", "is-fail"), 1200);
    });

    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

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
