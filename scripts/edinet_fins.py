"""EDINET（金融庁・無料）から、有価証券報告書・四半期報告書・半期報告書の「主要な経営指標」を取って edinet ブランチに貯める。

目的：J-Quants 無料プラン（約2年）より前の決算（2019年〜）を AI の学習に使う。
  - 書類一覧 API（日付ごと）→ 対象の書類（有報120・四半期140・半期160、上場企業）を選ぶ
  - 書類取得 API（type=5：XBRL を CSV にしたもの）→ 売上・営業利益・経常利益・純利益・EPS・BPS・配当 と前年の値
  - 提出日時（submitDateTime）を「いつから分かったか」として記録（未来の情報を使わないため）
EDINET は短時間に大量に取ると切断されるので、1回ごとに数秒あける。取得済みは飛ばすので、何回かに分けて続きから取れる。

  edinet/lists/YYYY-MM.json = {日付: [対象の書類...]}
  edinet/data/YYYY.json     = {docID: 抜き出した数字}

使い方: EDINET_API_KEY=... python scripts/edinet_fins.py --repo edinet --start 2019-01-01 --end 2024-10-29 --codes codes.txt [--probe]
"""
import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API = "https://api.edinet-fsa.go.jp/api/v2"
DOC_TYPES = {"120": "FY", "140": "Q", "160": "HY"}  # 有価証券報告書・四半期報告書・半期報告書
INTERVAL = 3.2

# 取り出す項目（主要な経営指標等の要約 → 無ければ損益計算書）。値は「当期」「前期」
ITEMS = {
    "sales": ["jpcrp_cor:NetSalesSummaryOfBusinessResults", "jpcrp_cor:OperatingRevenue1SummaryOfBusinessResults",
              "jpcrp_cor:RevenueIFRSSummaryOfBusinessResults", "jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults",
              "jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults", "jppfs_cor:NetSales"],
    "op": ["jppfs_cor:OperatingIncome", "jpcrp_cor:OperatingProfitLossIFRSSummaryOfBusinessResults", "jpigp_cor:OperatingProfitLossIFRS"],
    "ord": ["jpcrp_cor:OrdinaryIncomeLossSummaryOfBusinessResults", "jppfs_cor:OrdinaryIncome"],
    "np": ["jpcrp_cor:ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults", "jpcrp_cor:NetIncomeLossSummaryOfBusinessResults",
           "jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults"],
    "eps": ["jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults", "jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults"],
    "bps": ["jpcrp_cor:NetAssetsPerShareSummaryOfBusinessResults", "jpcrp_cor:EquityAttributableToOwnersOfParentPerShareIFRSSummaryOfBusinessResults"],
    "dps": ["jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults"],
}


def get(path, params, key, binary=False):
    params = dict(params, **{"Subscription-Key": key})
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "kabuka-hack/1.0"}), timeout=60) as r:
                b = r.read()
                ctype = r.headers.get("Content-Type", "")
            if binary:
                if "json" in ctype:  # エラーは JSON で返る
                    return None
                return b
            return json.loads(b.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                sys.exit(f"認証エラー（{e.code}）：APIキーを確認してください")
            if e.code == 404:
                return None
            time.sleep(10 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            print(f"  再試行 {attempt}: {type(e).__name__} {e}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    return None


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def parse_csv_zip(b):
    """type=5 の zip（XBRL を CSV にしたもの。UTF-16・タブ区切り）から、当期・前期の値を取り出す"""
    zf = zipfile.ZipFile(io.BytesIO(b))
    rows = []
    for n in zf.namelist():
        if n.endswith(".csv") and ("jpcrp" in n or "jpigp" in n or "jppfs" in n):
            text = zf.read(n).decode("utf-16", "replace")
            rows += list(csv.reader(io.StringIO(text), delimiter="\t"))
    vals = {}
    for r in rows:
        if len(r) < 9:
            continue
        el, ctx, val = r[0], r[2], r[8]
        v = val.replace(",", "").strip()
        if not re.fullmatch(r"-?\d+(\.\d+)?", v):
            continue
        vals[(el, ctx)] = float(v)
    out = {}
    # 連結を優先、無ければ個別（_NonConsolidatedMember）
    for suffix, cons in (("", True), ("_NonConsolidatedMember", False)):
        for cur, prev in (("CurrentYearDuration", "Prior1YearDuration"), ("CurrentYTDDuration", "Prior1YTDDuration"),
                          ("InterimDuration", "Prior1InterimDuration")):
            got = {}
            for k, els in ITEMS.items():
                if k == "bps":
                    continue
                for el in els:
                    c = vals.get((el, cur + suffix))
                    if c is not None:
                        got[k] = c
                        p = vals.get((el, prev + suffix))
                        if p is not None:
                            got[k + "_prev"] = p
                        break
            if got.get("np") is not None or got.get("ord") is not None or got.get("op") is not None:
                out = {"cons": cons, "per": cur, **got}
                for el in ITEMS["bps"]:
                    for inst in ("CurrentYearInstant", "CurrentQuarterInstant", "InterimInstant"):
                        if (el, inst + suffix) in vals:
                            out["bps"] = vals[(el, inst + suffix)]
                            break
                    if "bps" in out:
                        break
                return out
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="edinet")
    ap.add_argument("--start", default="2019-01-01")
    ap.add_argument("--end", default="2024-10-29")
    ap.add_argument("--codes", help="対象の銘柄コード（1行に1つ）。省略すると全部")
    ap.add_argument("--max-minutes", type=float, default=320)
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()
    key = os.environ.get("EDINET_API_KEY", "").strip()
    if not key:
        sys.exit("EDINET_API_KEY がありません（GitHub の Settings → Secrets → Actions に登録してください）")
    codes = None
    if args.codes and os.path.exists(args.codes):
        codes = {ln.strip()[:4] for ln in open(args.codes) if ln.strip()}
    t0 = time.time()
    elapsed = lambda: (time.time() - t0) / 60  # noqa: E731

    if args.probe:
        for d in ("2024-06-27", "2021-06-29", "2019-06-27"):
            js = get("/documents.json", {"date": d, "type": 2}, key) or {}
            res = [x for x in js.get("results", []) if x.get("docTypeCode") in DOC_TYPES and x.get("secCode")]
            print(f"PROBE {d}: 書類 {len(js.get('results', []))}件・対象 {len(res)}件 metadata={js.get('metadata', {}).get('status')}")
            if res:
                x = res[0]
                print("PROBE 例 " + json.dumps({k: x.get(k) for k in ("docID", "secCode", "filerName", "docTypeCode", "periodStart", "periodEnd", "submitDateTime", "csvFlag")}, ensure_ascii=False))
                time.sleep(INTERVAL)
                b = get(f"/documents/{x['docID']}", {"type": 5}, key, binary=True)
                if b:
                    print("PROBE 抜き出し " + json.dumps(parse_csv_zip(b), ensure_ascii=False))
                    zf = zipfile.ZipFile(io.BytesIO(b))
                    print("PROBE files " + " ".join(zf.namelist())[:400])
                    els = set()
                    for n in zf.namelist():
                        if n.endswith(".csv") and "jpcrp" in n:
                            for r in csv.reader(io.StringIO(zf.read(n).decode("utf-16", "replace")), delimiter="\t"):
                                if r and "SummaryOfBusinessResults" in r[0]:
                                    els.add(f"{r[0]}@{r[2]}")
                    print("PROBE 経営指標 " + " ".join(sorted(els))[:2500])
            time.sleep(INTERVAL)
        return

    # 1) 書類一覧（日付ごと）
    start, end = dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end)
    d, n_list = end, 0
    while d >= start and elapsed() < args.max_minutes * 0.3:
        ym = d.strftime("%Y-%m")
        path = os.path.join(args.repo, "lists", f"{ym}.json")
        lists = load(path, {})
        if d.isoformat() not in lists:
            js = get("/documents.json", {"date": d.isoformat(), "type": 2}, key)
            if js is not None:
                lists[d.isoformat()] = [{k: x.get(k) for k in ("docID", "secCode", "docTypeCode", "periodStart", "periodEnd", "submitDateTime")}
                                        for x in js.get("results", []) if x.get("docTypeCode") in DOC_TYPES and x.get("secCode") and x.get("csvFlag") == "1"]
                save(path, lists)
                n_list += 1
            time.sleep(INTERVAL)
        d -= dt.timedelta(days=1)
    # 2) 書類ごとの数字（新しい順）
    docs = []
    for f in sorted(os.listdir(os.path.join(args.repo, "lists")), reverse=True) if os.path.isdir(os.path.join(args.repo, "lists")) else []:
        for day, xs in load(os.path.join(args.repo, "lists", f), {}).items():
            for x in xs:
                if codes is None or x["secCode"][:4] in codes:
                    docs.append(x)
    docs.sort(key=lambda x: x["submitDateTime"] or "", reverse=True)
    done_cache, n_doc, n_ok = {}, 0, 0
    for x in docs:
        if elapsed() > args.max_minutes:
            break
        year = (x["submitDateTime"] or "0000")[:4]
        if year not in done_cache:
            done_cache[year] = load(os.path.join(args.repo, "data", f"{year}.json"), {})
        data = done_cache[year]
        if x["docID"] in data:
            continue
        b = get(f"/documents/{x['docID']}", {"type": 5}, key, binary=True)
        rec = {}
        if b:
            try:
                rec = parse_csv_zip(b)
            except Exception as e:  # noqa: BLE001
                print(f"  解析失敗 {x['docID']}: {e}", file=sys.stderr)
        data[x["docID"]] = {"code": x["secCode"][:4], "type": DOC_TYPES[x["docTypeCode"]], "submit": x["submitDateTime"], "periodEnd": x["periodEnd"], **rec}
        n_doc += 1
        n_ok += bool(rec)
        if n_doc % 200 == 0:
            for y, dd in done_cache.items():
                save(os.path.join(args.repo, "data", f"{y}.json"), dd)
            print(f"  {n_doc}件（読み取れた {n_ok}件・{elapsed():.0f}分）", flush=True)
        time.sleep(INTERVAL)
    for y, dd in done_cache.items():
        save(os.path.join(args.repo, "data", f"{y}.json"), dd)
    total = sum(len(load(os.path.join(args.repo, "data", f), {})) for f in os.listdir(os.path.join(args.repo, "data"))) if os.path.isdir(os.path.join(args.repo, "data")) else 0
    remaining = sum(1 for x in docs if x["docID"] not in done_cache.get((x["submitDateTime"] or "0000")[:4], {}))
    print(f"一覧 {n_list}日・書類 {n_doc}件（読み取れた {n_ok}件）。累計 {total}件・残り約 {remaining}件")
    if remaining:
        print("CONTINUE")


if __name__ == "__main__":
    main()
