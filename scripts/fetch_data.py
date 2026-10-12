"""東証の全上場銘柄（内国株式）の株価・決算予定日・配当・財務指標・ニュースを取得して raw/ に保存する。

GitHub Actions から実行（取引時間中は15分おき、毎朝1回は全件取り直し）。
  - 銘柄一覧        : JPX「東証上場銘柄一覧」（週1回更新）＋ config/universe_extra.json
  - 日足            : yfinance で一括取得。毎朝は1年分を全件、日中は直近5日分だけ取り直して合成
                      （前回分は cache/ に保存し、GitHub Actions のキャッシュで引き継ぐ）
  - 決算発表予定日  : JPX「決算発表予定日」Excel（毎朝）
  - 配当            : 日足と一緒に取れる配当履歴から、利回りと権利落ち日（推定）を計算
  - PER・PBR        : yfinance の銘柄情報を1日に約1/7ずつ（1週間で一巡）
  - ニュース        : スコア上位の銘柄だけ Google ニュースから（毎朝＋新しく浮上した銘柄）

使い方: python scripts/fetch_data.py --prev prev --cache cache --out raw
"""
import argparse
import calendar
import concurrent.futures as cf
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import sys
import time
import traceback
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import pandas as pd
import yfinance as yf

JST = dt.timezone(dt.timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (compatible; kabuka-hack/1.0)"}
JPX_LIST = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
JPX_EARNINGS = "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html"
MARKET = [("N225", "^N225"), ("TOPIX", "1306.T"), ("SPX", "^GSPC"), ("VIX", "^VIX"), ("USDJPY", "JPY=X")]
KEEP_BARS = 260
SEG = {"プライム": "P", "スタンダード": "S", "グロース": "G"}
DIAG = {"errors": []}


def log_err(where, e):
    msg = f"{where}: {type(e).__name__}: {e}"
    print(msg, file=sys.stderr)
    if len(DIAG["errors"]) < 40:
        DIAG["errors"].append(msg[:300])


def load_json(path, default):
    try:
        if path.endswith(".gz"):
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return json.load(f)
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj, gz=False):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if gz:
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    else:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def num(v):
    try:
        v = float(v)
        return None if math.isnan(v) or math.isinf(v) else v
    except (TypeError, ValueError):
        return None


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- 銘柄一覧
def parse_universe(df):
    df.columns = [str(c).strip() for c in df.columns]
    col = lambda key: next(c for c in df.columns if key in c)  # noqa: E731
    c_code, c_name, c_mkt = col("コード"), col("銘柄名"), col("市場")
    c_sec = next((c for c in df.columns if "33業種区分" in c), None)
    out = []
    for _, r in df.iterrows():
        mkt = str(r[c_mkt])
        if "内国株式" not in mkt:
            continue  # ETF・REIT・外国株・PRO Market などは除外
        seg = next((v for k, v in SEG.items() if k in mkt), None)
        if not seg:
            continue
        code = str(r[c_code]).strip().upper()
        if code.endswith(".0"):
            code = code[:-2]
        sec = str(r[c_sec]).strip() if c_sec else ""
        out.append({"sym": code, "yf": f"{code}.T", "name": str(r[c_name]).strip(), "seg": seg,
                    "sector": sec if sec and sec not in ("nan", "-") else None})
    return out


def fetch_universe():
    df = pd.read_excel(io.BytesIO(http_get(JPX_LIST, 60)), dtype=str)
    out = parse_universe(df)
    if len(out) < 1000:
        raise RuntimeError(f"銘柄数が少なすぎます: {len(out)}")
    return out


def load_universe(args, today):
    prev = load_json(os.path.join(args.prev, "universe.json"), {})
    stale = not prev.get("symbols") or (prev.get("date") or "") < (today - dt.timedelta(days=6)).isoformat()
    symbols, date = prev.get("symbols", []), prev.get("date")
    if stale or args.force_daily:
        try:
            symbols, date = fetch_universe(), today.isoformat()
        except Exception as e:  # noqa: BLE001
            log_err("JPX銘柄一覧", e)
    extra = load_json("config/universe_extra.json", {}).get("symbols", [])
    have = {u["sym"] for u in symbols}
    symbols = symbols + [dict(u, seg=u.get("seg", "X")) for u in extra if u["sym"] not in have]
    return {"date": date, "symbols": symbols}


# ---------------------------------------------------------------- 日足
def frame_to_bars(sub):
    bars = {"d": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    divs = []
    for idx, row in sub.iterrows():
        o, h, l, c = num(row.get("Open")), num(row.get("High")), num(row.get("Low")), num(row.get("Close"))
        d = idx.strftime("%Y-%m-%d")
        dv = num(row.get("Dividends"))
        if dv:
            divs.append([d, dv])
        if None in (o, h, l, c) or c <= 0:
            continue
        vol = num(row.get("Volume")) or 0
        bars["d"].append(d)
        bars["o"].append(round(o, 2)); bars["h"].append(round(h, 2)); bars["l"].append(round(l, 2)); bars["c"].append(round(c, 2))
        bars["v"].append(int(vol))
    return bars, divs


def download(tickers, period, chunk=200):
    """yfinance で一括取得。失敗したチャンクは1回だけ再試行。"""
    got = {}
    for i in range(0, len(tickers), chunk):
        part = tickers[i:i + chunk]
        for attempt in range(2):
            try:
                df = yf.download(part, period=period, interval="1d", group_by="ticker", auto_adjust=True,
                                 actions=True, threads=True, progress=False, timeout=30)
                for t in part:
                    try:
                        sub = df[t] if len(part) > 1 else df
                    except KeyError:
                        continue
                    sub = sub.dropna(how="all")
                    if len(sub):
                        got[t] = sub
                break
            except Exception as e:  # noqa: BLE001
                log_err(f"download {i}-{i + len(part)} try{attempt}", e)
                time.sleep(5)
        time.sleep(1)
    return got


def merge_bars(old, new):
    """old の末尾を new で置き換える（同じ日付は new を優先）。"""
    if not old or not old.get("d"):
        return new
    if not new.get("d"):
        return old
    first = new["d"][0]
    keep = sum(1 for d in old["d"] if d < first)
    return {k: old[k][:keep] + new[k] for k in "dohlcv"}


def trim(bars):
    return {k: v[-KEEP_BARS:] for k, v in bars.items()}


# ---------------------------------------------------------------- 決算・配当・財務・ニュース
def parse_earnings_sheet(df):
    out = {}
    hdr = next((i for i in range(min(15, len(df))) if any("コード" in str(x) for x in df.iloc[i])), None)
    if hdr is None:
        return out
    cols = [str(x) for x in df.iloc[hdr]]
    ci = next(i for i, c in enumerate(cols) if "コード" in c)
    di = next((i for i, c in enumerate(cols) if "予定日" in c or "発表日" in c), None)
    if di is None:
        return out
    for _, r in df.iloc[hdr + 1:].iterrows():
        code = str(r.iloc[ci]).strip().upper()
        code = code[:-2] if code.endswith(".0") else code
        d = pd.to_datetime(str(r.iloc[di]).strip(), errors="coerce")
        if not re.fullmatch(r"[0-9A-Z]{4}", code) or pd.isna(d):
            continue
        ds = d.strftime("%Y-%m-%d")
        if code not in out or ds < out[code]:
            out[code] = ds
    return out


def fetch_earnings_dates(today):
    """JPX の決算発表予定日 Excel（複数）から {コード: 次の予定日} を作る。"""
    html = http_get(JPX_EARNINGS).decode("utf-8", "ignore")
    links = sorted(set(re.findall(r'href="([^"]+\.xlsx?)"', html)))
    out = {}
    for href in links:
        url = urllib.parse.urljoin(JPX_EARNINGS, href)
        try:
            df = pd.read_excel(io.BytesIO(http_get(url, 60)), header=None, dtype=str)
        except Exception as e:  # noqa: BLE001
            log_err(f"決算予定 {href}", e)
            continue
        for code, d in parse_earnings_sheet(df).items():
            if d >= today.isoformat() and (code not in out or d < out[code]):
                out[code] = d
    DIAG["earningsFiles"] = len(links)
    return out


def estimate_exdiv(div_dates, today):
    """過去の配当月の「月末の1営業日前」を権利落ち日として推定（祝日は考慮しない）。"""
    months = sorted({int(d[5:7]) for d in div_dates})
    cands = []
    for year in (today.year, today.year + 1):
        for m in months:
            last = dt.date(year, m, calendar.monthrange(year, m)[1])
            while last.weekday() >= 5:
                last -= dt.timedelta(days=1)
            d = last - dt.timedelta(days=1)
            while d.weekday() >= 5:
                d -= dt.timedelta(days=1)
            if d >= today:
                cands.append(d)
    return min(cands).isoformat() if cands else None


def info_of(yft):
    info = yf.Ticker(yft).info or {}
    per, pbr = num(info.get("trailingPE")), num(info.get("priceToBook"))
    return {"per": per if per and 0 < per < 1000 else None, "fper": num(info.get("forwardPE")),
            "pbr": pbr if pbr and 0 < pbr < 200 else None, "marketCap": num(info.get("marketCap"))}


NOISE = re.compile(r"掲示板|株価・株式情報|株価チャート|リアルタイム株価|株価・銘柄|みんかぶ|株探|Yahoo!ファイナンス")


def google_news(name):
    q = f"{name} 株 when:7d"
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(q)}&hl=ja&gl=JP&ceid=JP:ja"
    root = ET.fromstring(http_get(url, 15))
    out = []
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        src = item.find("source")
        pub = src.text if src is not None else None
        if pub and title.endswith(" - " + pub):
            title = title[: -len(pub) - 3]
        if NOISE.search(title) or (pub and NOISE.search(pub)):
            continue
        when = item.findtext("pubDate")
        try:
            when = parsedate_to_datetime(when).isoformat() if when else None
        except (TypeError, ValueError):
            pass
        out.append({"title": title, "publisher": pub, "link": item.findtext("link"), "time": when})
        if len(out) >= 6:
            break
    return out


def pmap(fn, items, workers=8):
    out = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for f in cf.as_completed(futs):
            key = futs[f]
            try:
                out[key] = f.result()
            except Exception as e:  # noqa: BLE001
                log_err(f"{getattr(fn, '__name__', 'task')} {key}", e)
    return out


def bars_to_candles(b):
    return [{"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v}
            for d, o, h, l, c, v in zip(b["d"], b["o"], b["h"], b["l"], b["c"], b["v"])]


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", default="prev")
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--out", default="raw")
    ap.add_argument("--force-daily", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    today = dt.datetime.now(JST).date()
    os.makedirs(args.out, exist_ok=True)

    uni = load_universe(args, today)
    symbols = uni["symbols"]
    if not symbols:
        sys.exit("銘柄一覧を取得できませんでした")
    save_json(os.path.join(args.out, "universe.json"), uni)
    by_yf = {u["yf"]: u["sym"] for u in symbols}
    valid = set(by_yf.values())

    cache = load_json(os.path.join(args.cache, "history.json.gz"), {})
    bars = {s: v for s, v in cache.get("bars", {}).items() if s in valid}
    divs = cache.get("divs", {})
    full = args.force_daily or cache.get("full_date") != today.isoformat() or len(bars) < len(symbols) * 0.5

    if full:
        got = download(list(by_yf), "13mo")
        fresh = 0
        for t, sub in got.items():
            b, dv = frame_to_bars(sub)
            if b["d"]:
                bars[by_yf[t]] = trim(b)
                divs[by_yf[t]] = dv
                fresh += 1
        full_date = today.isoformat() if fresh > len(symbols) * 0.7 else cache.get("full_date")
    else:
        got = download(list(by_yf), "5d")
        for t, sub in got.items():
            b, _ = frame_to_bars(sub)
            bars[by_yf[t]] = trim(merge_bars(bars.get(by_yf[t]), b))
        missing = [u["yf"] for u in symbols if u["sym"] not in bars or len(bars[u["sym"]]["d"]) < 30]
        if missing:  # 新しく増えた銘柄は1年分
            for t, sub in download(missing, "13mo").items():
                b, dv = frame_to_bars(sub)
                if b["d"]:
                    bars[by_yf[t]], divs[by_yf[t]] = trim(b), dv
        full_date = cache.get("full_date")
    if not bars:
        sys.exit("株価を1銘柄も取得できませんでした")
    save_json(os.path.join(args.cache, "history.json.gz"), {"full_date": full_date, "bars": bars, "divs": divs}, gz=True)
    save_json(os.path.join(args.out, "history.json"), bars)
    DIAG["history"] = {"mode": "full" if full else "intraday", "symbols": len(bars), "fetched": len(got), "universe": len(symbols)}

    # 指数
    market = {}
    got_m = download([t for _, t in MARKET], "13mo")
    for k, t in MARKET:
        if t in got_m:
            b, _ = frame_to_bars(got_m[t])
            if b["d"]:
                market[k] = bars_to_candles(b)
    save_json(os.path.join(args.out, "market.json"), market)

    # 1日1回の情報（決算予定日・配当・財務）
    prev_events = load_json(os.path.join(args.prev, "events.json"), {})
    prev_funda = load_json(os.path.join(args.prev, "fundamentals.json"), {})
    daily = args.force_daily or prev_events.get("date") != today.isoformat()
    earnings = prev_events.get("earningsRaw", {})
    if daily:
        try:
            earnings = fetch_earnings_dates(today) or earnings
        except Exception as e:  # noqa: BLE001
            log_err("JPX決算予定日", e)
    events, funda = {}, prev_funda.get("fundamentals", {})
    since_1y = (today - dt.timedelta(days=366)).isoformat()
    since_2y = (today - dt.timedelta(days=800)).isoformat()
    for u in symbols:
        s = u["sym"]
        dv = divs.get(s, [])
        price = bars[s]["c"][-1] if s in bars and bars[s]["c"] else None
        e = earnings.get(s)
        events[s] = {"earnings": e if e and e >= today.isoformat() else None,
                     "exDiv": estimate_exdiv([x[0] for x in dv if x[0] >= since_2y], today), "exDivEstimated": True}
        f = dict(funda.get(s, {}))
        last_year = [x[1] for x in dv if x[0] >= since_1y]
        if price and s in divs:
            f["divYield"] = sum(last_year) / price if last_year else 0.0
        funda[s] = f
    if daily:
        # PER・PBR は1週間で一巡するよう、毎日1/7ずつ取り直す（未取得・古い順）
        order = sorted(symbols, key=lambda u: funda.get(u["sym"], {}).get("updated") or "")
        target = [u["yf"] for u in order[: max(300, len(symbols) // 7 + 1)]]
        for t, info in pmap(info_of, target).items():
            funda[by_yf[t]] = {**funda.get(by_yf[t], {}), **info, "updated": today.isoformat()}
    save_json(os.path.join(args.out, "events.json"), {"date": today.isoformat() if daily else prev_events.get("date"),
                                                     "events": events, "earningsRaw": earnings})
    save_json(os.path.join(args.out, "fundamentals.json"), {"date": today.isoformat(), "fundamentals": funda})

    # ニュース：前回スコア上位の銘柄
    prev_news = load_json(os.path.join(args.prev, "news.json"), {})
    news = {} if daily else dict(prev_news.get("news", {}))
    prev_rows = load_json(os.path.join(args.prev, "screener.json"), {}).get("rows", [])
    names = {u["sym"]: u["name"] for u in symbols}
    top = [r["sym"] for r in sorted(prev_rows, key=lambda r: -r.get("score", 0)) if r.get("liquid", True)][:100]
    need = [s for s in top if s not in news and s in names][: (100 if daily else 25)]
    for s, items in pmap(lambda s: google_news(names[s]), need, workers=6).items():
        news[s] = items
    save_json(os.path.join(args.out, "news.json"), {"date": today.isoformat(), "news": news})

    DIAG["seconds"] = round(time.time() - t0)
    DIAG["earnings"] = len(earnings)
    DIAG["fundamentals"] = sum(1 for v in funda.values() if v.get("per") or v.get("pbr"))
    DIAG["news"] = sum(1 for v in news.values() if v)
    DIAG["market"] = list(market)
    save_json(os.path.join(args.out, "fetch_meta.json"), DIAG)
    print(json.dumps({k: v for k, v in DIAG.items() if k != "errors"}, ensure_ascii=False), f"errors={len(DIAG['errors'])}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
