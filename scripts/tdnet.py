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
    htm = re.sub(r"<ix:nonFraction[^>]*/>", "", htm)  # 値の無いタグ（xsi:nil）は自己終了なので先に除く
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


PROFIT = [("OperatingIncome", "営業利益"), ("OrdinaryIncome", "経常利益"), ("ProfitAttributableToOwnersOfParent", "純利益"), ("NetIncome", "純利益")]
SALES = [("NetSales", "売上高"), ("OperatingRevenues", "営業収益"), ("OrdinaryRevenues", "経常収益"), ("NetSalesOfCompletedConstructionContracts", "売上高")]


def _facts(htm):
    """ix:nonFraction の値を {(項目, 期間, 連結/単体, 実績/予想): 値}"""
    htm = re.sub(r"<ix:nonFraction[^>]*/>", "", htm)
    vals = {}
    for attrs, text in FACT.findall(htm):
        a = dict(ATTR.findall(attrs))
        ctx = a.get("contextRef", "")
        t = TAG.sub("", text).replace(",", "").strip()
        if not re.fullmatch(r"-?\d+(\.\d+)?", t):
            continue
        m = re.match(r"^(\w+?(?:Duration|Instant))_(.*)$", ctx)
        if not m:
            continue
        rest = m.group(2)
        cons = "Consolidated" if "_ConsolidatedMember" in "_" + rest or rest.startswith("ConsolidatedMember") else ("NonConsolidated" if "NonConsolidatedMember" in rest else None)
        kind = next((k for k in ("Result", "Forecast", "Upper", "Lower") if f"{k}Member" in rest), None)
        if not cons or not kind:
            continue
        sub = "Annual" if "AnnualMember" in rest else ("Q2" if "SecondQuarterMember" in rest else ("YE" if "YearEndMember" in rest else ""))
        vals[(a.get("name", "").split(":")[-1], m.group(1), cons, kind, sub)] = float(t) * (-1 if a.get("sign") == "-" else 1)
    return vals


def parse_tanshin(htm):
    """決算短信のサマリーから：今期（累計）の実績と前年同期比、通期予想、進捗率、配当予想"""
    v = _facts(htm)
    if not v:
        return None
    periods = [("CurrentAccumulatedQ1Duration", 1), ("CurrentAccumulatedQ2Duration", 2), ("CurrentAccumulatedQ3Duration", 3), ("CurrentYearDuration", 4)]
    for cons in ("Consolidated", "NonConsolidated"):
        for per, q in periods:
            def g(name, kind="Result", period=per, sub=""):
                x = v.get((name, period, cons, kind, sub))
                if x is None and kind == "Forecast":
                    lo, hi = v.get((name, period, cons, "Lower", sub)), v.get((name, period, cons, "Upper", sub))
                    if lo is not None and hi is not None:
                        x = (lo + hi) / 2
                return x
            pm = next(((k, l) for k, l in PROFIT if g(k) is not None), None)
            if not pm:
                continue
            sm = next(((k, l) for k, l in SALES if g(k) is not None), None)
            out = {"q": q, "cons": cons == "Consolidated", "m": pm[1], "profit": g(pm[0]), "profitYoY": g("ChangeIn" + pm[0])}
            if sm:
                out.update({"sales": g(sm[0]), "salesYoY": g("ChangeIn" + sm[0])})
            # 通期の会社予想（四半期なら今期、本決算なら来期）
            fper = "CurrentYearDuration" if q < 4 else "NextYearDuration"
            fp = g(pm[0], "Forecast", fper)
            if fp is not None:
                out["fy"] = {"profit": fp, "profitYoY": g("ChangeIn" + pm[0], "Forecast", fper)}
                if sm and g(sm[0], "Forecast", fper) is not None:
                    out["fy"].update({"sales": g(sm[0], "Forecast", fper), "salesYoY": g("ChangeIn" + sm[0], "Forecast", fper)})
                if q < 4 and fp > 0 and out["profit"] is not None:
                    out["progress"] = round(out["profit"] / fp, 4)  # 通期予想に対する進捗率
            dv = g("DividendPerShare", "Forecast", fper, "Annual")
            if dv is not None:
                out["div"] = dv
            return out
    return None


def fetch_zip_summary(zname, kind):
    """kind='rvfc'（業績予想の修正）か 'sm'（決算短信サマリー）"""
    try:
        req = urllib.request.Request(BASE + zname, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            zf = zipfile.ZipFile(io.BytesIO(r.read()))
        for n in zf.namelist():
            base = n.split("/")[-1]
            if not base.endswith("ixbrl.htm"):
                continue
            if kind == "rvfc" and "rvfc" in base:
                return parse_revision(zf.read(n).decode("utf-8", "replace"))
            if kind == "sm" and re.match(r"tse-\w*sm-", base):
                return parse_tanshin(zf.read(n).decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"XBRL {zname}: {type(e).__name__} {e}", file=sys.stderr)
    return None


def add_earnings(items):
    """決算短信には、売上・利益の前年同期比、通期予想と進捗率などを付ける"""
    n = 0
    for x in items:
        if x[5] == "earnings" and len(x) > 7 and x[7]:
            fin = fetch_zip_summary(x[7], "sm")
            time.sleep(0.3)
            while len(x) < 9:
                x.append(None)
            x[8] = fin
            n += fin is not None
    return n


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
    total, new_days, revs, earns = 0, 0, 0, 0
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
            earned = add_earnings(items)
        except Exception as e:  # noqa: BLE001
            print(f"{day}: {type(e).__name__} {e}", file=sys.stderr)
            continue
        doc["items"] = [x for x in doc["items"] if x[0] != day.isoformat()] + items
        if day.isoformat() not in doc["fetched"] and (items or i > 1):
            doc["fetched"].append(day.isoformat())
        total += len(items)
        revs += revised
        earns += earned
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
    print(f"{new_days}日分を取得（{total}件・業績修正の数字 {revs}件・決算短信の数字 {earns}件）。分類: {json.dumps(cats, ensure_ascii=False)}")


def export(repo, out, since_days, all_dir=None, all_days=120):
    """サイト用：直近の重要な開示を銘柄ごとに（「その他」は件数が多いので除く）。
    all_dir を指定すると、銘柄ごとの全部の開示（IR）を all_dir/<コード>.json に（銘柄を開いたときに読む）"""
    today = dt.datetime.now(JST).date()
    since = (today - dt.timedelta(days=since_days)).isoformat()
    since_all = (today - dt.timedelta(days=all_days)).isoformat()
    by, every = {}, {}
    for path in sorted(glob.glob(os.path.join(repo, "*.json"))):
        for x in load(path, {}).get("items", []):
            d, tm, code, _name, title, cat, pdf = x[:7]
            extra = x[8] if len(x) > 8 else None
            if d >= since_all:
                every.setdefault(code, []).append([d, tm, cat, title, pdf, extra])
            if d < since or cat == "other":
                continue
            by.setdefault(code, []).append([d, tm, cat, title, pdf, extra])
    if all_dir:
        os.makedirs(all_dir, exist_ok=True)
        for code, v in every.items():
            v.sort(key=lambda x: (x[0], x[1]), reverse=True)
            with open(os.path.join(all_dir, f"{code}.json"), "w", encoding="utf-8") as f:
                json.dump({"base": BASE, "items": v}, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{len(every)}銘柄の開示（全部）を {all_dir} に書き出しました")
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
    ap.add_argument("--all-dir", help="銘柄ごとの全部の開示（IR）の書き出し先")
    ap.add_argument("--refresh", action="store_true", help="取得済みの日も取り直す（業績修正の数字の後付け用）")
    args = ap.parse_args()
    if args.export:
        export(args.repo, args.export, args.since_days, args.all_dir)
    else:
        collect(args.repo, args.days, args.refresh)


if __name__ == "__main__":
    main()
