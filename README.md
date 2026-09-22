# 추석 연휴 문여는 병원·약국 지도 — 안양시 전체

2026년 추석 연휴(9.24 목 ~ 9.27 일) 안양시 **동안구·만안구**에서 문 여는 의료기관·약국을 날짜별로 지도에 표시합니다.
경기도 전역의 응급의료기관과 달빛어린이병원도 레이어로 함께 볼 수 있습니다.

**https://jaystarboard.github.io/anyang-chuseok-map/**

## 무엇이 들어 있나

| 데이터셋 | 건수 | 구분 | 마커 |
|---|---|---|---|
| 안양시 연휴 진료 | 155 (동안구 99 · 만안구 56) | 날짜별 운영시간 | 응 · 병 · 의 · 치 · 한 · 약 |
| 경기 응급의료기관 | 73 | 권역구분명 (권역센터 9 · 지역센터 33 · 지역기관 31) | 권 · 지 · 기 |
| 경기 달빛어린이병원 | 45 | 야간·휴일 소아 진료 | 달 |

경기도 두 레이어는 24시간(응급) 또는 휴일 운영이라 날짜 탭과 무관하며, 기본값은 꺼짐입니다.
필터 칩에서 켜면 지도에 함께 표시됩니다.

## 화면

- **지도가 화면 대부분** — 헤더와 날짜 탭만 고정이고 검색·필터·버튼은 모두 지도 위 오버레이입니다.
- **클러스터링** — 가까운 지점은 하나로 묶어 개수를 보여 주고, 누르면 확대되며 풀립니다. 같은 건물에 여러 곳이 있으면 마커에 `N` 배지가 붙습니다.
- **상세** — PC 는 마커에 붙는 미니 팝업, 모바일은 하단 시트. 4일치 운영시간, 전화 걸기, 카카오맵 열기.
- **필터** — 응급실·병원·의원·약국이 항상 보이고 나머지는 `+N` 으로 접힙니다.
- **내 위치** — 우측 하단 버튼. 켜면 목록이 가까운 순으로 정렬됩니다.

## 지도 엔진 두 벌 (카카오 → OSM 자동 전환)

카카오 JS 키는 도메인 제한과 일일 무료 쿼터가 있습니다. 둘 중 하나라도 걸리면 `dapi.kakao.com` 이
`sdk.js` 에 **401** 을 주고 `window.kakao` 가 아예 정의되지 않습니다.
[`assets/map.js`](assets/map.js) 는 이를 감지해 **OpenLayers + OpenStreetMap** 을 내려받아
같은 인터페이스로 갈아끼웁니다. UI 코드는 어느 엔진인지 모릅니다.

```
MapEngine.create(el, opts) -> { name, label, on, relayout, getZoom, setZoom, zoomAround,
                                panTo, setCenter, fitBounds, addOverlay, removeOverlay,
                                project, unproject }
```

좌표는 전부 `[lat, lon]`, 줌은 값이 클수록 확대(OL 기준)로 통일했습니다.
카카오의 `level` 은 반대 방향이라 어댑터 안에서 `zoom = 20 - level` 로 환산합니다.
마커·팝업은 DOM 요소를 그대로 넘기므로 CSS 한 벌로 양쪽에서 똑같이 보입니다.

현재 어느 엔진으로 보고 있는지는 안내(ⓘ) 모달에 표시됩니다.

## 좌표

`tools/coords.json` 에 **카카오 지오코딩 결과 273건**을 구워 두고 런타임에는 지오코딩하지 않습니다.
주소검색 227 / 장소검색 46 / 실패 0 (달빛어린이병원 시트에는 주소 컬럼이 없어 기관명 장소검색을 씁니다).

카카오 JS 키는 도메인 제한이 있어 등록된 도메인에서만 동작합니다. 그래서 좌표 생성은
[`tools/geocode.html`](tools/geocode.html) 을 **GitHub Pages 에 올린 상태에서** 실행합니다.

## 데이터 다시 만들기

```bash
pip install openpyxl
python tools/make_addresses.py "<안양시 배포 XLSX>"   # tools/addresses.json
# https://jaystarboard.github.io/anyang-chuseok-map/tools/geocode.html 에서 [실행] -> 결과를 tools/coords.json 에 저장
python tools/build_dataset.py "<안양시 배포 XLSX>"    # data/facilities.json
```

빌드는 추출 결과를 **시트가 스스로 밝힌 소계와 대조**하고 어긋나면 중단합니다
(동안구 의료기관 51/45·16·30·22, 약국 48/45·13·31·31 · 만안구 의료기관 26/20·7·15·18, 약국 30/27·13·23·21).

### 원본 양식의 함정

- 동안구·만안구 시트는 열 수와 헤더 표기(`9.24.(목)` vs `9. 24.(목)`)가 다릅니다.
- 만안구 일부 주소는 `삼덕로 9` 처럼 시·구 없이 도로명만 적혀 있습니다.
- 달빛어린이병원은 한 기관이 2행(평일 / 토·일·공)에 걸쳐 있고, 한 줄만 있는 곳도 있어
  행 위치가 아니라 `(평일)` / `(토/일/공)` **접두어로 분류**해야 합니다.
- 달빛 시트의 시군 칸은 여러 행에 걸쳐 **병합**돼 있어 병합 범위를 풀어 읽어야 합니다.
- 9.24~9.27 은 모두 공휴일·일요일이라 달빛어린이병원은 (토/일/공) 시간을 적용했습니다.
  휴일 시간이 표기되지 않은 3곳은 화면에 그렇게 표시하고 전화 확인을 안내합니다.

## 구조

```
index.html              마크업
assets/map.js           지도 엔진 어댑터 (카카오 / OpenLayers+OSM 자동 전환)
assets/app.js           상태·필터·클러스터·시트·팝업 (엔진 비의존)
assets/styles.css       라이트 테마
data/facilities.json    좌표가 포함된 명단 (빌드 산출물)
tools/build_dataset.py  XLSX -> JSON
tools/make_addresses.py XLSX -> 지오코딩 입력
tools/geocode.html      카카오 지오코딩 하네스 (등록 도메인에서 실행)
tools/coords.json       지오코딩 결과 (빌드 입력)
```

## 출처와 면책

- 명단: 안양시보건소 「2026년 추석 연휴 문여는 의료기관 및 약국 현황」 (2026-09-18 기준)
  · [원문 공지](https://www.anyang.go.kr/health/selectBbsNttView.do?key=1369&bbsNo=108&nttNo=458257)
- 지도: 카카오맵 / © OpenStreetMap 기여자
- **기관 사정으로 운영시간이 변동될 수 있습니다. 방문 전 반드시 전화로 확인하세요.**
- 전국 현황: [응급의료포털 E-Gen](https://www.e-gen.or.kr) · 보건복지부 콜센터 129 · 구급상황관리센터 119
- 오류 제보·문의: jaystarboard@gmail.com
