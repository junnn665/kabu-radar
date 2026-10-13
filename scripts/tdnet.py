"""TDnet（東証の適時開示）を毎日集めて、tdnet ブランチに月ごとのファイルで貯める。

TDnet の一覧ページは過去約1か月分しか見られないので、毎日取りに行って貯めておく（数か月たまったらAIの入力として検証する）。
  tdnet ブランチ: YYYY-MM.json = {"items": [[日付, 時刻, コード, 会社名, 表題, 分類, PDFファイル名], ...], "fetched": [取得済みの日付...]}

分類（表題のキーワードから）:
  up=業績予想の上方修正 down=下方修正 buyback=自己株式の取得 divup=増配・記念配当 divdown=減配・無配
  split=株式分割 tob=公開買付 earnings=決算短信 other=その他

使い方:
  python scripts/tdnet.py --repo tdnet --days 31          # 直近31日分を取得して tdnet/ に保存
  python scripts/tdnet.py --repo tdnet --export raw/tdnet.json --since-days 45   # サイト用に直近分を書き出す
"""
import argparse
import datetime as dt
import glob
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

JST = dt.timezone(dt.timedelta(hours=9))
BASE = "https://www.release.tdnet.info/inbs/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; kabuka-hack/1.0)"}
ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
CELL = re.compile(r'<td[^>]*class="[^"]*(kjTime|kjCode|kjName|kjTitle)[^"]*"[^>]*>(.*?)</td>', re.S)
HREF = re.compile(r'href="([^"]+\.pdf)"')
TAG = re.compile(r"<[^>]+>")


def classify(title):
    t = title
    if "公開買付" in t:
        return "tob"
    if "自己株式" in t and ("取得" in t or "買付" in t) and not any(w in t for w in ("結果", "終了", "状況", "消却")):
        return "buyback"
    if "株式分割" in t:
        return "split"
    if "上方修正" in t or ("業績予想" in t and "修正" in t and "上回" in t):
        return "up"
    if "下方修正" in t or ("業績予想" in t and "修正" in t and "下回" in t):
        return "down"
    if "増配" in t or "記念配当" in t or "特別配当" in t:
        return "divup"
    if "減配" in t or "無配" in t:
        return "divdown"
    if "決算短信" in t:
        return "earnings"
    if "業績予想" in t and "修正" in t:
        return "revise"
    return "other"


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def fetch_day(day):
    """その日の開示を全部（1ページ100件）。ページが無くなるまで"""
    items = []
    for page in range(1, 40):
        url = f"{BASE}I_list_{page:03d}_{day.strftime('%Y%m%d')}.html"
        try:
            body = get(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            raise
        rows = 0
        for tr in ROW.findall(body):
            cells = {k: v for k, v in CELL.findall(tr)}
            if "kjCode" not in cells:
                continue
            rows += 1
            code = TAG.sub("", cells["kjCode"]).strip()
            code = code[:4]  # 5桁目はチェック用の0
            title = html.unescape(TAG.sub("", cells.get("kjTitle", ""))).strip()
            m = HREF.search(cells.get("kjTitle", ""))
            items.append([day.isoformat(), TAG.sub("", cells.get("kjTime", "")).strip(), code,
                          html.unescape(TAG.sub("", cells.get("kjName", ""))).strip(), title, classify(title), m.group(1) if m else None])
        if rows < 100:
            break
        time.sleep(0.5)
    return items


def month_path(repo, ym):
    return os.path.join(repo, f"{ym}.json")


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def collect(repo, days):
    today = dt.datetime.now(JST).date()
    os.makedirs(repo, exist_ok=True)
    months = {}
    total, new_days = 0, 0
    for i in range(days, -1, -1):
        day = today - dt.timedelta(days=i)
        if day.weekday() >= 5:
            continue
        ym = day.strftime("%Y-%m")
        doc = months.setdefault(ym, load(month_path(repo, ym), {"items": [], "fetched": []}))
        # 取得済みの日は飛ばす（今日と昨日は追記があるので毎回取り直す）
        if day.isoformat() in doc["fetched"] and i > 1:
            continue
        try:
            items = fetch_day(day)
        except Exception as e:  # noqa: BLE001
            print(f"{day}: {type(e).__name__} {e}", file=sys.stderr)
            continue
        doc["items"] = [x for x in doc["items"] if x[0] != day.isoformat()] + items
        if day.isoformat() not in doc["fetched"] and (items or i > 1):
            doc["fetched"].append(day.isoformat())
        total += len(items)
        new_days += 1
        time.sleep(0.5)
    for ym, doc in months.items():
        doc["items"].sort(key=lambda x: (x[0], x[1]))
        doc["fetched"].sort()
        with open(month_path(repo, ym), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    cats = {}
    for doc in months.values():
        for x in doc["items"]:
            cats[x[5]] = cats.get(x[5], 0) + 1
    print(f"{new_days}日分を取得（{total}件）。分類: {json.dumps(cats, ensure_ascii=False)}")


def export(repo, out, since_days):
    """サイト用：直近の開示を銘柄ごとに（「その他」は件数が多いので除く）"""
    since = (dt.datetime.now(JST).date() - dt.timedelta(days=since_days)).isoformat()
    by = {}
    for path in sorted(glob.glob(os.path.join(repo, "*.json"))):
        for d, tm, code, _name, title, cat, pdf in load(path, {}).get("items", []):
            if d < since or cat == "other":
                continue
            by.setdefault(code, []).append([d, tm, cat, title, pdf])
    for v in by.values():
        v.sort(key=lambda x: (x[0], x[1]), reverse=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"since": since, "base": BASE, "items": by}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(by)}銘柄の開示を書き出しました")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="tdnet")
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--export")
    ap.add_argument("--since-days", type=int, default=45)
    args = ap.parse_args()
    if args.export:
        export(args.repo, args.export, args.since_days)
    else:
        collect(args.repo, args.days)


if __name__ == "__main__":
    main()
