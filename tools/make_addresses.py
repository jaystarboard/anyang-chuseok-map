#!/usr/bin/env python3
"""배포 XLSX -> tools/addresses.json (카카오 지오코딩 하네스 입력).

달빛어린이병원 시트에는 주소 컬럼이 없어 기관명 장소검색(keyword)으로 좌표를 잡는다.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_dataset as B                                            # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def road_query(gu: str, address: str) -> str:
    """'경기도 안양시 <구> <도로명> <번호>' 만 남긴다 (동/호가 붙으면 주소검색이 실패한다)."""
    a = re.sub(r"\s+", " ", address).strip()
    a = re.sub(r"(로|길)\s+(\d+번길)", r"\1\2", a)
    m = (re.search(r"(?:동안구|만안구)\s+(\S*?(?:로|길)\d*번?길?)\s+(\d+(?:-\d+)?)", a)
         or re.search(r"(?:동안구|만안구)\s+(\S+?[로길])\s+(\d+(?:-\d+)?)", a)
         or re.search(r"^(\S*?(?:로|길)\d*번?길?)\s+(\d+(?:-\d+)?)", a))
    if not m:
        raise SystemExit(f"도로명 파싱 실패: {gu} / {address!r}")
    return f"경기도 안양시 {gu} {m.group(1)} {m.group(2)}"


def main() -> None:
    import openpyxl
    wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
    items = []

    for gu in B.SHEETS:
        rows, _ = B.read_sheet(wb[gu], gu)
        for r in rows:
            items.append({"key": f"{gu}|{r['name']}", "name": r["name"], "gu": gu,
                          "mode": "address", "query": road_query(gu, r["address"])})

    for r in B.read_er_sheet(wb):
        items.append({"key": f"er|{r['gu']}|{r['name']}", "name": r["name"], "gu": r["gu"],
                      "mode": "address", "query": re.sub(r"\s+", " ", r["address"]).strip()})

    for r in B.read_moon_sheet(wb):
        items.append({"key": f"moon|{r['gu']}|{r['name']}", "name": r["name"], "gu": r["gu"],
                      "mode": "keyword", "query": f"{r['gu']} {r['name']}"})

    out = os.path.join(ROOT, "tools", "addresses.json")
    json.dump(items, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(items)}건 -> {out}")


if __name__ == "__main__":
    main()
