"""Yahoo Finance（yfinance）から日足・決算日・権利落ち日・ニュースを取得して raw/ に保存する。

GitHub Actions から15分おきに実行される想定。
  - 日足（1年分）: 毎回（当日の足は場中なら途中経過＝約20分遅れの現在値）
  - 決算日・権利落ち日・ニュース: 1日1回（前回データを prev/ から引き継ぐ）

使い方: python scripts/fetch_data.py --universe config/universe.json --prev prev --out raw
"""
import argparse
import calendar
import datetime as dt
import json
import math
import re
import os
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import yfinance as yf

JST = dt.timezone(dt.timedelta(hours=9))


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def num(v):
    try:
        v = float(v)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def fetch_history(universe):
    tickers = [u["yf"] for u in universe]
    df = yf.download(tickers, period="1y", interval="1d", group_by="ticker",
                     auto_adjust=False, threads=True, progress=False)
    out = {}
    for u in universe:
        try:
            sub = df[u["yf"]] if len(tickers) > 1 else df
        except KeyError:
            print(f"no data: {u['yf']}", file=sys.stderr)
            continue
        candles = []
        for idx, row in sub.iterrows():
            o, h, l, c = num(row.get("Open")), num(row.get("High")), num(row.get("Low")), num(row.get("Close"))
            if None in (o, h, l, c):
                continue
            candles.append({"date": idx.strftime("%Y-%m-%d"), "open": o, "high": h, "low": l,
                            "close": c, "volume": num(row.get("Volume")) or 0})
        if len(candles) >= 30:
            out[u["sym"]] = candles
        else:
            print(f"too few candles: {u['yf']} ({len(candles)})", file=sys.stderr)
    return out


def to_date(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if v is None:
        return None
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    return str(v)[:10]


def estimate_jp_exdiv(div_dates, today):
    """日本株の権利落ち日を推定：過去の配当月の「月末の1営業日前」（祝日は考慮しない）。"""
    months = sorted({d.month for d in div_dates})
    if not months:
        return None
    candidates = []
    for year in (today.year, today.year + 1):
        for m in months:
            last = dt.date(year, m, calendar.monthrange(year, m)[1])
            while last.weekday() >= 5:  # 月末営業日
                last -= dt.timedelta(days=1)
            d = last - dt.timedelta(days=1)  # その前営業日が権利落ち日
            while d.weekday() >= 5:
                d -= dt.timedelta(days=1)
            if d >= today:
                candidates.append(d)
    return min(candidates).strftime("%Y-%m-%d") if candidates else None


def parse_news(items):
    out = []
    for it in items or []:
        c = it.get("content") or it  # 新旧どちらの形式にも対応
        title = c.get("title")
        if not title:
            continue
        link = (c.get("canonicalUrl") or {}).get("url") or (c.get("clickThroughUrl") or {}).get("url") or c.get("link")
        publisher = (c.get("provider") or {}).get("displayName") or c.get("publisher")
        when = c.get("pubDate") or c.get("providerPublishTime")
        if isinstance(when, (int, float)):
            when = dt.datetime.fromtimestamp(when, dt.timezone.utc).isoformat()
        out.append({"title": title, "publisher": publisher, "link": link, "time": when})
    return out[:6]


NOISE = re.compile(r"掲示板|株価・株式情報|株価チャート|リアルタイム株価|株価・銘柄|stock price, quote|Stock Price & News")


def google_news(u):
    """Google ニュースの RSS から見出しを取得（日本株は日本語、米国株は英語）。"""
    if u.get("market") == "JP":
        q, params = f"{u['name']} 株", "hl=ja&gl=JP&ceid=JP:ja"
    else:
        q, params = f"{u['name']} stock", "hl=en-US&gl=US&ceid=US:en"
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(q + ' when:7d')}&{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (kabu-radar)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        root = ET.fromstring(r.read())
    out = []
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        src = item.find("source")
        publisher = src.text if src is not None else None
        if publisher and title.endswith(" - " + publisher):
            title = title[: -len(publisher) - 3]
        if NOISE.search(title):
            continue
        when = item.findtext("pubDate")
        try:
            when = parsedate_to_datetime(when).isoformat() if when else None
        except (TypeError, ValueError):
            pass
        out.append({"title": title, "publisher": publisher, "link": item.findtext("link"), "time": when})
        if len(out) >= 6:
            break
    return out


MARKET = [("N225", "^N225"), ("SPX", "^GSPC"), ("VIX", "^VIX"), ("USDJPY", "JPY=X")]


def fundamentals_of(t):
    """PER・PBR・配当利回りなど。取れない項目は None。"""
    info = t.info or {}
    price = num(info.get("currentPrice")) or num(info.get("regularMarketPrice")) or num(info.get("previousClose"))
    rate = num(info.get("dividendRate"))
    if rate is not None and price:
        dy = rate / price
    else:
        dy = num(info.get("trailingAnnualDividendYield"))
    per = num(info.get("trailingPE"))
    pbr = num(info.get("priceToBook"))
    return {
        "per": per if per and 0 < per < 1000 else None,
        "fper": num(info.get("forwardPE")),
        "pbr": pbr if pbr and 0 < pbr < 200 else None,
        "divYield": dy if dy is not None and 0 <= dy < 0.3 else None,
        "marketCap": num(info.get("marketCap")),
        "sector": info.get("sector"),
        "currency": info.get("currency"),
    }


def fetch_events_and_news(universe, today):
    events, news, funda = {}, {}, {}
    for u in universe:
        t = yf.Ticker(u["yf"])
        ev = {"earnings": None, "exDiv": None, "exDivEstimated": False}
        try:
            cal = t.calendar or {}
            if isinstance(cal, dict):
                ev["earnings"] = to_date(cal.get("Earnings Date"))
                ev["exDiv"] = to_date(cal.get("Ex-Dividend Date"))
        except Exception as e:  # noqa: BLE001  取得失敗は空のまま続行
            print(f"calendar {u['yf']}: {e}", file=sys.stderr)
        if ev["exDiv"] and ev["exDiv"] < today.isoformat():
            ev["exDiv"] = None  # 過去の日付は使わない
        if not ev["exDiv"] and u.get("market") == "JP":
            try:
                divs = t.dividends
                dates = [d.date() for d in divs.index if d.date() > today - dt.timedelta(days=800)]
                ev["exDiv"] = estimate_jp_exdiv(dates, today)
                ev["exDivEstimated"] = bool(ev["exDiv"])
            except Exception as e:  # noqa: BLE001
                print(f"dividends {u['yf']}: {e}", file=sys.stderr)
        events[u["sym"]] = ev
        items = []
        try:
            items = google_news(u)
        except Exception as e:  # noqa: BLE001
            print(f"google news {u['yf']}: {e}", file=sys.stderr)
        if not items:
            try:
                items = parse_news(t.news)
            except Exception as e:  # noqa: BLE001
                print(f"yahoo news {u['yf']}: {e}", file=sys.stderr)
        news[u["sym"]] = items
        try:
            funda[u["sym"]] = fundamentals_of(t)
        except Exception as e:  # noqa: BLE001
            print(f"info {u['yf']}: {e}", file=sys.stderr)
        time.sleep(0.4)
    return events, news, funda


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="config/universe.json")
    ap.add_argument("--prev", default="prev")
    ap.add_argument("--out", default="raw")
    ap.add_argument("--force-daily", action="store_true")
    args = ap.parse_args()

    universe = load_json(args.universe, {}).get("symbols", [])
    os.makedirs(args.out, exist_ok=True)
    today = dt.datetime.now(JST).date()

    history = fetch_history(universe)
    if not history:
        sys.exit("株価を1銘柄も取得できませんでした")
    with open(os.path.join(args.out, "history.json"), "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False)

    market = fetch_history([{"sym": k, "yf": y} for k, y in MARKET])
    with open(os.path.join(args.out, "market.json"), "w", encoding="utf-8") as f:
        json.dump(market, f, ensure_ascii=False)

    prev_events = load_json(os.path.join(args.prev, "events.json"), {})
    prev_news = load_json(os.path.join(args.prev, "news.json"), {})
    prev_funda = load_json(os.path.join(args.prev, "fundamentals.json"), {})
    if args.force_daily or prev_events.get("date") != today.isoformat():
        targets, base_ev, base_news, base_funda = universe, {}, {}, {}
    else:
        # 同じ日のうちは、新しく追加された銘柄の分だけ取りに行く
        known = set(prev_events.get("events", {})) & set(prev_funda.get("fundamentals", {}))
        targets = [u for u in universe if u["sym"] not in known]
        base_ev, base_news, base_funda = prev_events.get("events", {}), prev_news.get("news", {}), prev_funda.get("fundamentals", {})
    events, news, funda = fetch_events_and_news(targets, today) if targets else ({}, {}, {})
    date = today.isoformat() if targets is universe else prev_events.get("date")
    events_doc = {"date": date, "events": {**base_ev, **events}}
    news_doc = {"date": date, "news": {**base_news, **news}}
    funda_doc = {"date": date, "fundamentals": {**base_funda, **funda}}
    for name, doc in (("events", events_doc), ("news", news_doc), ("fundamentals", funda_doc)):
        with open(os.path.join(args.out, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
    with_news = sum(1 for v in news_doc.get("news", {}).values() if v)
    print(f"history: {len(history)}/{len(universe)} symbols, events date {events_doc.get('date')}, news for {with_news} symbols, market {list(market)}, fundamentals {len(funda_doc['fundamentals'])}")


if __name__ == "__main__":
    main()
