#!/usr/bin/env python3
"""동안구보건소 배포 PDF -> data/facilities.json 빌드.

PDF 표에는 괘선이 있어 pdfplumber 의 extract_tables() 로 일자별 컬럼이 그대로 분리된다.
extract_text() 만 쓰면 "09:00~16:00 10:00~13:00" 이 어느 날짜인지 복원할 수 없으므로 반드시 표로 읽는다.

좌표는 OpenStreetMap 의 도로명주소 태그(addr:street/addr:housenumber)에 대조해 구한다.
 1) (도로명, 건물번호) 완전 일치 -> exact
 2) 같은 도로의 앞뒤 건물번호 선형보간 -> approx
 3) 보간 간격이 커 신뢰할 수 없는 소수 항목은 MANUAL_FIX 로 고정
결과 좌표의 정확도는 acc 필드로 노출하고, 화면에서 "위치 근사" 배지로 표시한다.

사용법:
    pip install pdfplumber
    python tools/build_dataset.py <원본 PDF 경로>
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "facilities.json")
CACHE = os.path.join(ROOT, "tools", ".osm_addr_cache.json")

BBOX = (37.340, 126.900, 37.430, 127.010)
OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

DAYS = [
    {"date": "2026-09-24", "label": "9.24", "dow": "목"},
    {"date": "2026-09-25", "label": "9.25", "dow": "금", "holiday": "추석"},
    {"date": "2026-09-26", "label": "9.26", "dow": "토"},
    {"date": "2026-09-27", "label": "9.27", "dow": "일"},
]

CATEGORY = {
    "권역응급의료센터": "응급실", "병원": "병원", "한방병원": "한방",
    "의원": "의원", "치과의원": "치과", "한의원": "한방", "약국": "약국",
}
SKIP_ROWS = {"구분", "응급실소계", "병의원소계", "약국소계"}

# 보간 간격이 25 번지를 넘어 신뢰할 수 없는 항목. 카카오맵으로 지번을 확인한 뒤
# OSM 랜드마크 좌표(세명약국) 또는 해당 번길의 도로 중심점(나머지)을 사용한다.
#
# 관악대로 349(안세온누리약국)도 Δ38 경고가 뜨지만 보간값을 그대로 쓴다.
# 그 구간의 기준번지 282~387 이 9.6m/번호로 도로명주소 부여 규칙(20m 마다 2 증가)과 맞아
# 선형보간이 ±50m 안에 들어온다. 도로 세그먼트 중심을 주는 Nominatim 결과(497m 차)보다 정확하다.
MANUAL_FIX = {
    "세명약국":      (37.382258, 126.969697, "흥안대로 313 = 평촌동 934-1 안양농수산물도매시장"),
    "평촌미라클의원": (37.392177, 126.978052, "흥안대로434번길 중심점 (도로 전체 186m)"),
    "성애약국":      (37.400156, 126.974585, "흥안대로517번길 중심점 (도로 전체 287m)"),
}


# --------------------------------------------------------------------------- PDF

def read_pdf(path: str) -> list[dict]:
    import pdfplumber

    def norm(cell) -> str:
        return re.sub(r"\s+", " ", (cell or "").replace("\n", " ")).strip()

    rows: list[dict] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for raw in table:
                    cells = [norm(c) for c in raw]
                    cells += [""] * (9 - len(cells))
                    kind, name, addr, tel = cells[0], cells[1], cells[2], cells[3]
                    if kind in SKIP_ROWS or not name or not addr:
                        continue
                    rows.append({"kind": kind, "name": name, "address": addr,
                                 "tel": tel, "hours": cells[4:8], "note": cells[8]})
    if not rows:
        raise SystemExit("PDF 에서 표를 찾지 못했습니다. 배포본 양식이 바뀌었는지 확인하세요.")
    return rows


# ----------------------------------------------------------------------- Overpass

def overpass(query: str):
    last = None
    for mirror in OVERPASS_MIRRORS:
        try:
            req = urllib.request.Request(
                mirror, data=urllib.parse.urlencode({"data": query}).encode(),
                headers={"User-Agent": "anyang-chuseok-map/1.0 (+github.com/jaystarboard)"})
            with urllib.request.urlopen(req, timeout=240) as res:
                return json.load(res)
        except Exception as exc:                      # 미러 과부하는 흔하므로 순차 폴백
            last = exc
            print(f"  overpass 실패 {mirror}: {exc}", file=sys.stderr)
            time.sleep(4)
    raise SystemExit(f"Overpass 모든 미러 실패: {last}")


def osm_addresses() -> list[dict]:
    if os.path.exists(CACHE):
        print("OSM 주소 캐시 사용:", CACHE)
        return json.load(open(CACHE, encoding="utf-8"))
    s, w, n, e = BBOX
    data = overpass(f'[out:json][timeout:180];'
                    f'nwr["addr:housenumber"]["addr:street"]({s},{w},{n},{e});out center tags;')
    points = []
    for el in data["elements"]:
        tags = el.get("tags", {})
        centre = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        if not centre:
            continue
        points.append({"street": tags["addr:street"], "hn": tags["addr:housenumber"],
                       "lat": centre["lat"], "lon": centre["lon"]})
    json.dump(points, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"OSM 주소점 {len(points)}건 수집 -> {CACHE}")
    return points


# ---------------------------------------------------------------------- geocoding

def parse_road(address: str) -> tuple[str | None, str | None]:
    """도로명주소에서 (도로명, 건물번호) 추출. '관평로 170번길' 처럼 띄어 쓴 표기도 흡수한다."""
    a = re.sub(r"\s+", " ", address).strip()
    if "동안구" not in a:
        return None, None
    a = re.sub(r"(로|길)\s+(\d+번길)", r"\1\2", a)
    m = (re.search(r"동안구\s+(\S*?(?:로|길)\d*번?길?)\s+(\d+(?:-\d+)?)", a)
         or re.search(r"동안구\s+(\S+?[로길])\s+(\d+(?:-\d+)?)", a))
    return (m.group(1), m.group(2)) if m else (None, None)


def geocode(rows: list[dict], osm: list[dict]) -> None:
    exact = defaultdict(list)
    by_street = defaultdict(list)
    for p in osm:
        exact[(p["street"], p["hn"])].append(p)
        head = re.match(r"^(\d+)", str(p["hn"]))
        if head:
            by_street[p["street"]].append((int(head.group(1)), p))
    for v in by_street.values():
        v.sort(key=lambda x: x[0])

    def centroid(cands):
        lat = statistics.median(c["lat"] for c in cands)
        lon = statistics.median(c["lon"] for c in cands)
        best = min(cands, key=lambda c: (c["lat"] - lat) ** 2 + (c["lon"] - lon) ** 2)
        return best["lat"], best["lon"]

    def interpolate(street, n):
        arr = by_street.get(street)
        if not arr:
            return None
        same = [x for x in arr if x[0] % 2 == n % 2] or arr   # 홀/짝은 도로의 반대편
        lo = [x for x in same if x[0] <= n]
        hi = [x for x in same if x[0] >= n]
        if lo and hi and lo[-1][0] != hi[0][0]:
            a, b = lo[-1], hi[0]
            t = (n - a[0]) / (b[0] - a[0])
            return (a[1]["lat"] + (b[1]["lat"] - a[1]["lat"]) * t,
                    a[1]["lon"] + (b[1]["lon"] - a[1]["lon"]) * t)
        near = lo[-1] if lo else hi[0]
        return near[1]["lat"], near[1]["lon"]

    for r in rows:
        street, hn = parse_road(r["address"])
        if not street:
            raise SystemExit(f"주소 파싱 실패: {r['name']} / {r['address']}")
        n = int(re.match(r"^(\d+)", hn).group(1))

        if r["name"] in MANUAL_FIX:
            r["lat"], r["lon"], why = MANUAL_FIX[r["name"]]
            r["acc"], r["acc_src"] = "approx", why
        elif (street, hn) in exact:
            r["lat"], r["lon"] = centroid(exact[(street, hn)])
            r["acc"], r["acc_src"] = "exact", "OSM 건물 주소 정확 일치"
        else:
            point = interpolate(street, n)
            if not point:
                raise SystemExit(f"좌표 추정 실패: {r['name']} / {street} {hn}")
            gap = min(abs(n - h) for h, _ in by_street[street])
            r["lat"], r["lon"] = point
            r["acc"] = "approx"
            r["acc_src"] = f"도로명 번호 보간 (최근접 기준번지 Δ{gap})"
            if gap > 25:
                print(f"  ⚠ 보간 간격 큼 (Δ{gap}) — MANUAL_FIX 검토 필요: {r['name']} / {street} {hn}")


# -------------------------------------------------------------------------- build

def verify(rows: list[dict]) -> None:
    """PDF 소계와 대조. 어긋나면 파싱이 깨진 것이므로 빌드를 중단한다."""
    expect_med = [44 + 1, 15 + 1, 29 + 1, 21 + 1]      # 병의원소계 + 응급실
    expect_ph = [44, 13, 30, 31]
    for i, day in enumerate(DAYS):
        med = sum(1 for r in rows if CATEGORY[r["kind"]] != "약국" and r["hours"][i])
        ph = sum(1 for r in rows if CATEGORY[r["kind"]] == "약국" and r["hours"][i])
        if (med, ph) != (expect_med[i], expect_ph[i]):
            raise SystemExit(f"소계 불일치 {day['label']}: 의료기관 {med}(기대 {expect_med[i]}), "
                             f"약국 {ph}(기대 {expect_ph[i]})")
    print("PDF 소계 검증 통과")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    rows = read_pdf(sys.argv[1])
    print(f"PDF 추출 {len(rows)}건")
    verify(rows)
    geocode(rows, osm_addresses())

    facilities = []
    ordered = sorted(rows, key=lambda r: (r["kind"] != "권역응급의료센터", r["kind"], r["name"]))
    for i, r in enumerate(ordered, start=1):
        facilities.append({
            "id": i, "cat": CATEGORY[r["kind"]], "kind": r["kind"], "name": r["name"],
            "addr": re.sub(r"\s+", " ", r["address"]).strip(), "tel": r["tel"],
            "hours": r["hours"], "note": r["note"],
            "lat": round(r["lat"], 6), "lon": round(r["lon"], 6),
            "acc": r["acc"], "accSrc": r["acc_src"],
        })

    doc = {
        "meta": {
            "title": "2026 추석 연휴 문여는 병원·약국 (안양시 동안구)",
            "source": "안양시 동안구보건소 「2026년 추석 연휴 문여는 의료기관 및 약국 현황(동안구)」",
            "sourceAsOf": "2026-09-17",
            "contacts": [
                {"label": "응급의료포털 E-Gen", "url": "https://www.e-gen.or.kr"},
                {"label": "보건복지부 콜센터", "tel": "129"},
                {"label": "구급상황관리센터", "tel": "119"},
                {"label": "동안구보건소", "tel": "031-8045-4472"},
            ],
            "disclaimer": "기관 사정으로 운영시간이 변동될 수 있으니 방문 전 반드시 전화 확인하세요.",
            "days": DAYS,
        },
        "facilities": facilities,
    }
    json.dump(doc, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(facilities)}건 -> {OUT}")
    print("분류:", dict(Counter(f['cat'] for f in facilities)),
          "| 좌표 정확도:", dict(Counter(f['acc'] for f in facilities)))


if __name__ == "__main__":
    main()
