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
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

JST = dt.timezone(dt.timedelta(hours=9))
BASE = "https://www.release.tdnet.info/inbs/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; kabuka-hack/1.0)"}
ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
CELL = re.compile(r'<td[^>]*class="[^"]*(kjTime|kjCode|kjName|kjTitle)[^"]*"[^>]*>(.*?)</td>', re.S)
HREF = re.compile(r'href="([^"]+\.pdf)"')
ZIPREF = re.compile(r'href="([^"]+\.zip)"')
FACT = re.compile(r"<ix:nonFraction([^>]*)>(.*?)</ix:nonFraction>", re.S)
ATTR = re.compile(r'([\w:]+)="([^"]*)"')
CTX = re.compile(r"^(\w+?Duration)_(Consolidated|NonConsolidated)Member_(Previous|Current)Member_(Forecast|Result|Upper|Lower)Member$")
PERIODS = [("CurrentYearDuration", "通期"), ("CurrentAccumulatedQ2Duration", "中間"), ("CurrentAccumulatedQ3Duration", "第3四半期累計"),
           ("CurrentAccumulatedQ1Duration", "第1四半期")]
METRICS = [("OperatingIncome", "営業利益"), ("OrdinaryIncome", "経常利益"), ("ProfitAttributableToOwnersOfParent", "純利益"),
           ("NetIncome", "純利益"), ("NetSales", "売上高"), ("OperatingRevenues", "営業収益"), ("OrdinaryRevenues", "経常収益")]
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


def parse_revision(htm):
    """業績予想の修正（tse-rvfc）の XBRL から「前回予想→今回予想」と変化率を取り出す"""
    vals = {}
    for attrs, text in FACT.findall(htm):
        a = dict(ATTR.findall(attrs))
        m = CTX.match(a.get("contextRef", ""))
        t = TAG.sub("", text).replace(",", "").strip()
        if not m or not re.fullmatch(r"-?\d+(\.\d+)?", t):
            continue
        v = float(t) * (-1 if a.get("sign") == "-" else 1)
        vals[(a.get("name", "").split(":")[-1],) + m.groups()] = v

    def pick(metric, period, cons, which):
        f = vals.get((metric, period, cons, which, "Forecast"))
        if f is None and which == "Current":
            f = vals.get((metric, period, cons, which, "Result"))
        if f is None:
            lo, hi = vals.get((metric, period, cons, which, "Lower")), vals.get((metric, period, cons, which, "Upper"))
            if lo is not None and hi is not None:
                f = (lo + hi) / 2
        return f

    for period, plabel in PERIODS:
        for cons in ("Consolidated", "NonConsolidated"):
            found = None
            for metric, mlabel in METRICS:
                prev, cur = pick(metric, period, cons, "Previous"), pick(metric, period, cons, "Current")
                if cur is None:
                    continue
                if prev is not None and prev != 0:
                    found = {"p": plabel, "m": mlabel, "prev": prev, "cur": cur, "pct": round((cur - prev) / abs(prev), 4)}
                    break
                found = found or {"p": plabel, "m": mlabel, "prev": prev, "cur": cur, "pct": None}
            if found:
                sp, sc = pick("NetSales", period, cons, "Previous"), pick("NetSales", period, cons, "Current")
                if sp and sc is not None:
                    found["sales"] = round((sc - sp) / abs(sp), 4)
                return found
    return None


def fetch_revision(zname):
    try:
        req = urllib.request.Request(BASE + zname, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            zf = zipfile.ZipFile(io.BytesIO(r.read()))
        for n in zf.namelist():
            if "rvfc" in n and n.endswith("ixbrl.htm"):
                return parse_revision(zf.read(n).decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"XBRL {zname}: {type(e).__name__} {e}", file=sys.stderr)
    return None


def add_revisions(items):
    """業績予想の修正には XBRL の数字を付け、上方／下方を数字で決め直す"""
    n = 0
    for x in items:
        if x[5] in ("up", "down", "revise") and len(x) > 7 and x[7] and "修正" in x[4]:
            rev = fetch_revision(x[7])
            time.sleep(0.3)
            while len(x) < 9:
                x.append(None)
            x[8] = rev
            if rev and rev.get("pct") is not None and rev["pct"] != 0:
                x[5] = "up" if rev["pct"] > 0 else "down"
                n += 1
    return n


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
            z = ZIPREF.search(tr)
            items.append([day.isoformat(), TAG.sub("", cells.get("kjTime", "")).strip(), code,
                          html.unescape(TAG.sub("", cells.get("kjName", ""))).strip(), title, classify(title), m.group(1) if m else None,
                          z.group(1) if z else None])
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


def collect(repo, days, refresh=False):
    today = dt.datetime.now(JST).date()
    os.makedirs(repo, exist_ok=True)
    months = {}
    total, new_days, revs = 0, 0, 0
    for i in range(days, -1, -1):
        day = today - dt.timedelta(days=i)
        if day.weekday() >= 5:
            continue
        ym = day.strftime("%Y-%m")
        doc = months.setdefault(ym, load(month_path(repo, ym), {"items": [], "fetched": []}))
        # 取得済みの日は飛ばす（今日と昨日は追記があるので毎回取り直す）
        if day.isoformat() in doc["fetched"] and i > 1 and not refresh:
            continue
        try:
            items = fetch_day(day)
            revised = add_revisions(items)
        except Exception as e:  # noqa: BLE001
            print(f"{day}: {type(e).__name__} {e}", file=sys.stderr)
            continue
        doc["items"] = [x for x in doc["items"] if x[0] != day.isoformat()] + items
        if day.isoformat() not in doc["fetched"] and (items or i > 1):
            doc["fetched"].append(day.isoformat())
        total += len(items)
        revs += revised
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
    print(f"{new_days}日分を取得（{total}件・業績修正の数字 {revs}件）。分類: {json.dumps(cats, ensure_ascii=False)}")


def export(repo, out, since_days):
    """サイト用：直近の開示を銘柄ごとに（「その他」は件数が多いので除く）"""
    since = (dt.datetime.now(JST).date() - dt.timedelta(days=since_days)).isoformat()
    by = {}
    for path in sorted(glob.glob(os.path.join(repo, "*.json"))):
        for x in load(path, {}).get("items", []):
            d, tm, code, _name, title, cat, pdf = x[:7]
            if d < since or cat == "other":
                continue
            by.setdefault(code, []).append([d, tm, cat, title, pdf, x[8] if len(x) > 8 else None])
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
    ap.add_argument("--refresh", action="store_true", help="取得済みの日も取り直す（業績修正の数字の後付け用）")
    args = ap.parse_args()
    if args.export:
        export(args.repo, args.export, args.since_days)
    else:
        collect(args.repo, args.days, args.refresh)


if __name__ == "__main__":
    main()
