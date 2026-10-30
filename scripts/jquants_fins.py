"""J-Quants（JPX 公式・無料プラン）から決算短信のサマリー（財務情報）を日付ごとに取得して、fins ブランチに貯める。

無料プランは「直近12週間は取れない」「1分に5回まで」。2年分（約490営業日）を1日1回ずつ取るので、初回は約2時間かかる。
取得済みの日付は飛ばすので、途中で止まっても続きから再開できる。

  fins/YYYY-MM.json = {"items": [...], "fetched": [取得済みの日付]}
  items は必要な項目だけ（DiscDate, DiscTime, Code, DocType, CurPerType, CurFYEn, Sales, OP, OdP, NP, EPS, BPS, Eq, TA,
                          FSales, FOP, FOdP, FNP, FEPS, NxFSales, NxFOP, NxFNp, NxFEPS, FDivAnn, NxFDivAnn, DivAnn）

使い方: JQUANTS_API_KEY=... python scripts/jquants_fins.py --repo fins --years 2 [--max-minutes 300]
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.jquants.com/v2"
KEEP = ["DiscDate", "DiscTime", "Code", "DocType", "CurPerType", "CurFYEn", "Sales", "OP", "OdP", "NP", "EPS", "BPS", "Eq", "TA",
        "FSales", "FOP", "FOdP", "FNP", "FEPS", "NxFSales", "NxFOP", "NxFOdP", "NxFNp", "NxFEPS", "FDivAnn", "NxFDivAnn", "DivAnn"]
INTERVAL = 13.0  # 1分に5回まで → 余裕をもって13秒おき


def get(path, params, key):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"x-api-key": key, "User-Agent": "kabuka-hack/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429:  # 回数制限 → 待って再試行
                time.sleep(60)
                continue
            if e.code in (400, 404):
                return {"data": [], "error": f"{e.code} {body}"}
            if e.code in (401, 403):
                sys.exit(f"認証エラー（{e.code}）：APIキーを確認してください。{body}")
            time.sleep(10 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            print(f"  再試行 {attempt}: {e}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    return {"data": [], "error": "retries"}


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"items": [], "fetched": []}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="fins")
    ap.add_argument("--years", type=float, default=2.0)
    ap.add_argument("--max-minutes", type=float, default=300)
    ap.add_argument("--probe", action="store_true", help="1日分だけ取って項目を表示（確認用）")
    args = ap.parse_args()
    key = os.environ.get("JQUANTS_API_KEY", "").strip()
    if not key:
        sys.exit("JQUANTS_API_KEY がありません（GitHub の Settings → Secrets → Actions に登録してください）")
    os.makedirs(args.repo, exist_ok=True)
    today = dt.date.today()
    end = today - dt.timedelta(weeks=12) - dt.timedelta(days=3)  # 無料プランは直近12週間が取れない
    start = today - dt.timedelta(days=int(365 * args.years))
    if args.probe:
        d = end - dt.timedelta(days=30)
        while d.weekday() >= 5:
            d -= dt.timedelta(days=1)
        js = get("/fins/summary", {"date": d.isoformat()}, key)
        rows = js.get("data", [])
        print(f"PROBE {d} {len(rows)}件 error={js.get('error')} keys={list(rows[0].keys())[:60] if rows else None}")
        if rows:
            print("PROBE 例 " + json.dumps({k: rows[0].get(k) for k in KEEP}, ensure_ascii=False))
        return
    t0, n_req, n_days, n_rows = time.time(), 0, 0, 0
    months = {}
    d = end
    while d >= start:  # 新しい日付から順に（途中で止まっても新しい分が先に揃う）
        if d.weekday() < 5:
            ym = d.strftime("%Y-%m")
            doc = months.setdefault(ym, load(os.path.join(args.repo, f"{ym}.json")))
            if d.isoformat() not in doc["fetched"]:
                if (time.time() - t0) / 60 > args.max_minutes:
                    print("時間切れ。次回この続きから再開します")
                    break
                rows, pkey = [], None
                while True:
                    params = {"date": d.isoformat()}
                    if pkey:
                        params["pagination_key"] = pkey
                    tq = time.time()
                    js = get("/fins/summary", params, key)
                    n_req += 1
                    rows += js.get("data", [])
                    pkey = js.get("pagination_key")
                    time.sleep(max(0.0, INTERVAL - (time.time() - tq)))
                    if not pkey:
                        break
                doc["items"] = [x for x in doc["items"] if x.get("DiscDate") != d.isoformat()] + [{k: r.get(k, "") for k in KEEP} for r in rows]
                doc["fetched"].append(d.isoformat())
                n_days += 1
                n_rows += len(rows)
                if n_days % 20 == 0:
                    for ym2, doc2 in months.items():
                        with open(os.path.join(args.repo, f"{ym2}.json"), "w", encoding="utf-8") as f:
                            json.dump(doc2, f, ensure_ascii=False, separators=(",", ":"))
                    print(f"  {d} まで {n_days}日・{n_rows}件（{(time.time() - t0) / 60:.0f}分）", flush=True)
        d -= dt.timedelta(days=1)
    for ym, doc in months.items():
        doc["fetched"] = sorted(set(doc["fetched"]))
        with open(os.path.join(args.repo, f"{ym}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    total_days = sum(len(load(os.path.join(args.repo, f))["fetched"]) for f in os.listdir(args.repo) if f.endswith(".json"))
    print(f"今回 {n_days}日分・{n_rows}件（{n_req}回）。取得済み合計 {total_days}日（{start}〜{end}）")


if __name__ == "__main__":
    main()
