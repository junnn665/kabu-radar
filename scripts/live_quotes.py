"""取引時間中、全銘柄の株価を1分ごとに取得して live ブランチの live.json に書き出す。

GitHub Actions（live.yml）から、朝に1回だけ起動して 15:31 まで動き続ける。
1ジョブは最長6時間なので、5時間40分たったら自分自身をもう一度起動してから終わる。

  live.json = {
    "t": 取得時刻(UNIX秒), "asOf": 株価の時刻(UNIX秒・最も新しいもの), "date": "YYYY-MM-DD",
    "syms": [...銘柄コード],         # 銘柄の並び（下の配列と同じ順番）
    "p": [現在値], "pc": [前日終値], "o": [始値], "h": [高値], "l": [安値], "v": [出来高], "ts": [その銘柄の株価時刻 - asOf（秒）],
    "idx": { "N225": [現在値, 前日終値, 時刻], ... }
  }

データ元は Yahoo Finance（東証は約20分遅れ）。v7 の一括取得（1回で数百銘柄）を使い、
失敗したら yfinance の日足取得に切り替える。

使い方:
  python scripts/live_quotes.py --universe prev/universe.json --repo-dir live   # ループ（Actions）
  python scripts/live_quotes.py --universe prev/universe.json --once --out live.json  # 1回だけ
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import traceback

import yfinance as yf

JST = dt.timezone(dt.timedelta(hours=9))
QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
CHUNK = 400
INDICES = [("N225", "^N225"), ("TOPIX", "1306.T"), ("USDJPY", "JPY=X")]
FIELDS = "regularMarketPrice,regularMarketPreviousClose,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketTime"
OPEN, LUNCH_START, LUNCH_END, CLOSE = dt.time(8, 59), dt.time(11, 31), dt.time(12, 29), dt.time(15, 31)
MAX_RUN_SEC = 5 * 3600 + 40 * 60


def now_jst():
    return dt.datetime.now(JST)


def market_phase(t=None):
    """'pre' | 'open' | 'lunch' | 'closed'"""
    t = t or now_jst()
    if t.weekday() >= 5:
        return "closed"
    tt = t.time()
    if tt < OPEN:
        return "pre"
    if tt >= CLOSE:
        return "closed"
    if LUNCH_START <= tt < LUNCH_END:
        return "lunch"
    return "open"


_yfdata = None


def yfdata():
    global _yfdata
    if _yfdata is None:
        from yfinance.data import YfData
        _yfdata = YfData()
    return _yfdata


def quote_batch(tickers):
    """v7 の一括取得。{ticker: dict} を返す。"""
    out = {}
    for i in range(0, len(tickers), CHUNK):
        part = tickers[i:i + CHUNK]
        for attempt in range(3):
            try:
                js = yfdata().get_raw_json(QUOTE_URL, params={"symbols": ",".join(part), "fields": FIELDS, "formatted": "false", "lang": "ja-JP", "region": "JP"}, timeout=20)
                for r in js.get("quoteResponse", {}).get("result", []) or []:
                    if r.get("regularMarketPrice"):
                        out[r["symbol"]] = r
                break
            except Exception as e:  # noqa: BLE001
                print(f"quote {i}: try{attempt} {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
                time.sleep(2 + attempt * 3)
    return out


def quote_fallback(tickers):
    """一括取得が使えないとき：yfinance の日足（今日の分）から作る。遅いので数分に1回向け。"""
    out = {}
    for i in range(0, len(tickers), 300):
        part = tickers[i:i + 300]
        try:
            df = yf.download(part, period="5d", interval="1d", group_by="ticker", auto_adjust=False, threads=True, progress=False, timeout=30)
        except Exception as e:  # noqa: BLE001
            print(f"fallback {i}: {e}", file=sys.stderr)
            continue
        for t in part:
            try:
                sub = (df[t] if len(part) > 1 else df).dropna(how="all")
            except KeyError:
                continue
            if len(sub) < 2:
                continue
            last, prev = sub.iloc[-1], sub.iloc[-2]
            out[t] = {"regularMarketPrice": float(last["Close"]), "regularMarketPreviousClose": float(prev["Close"]),
                      "regularMarketOpen": float(last["Open"]), "regularMarketDayHigh": float(last["High"]),
                      "regularMarketDayLow": float(last["Low"]), "regularMarketVolume": int(last["Volume"] or 0),
                      "regularMarketTime": int(sub.index[-1].timestamp())}
    return out


def rnd(x):
    if x is None:
        return None
    x = float(x)
    return round(x, 1) if x >= 100 else round(x, 2)


def snapshot(universe):
    by_yf = {u["yf"]: u["sym"] for u in universe}
    tickers = list(by_yf) + [t for _, t in INDICES]
    t0 = time.time()
    q = quote_batch(tickers)
    source = "quote"
    if len(q) < len(by_yf) * 0.5:
        print(f"一括取得 {len(q)}件のみ → 日足から取得", file=sys.stderr)
        q = {**quote_fallback(tickers), **q}
        source = "fallback"
    syms, cols = [], {k: [] for k in ("p", "pc", "o", "h", "l", "v", "ts")}
    times = [int(r.get("regularMarketTime") or 0) for t, r in q.items() if t in by_yf]
    as_of = max(times) if times else int(time.time())
    for t, s in by_yf.items():
        r = q.get(t)
        if not r:
            continue
        syms.append(s)
        cols["p"].append(rnd(r.get("regularMarketPrice")))
        cols["pc"].append(rnd(r.get("regularMarketPreviousClose")))
        cols["o"].append(rnd(r.get("regularMarketOpen")))
        cols["h"].append(rnd(r.get("regularMarketDayHigh")))
        cols["l"].append(rnd(r.get("regularMarketDayLow")))
        cols["v"].append(int(r.get("regularMarketVolume") or 0))
        cols["ts"].append(int(r.get("regularMarketTime") or as_of) - as_of)
    idx = {}
    for k, t in INDICES:
        r = q.get(t)
        if r:
            idx[k] = [rnd(r.get("regularMarketPrice")), rnd(r.get("regularMarketPreviousClose")), int(r.get("regularMarketTime") or 0)]
    date = dt.datetime.fromtimestamp(as_of, JST).date().isoformat()
    return {"t": int(time.time()), "asOf": as_of, "date": date, "source": source, "n": len(syms),
            "sec": round(time.time() - t0, 1), "syms": syms, **cols, "idx": idx}


def load_universe(path):
    """data ブランチの一覧（Yahoo のティッカー無し）＋ config/universe_extra.json"""
    try:
        extra = json.load(open("config/universe_extra.json")).get("symbols", [])
    except Exception:  # noqa: BLE001
        extra = []
    ex = {u["sym"]: u["yf"] for u in extra}
    syms = [dict(u, yf=u.get("yf") or ex.get(u["sym"]) or f"{u['sym']}.T") for u in json.load(open(path)).get("symbols", [])]
    have = {u["sym"] for u in syms}
    return syms + [u for u in extra if u["sym"] not in have]


def publish(repo_dir, doc):
    path = os.path.join(repo_dir, "live.json")
    with open(path, "w") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    run = lambda *a: subprocess.run(["git", "-C", repo_dir, *a], check=True, capture_output=True, text=True)  # noqa: E731
    run("add", "live.json")
    # 常に1コミットだけ（履歴を増やさない）
    run("commit", "--amend", "-q", "-m", f"live {dt.datetime.fromtimestamp(doc['asOf'], JST):%Y-%m-%d %H:%M}", "--allow-empty")
    run("push", "-q", "-f", "origin", "HEAD:live")


def redispatch():
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GH_TOKEN")
    if not (repo and token):
        return
    try:
        subprocess.run(["gh", "api", "-X", "POST", f"repos/{repo}/actions/workflows/live.yml/dispatches", "-f", "ref=main"], check=True)
        print("続きのジョブを起動しました")
    except Exception as e:  # noqa: BLE001
        print(f"再起動に失敗: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="prev/universe.json")
    ap.add_argument("--repo-dir", default="live")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()
    universe = load_universe(args.universe)
    if not universe:
        sys.exit("銘柄一覧がありません")

    if args.once:
        doc = snapshot(universe)
        print(json.dumps({k: doc[k] for k in ("asOf", "date", "source", "n", "sec", "idx")}, ensure_ascii=False))
        delay = (time.time() - doc["asOf"]) / 60
        print(f"::notice title=live::{doc['n']}銘柄 {doc['sec']}s source={doc['source']} 株価時刻 {dt.datetime.fromtimestamp(doc['asOf'], JST):%H:%M:%S}（{delay:.0f}分前）")
        if args.out:
            json.dump(doc, open(args.out, "w"), separators=(",", ":"))
        return

    start = time.time()
    count, fails, last_lunch = 0, 0, False
    while True:
        phase = market_phase()
        if phase == "closed":
            # 引け後にもう1回だけ（15:30の終値を確定させる）
            if count:
                try:
                    publish(args.repo_dir, snapshot(universe))
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            print(f"取引終了。{count}回更新")
            break
        if time.time() - start > MAX_RUN_SEC:
            redispatch()
            break
        if phase == "pre":
            time.sleep(20)
            continue
        if phase == "lunch":
            if not last_lunch:  # 前場の終値を1回だけ
                last_lunch = True
                try:
                    publish(args.repo_dir, snapshot(universe))
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            time.sleep(30)
            continue
        last_lunch = False
        tick = time.time()
        try:
            doc = snapshot(universe)
            publish(args.repo_dir, doc)
            count += 1
            fails = 0
            if count == 1 or count % 30 == 0:
                delay = (time.time() - doc["asOf"]) / 60
                print(f"#{count} {doc['n']}銘柄 {doc['sec']}s {doc['source']} 株価時刻 {dt.datetime.fromtimestamp(doc['asOf'], JST):%H:%M}（{delay:.0f}分前）", flush=True)
        except Exception:  # noqa: BLE001
            fails += 1
            traceback.print_exc()
            if fails >= 30:
                sys.exit("30回続けて失敗したので終了します")
        time.sleep(max(5, args.interval - (time.time() - tick)))


if __name__ == "__main__":
    main()
