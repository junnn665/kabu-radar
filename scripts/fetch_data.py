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
        when = item.findtext("pubDate")
        try:
            when = parsedate_to_datetime(when).isoformat() if when else None
        except (TypeError, ValueError):
            pass
        out.append({"title": title, "publisher": publisher, "link": item.findtext("link"), "time": when})
        if len(out) >= 6:
            break
    return out


def fetch_events_and_news(universe, today):
    events, news = {}, {}
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
        time.sleep(0.4)
    return events, news


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

    prev_events = load_json(os.path.join(args.prev, "events.json"), {})
    prev_news = load_json(os.path.join(args.prev, "news.json"), {})
    if args.force_daily or prev_events.get("date") != today.isoformat():
        events, news = fetch_events_and_news(universe, today)
        events_doc = {"date": today.isoformat(), "events": events}
        news_doc = {"date": today.isoformat(), "news": news}
    else:
        events_doc, news_doc = prev_events, prev_news
    with open(os.path.join(args.out, "events.json"), "w", encoding="utf-8") as f:
        json.dump(events_doc, f, ensure_ascii=False)
    with open(os.path.join(args.out, "news.json"), "w", encoding="utf-8") as f:
        json.dump(news_doc, f, ensure_ascii=False)
    with_news = sum(1 for v in news_doc.get("news", {}).values() if v)
    print(f"history: {len(history)}/{len(universe)} symbols, events date {events_doc.get('date')}, news for {with_news} symbols")


if __name__ == "__main__":
    main()
