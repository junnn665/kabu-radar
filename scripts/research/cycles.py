"""大型株に「決まった周期の上げ下げ」があるかを、過去10年の日足で調べる（調査用・サイトには使わない）。

1. 周期（スペクトル）: 日々の値動き（TOPIX との差）に、偶然では出ない強さの周期があるか
   → シャッフルした値動き200回の最大値と比べる。前半5年と後半5年で同じ周期が出るかも見る
2. 戻りやすさ（自己相関）: 過去 k 日上がった銘柄は次の k 日下がりやすいか（周期があればマイナスになる）
3. 周期で売買したら: 毎月末、過去2年の値動きから最も強い周期の波を当てはめ、次の20営業日の上げ下げを予想 → 的中率
4. 季節性: 月別・曜日別・権利付き最終日の前後（3月・9月）の平均（TOPIX との差）。前半5年と後半5年で同じ傾向か

使い方: python scripts/research/cycles.py --out research_cycles.json
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
import yfinance as yf

LARGE = {
    "7203": "トヨタ", "6758": "ソニーG", "8306": "三菱UFJ", "9984": "ソフトバンクG", "8035": "東京エレクトロン",
    "6501": "日立", "7974": "任天堂", "8058": "三菱商事", "6861": "キーエンス", "9983": "ファーストリテイリング",
    "4063": "信越化学", "6098": "リクルート", "9433": "KDDI", "9432": "NTT", "8316": "三井住友FG",
    "4502": "武田薬品", "7267": "ホンダ", "6367": "ダイキン", "8766": "東京海上", "8031": "三井物産",
    "8001": "伊藤忠", "6902": "デンソー", "6954": "ファナック", "6981": "村田製作所", "4519": "中外製薬",
    "4661": "オリエンタルランド", "8411": "みずほFG", "6857": "アドバンテスト", "3382": "セブン&アイ", "7011": "三菱重工",
}
RNG = np.random.default_rng(7)


def load():
    tick = [f"{s}.T" for s in LARGE] + ["1306.T"]
    df = yf.download(tick, period="10y", interval="1d", auto_adjust=True, progress=False, group_by="ticker", threads=True)
    close = pd.DataFrame({t.replace(".T", ""): df[t]["Close"] for t in tick if t in df.columns.get_level_values(0)}).dropna(how="all")
    return close


def periodogram(x):
    x = x - x.mean()
    n = len(x)
    f = np.fft.rfftfreq(n)
    p = np.abs(np.fft.rfft(x)) ** 2 / n
    ok = (f > 1 / 260) & (f < 1 / 4)  # 4日〜260日の周期
    return 1 / f[ok], p[ok]


def spectral(ex):
    out = []
    for s in LARGE:
        r = ex[s].dropna().values
        if len(r) < 1000:
            continue
        per, p = periodogram(r)
        peak = per[p.argmax()]
        null = [periodogram(RNG.permutation(r))[1].max() for _ in range(200)]
        h = len(r) // 2
        per1, p1 = periodogram(r[:h])
        per2, p2 = periodogram(r[h:])
        out.append({"sym": s, "name": LARGE[s], "peakDays": round(float(peak), 1), "power": float(p.max() / np.mean(null)),
                    "significant": bool(p.max() > np.quantile(null, 0.95)),
                    "peakFirstHalf": round(float(per1[p1.argmax()]), 1), "peakSecondHalf": round(float(per2[p2.argmax()]), 1)})
    return out


def autocorr(ex):
    res = {}
    for k in (5, 10, 20, 60, 120):
        cs = []
        for s in LARGE:
            r = ex[s].dropna()
            past = r.rolling(k).sum()
            fut = r[::-1].rolling(k).sum()[::-1].shift(-1)
            d = pd.concat([past, fut], axis=1).dropna().iloc[::k]  # 重ならないように k 日おき
            if len(d) > 10:
                cs.append(d.corr().iloc[0, 1])
        cs = np.array(cs)
        res[k] = {"meanCorr": float(cs.mean()), "negative": int((cs < 0).sum()), "n": int(len(cs)),
                  "se": float(1 / np.sqrt(2500 / k))}
    return res


def cycle_trading(close, ex):
    """毎月末、それまでの全期間の値動きで最も強い周期を見つけ、直近250日の位置（位相）に波を当てはめて次の20日を予想"""
    hits, n, by = 0, 0, {}
    for s in LARGE:
        r = ex[s].dropna()
        cum = r.cumsum()
        idx = range(750, len(cum) - 20, 21)
        hs = []
        for i in idx:
            per, p = periodogram(r.iloc[:i].values)
            P = per[p.argmax()]
            W = 250
            y = cum.iloc[i - W:i].values
            t = np.arange(W)
            y = y - np.polyval(np.polyfit(t, y, 1), t)
            w = 2 * np.pi / P
            A = np.column_stack([np.sin(w * t), np.cos(w * t), np.ones(W)])
            coef, *_ = np.linalg.lstsq(A, y, rcond=None)
            tf = np.array([W, W + 20])
            yhat = np.column_stack([np.sin(w * tf), np.cos(w * tf), np.ones(2)]) @ coef
            pred_up = yhat[1] > yhat[0]
            actual = cum.iloc[i + 20] - cum.iloc[i]
            if actual == 0:
                continue
            hs.append(pred_up == (actual > 0))
        by[s] = float(np.mean(hs)) if hs else None
        hits += sum(hs)
        n += len(hs)
    return {"hitRate": hits / n if n else None, "n": n, "bySymbol": by}


def seasonality(ex):
    long = ex[list(LARGE)].stack().rename("r").reset_index()
    long.columns = ["date", "sym", "r"]
    long["date"] = pd.to_datetime(long["date"])
    mid = long["date"].min() + (long["date"].max() - long["date"].min()) / 2
    long["half"] = np.where(long["date"] < mid, 1, 2)
    month = long.assign(m=long["date"].dt.month).groupby(["half", "m"])["r"].mean().unstack(0) * 21 * 100  # 月あたり%
    dow = long.assign(w=long["date"].dt.dayofweek).groupby(["half", "w"])["r"].mean().unstack(0) * 100
    return {
        "monthPct": {int(m): [round(float(a), 2), round(float(b), 2)] for m, (a, b) in month.iterrows()},
        "monthCorrHalves": float(month[1].corr(month[2])),
        "dowPct": {int(w): [round(float(a), 3), round(float(b), 3)] for w, (a, b) in dow.iterrows()},
    }


def ex_dividend(close, topix):
    """3月・9月の権利付き最終日（月末の2営業日前）の前10日と後10日の値動き（TOPIXとの差、%）"""
    rows = []
    dates = close.index
    for y in sorted({d.year for d in dates}):
        for m in (3, 9):
            md = dates[(dates.year == y) & (dates.month == m)]
            if len(md) < 5:
                continue
            last = md[-3]  # 権利付き最終日（だいたい月末の2営業日前）
            i = dates.get_loc(last)
            if i < 10 or i + 10 >= len(dates):
                continue
            for s in LARGE:
                c = close[s]
                pre = np.log(c.iloc[i] / c.iloc[i - 10]) - np.log(topix.iloc[i] / topix.iloc[i - 10])
                post = np.log(c.iloc[i + 10] / c.iloc[i]) - np.log(topix.iloc[i + 10] / topix.iloc[i])
                if np.isfinite(pre) and np.isfinite(post):
                    rows.append((y, m, s, pre, post))
    d = pd.DataFrame(rows, columns=["y", "m", "s", "pre", "post"])
    return {"preMeanPct": float(d["pre"].mean() * 100), "postMeanPct": float(d["post"].mean() * 100),
            "preWin": float((d["pre"] > 0).mean()), "n": int(len(d)),
            "byYear": {int(y): round(float(g["pre"].mean() * 100), 2) for y, g in d.groupby("y")}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="research_cycles.json")
    args = ap.parse_args()
    close = load()
    print(f"{close.shape[1]}銘柄 {close.index[0].date()}〜{close.index[-1].date()}（{len(close)}日）", flush=True)
    lr = np.log(close).diff()
    ex = lr.sub(lr["1306"], axis=0)
    res = {"period": [str(close.index[0].date()), str(close.index[-1].date())], "days": len(close)}
    res["spectral"] = spectral(ex)
    res["autocorr"] = autocorr(ex)
    res["cycleTrading"] = cycle_trading(close, ex)
    res["seasonality"] = seasonality(ex)
    res["exDividend"] = ex_dividend(close, close["1306"])
    json.dump(res, open(args.out, "w"), ensure_ascii=False, indent=1)
    sp = res["spectral"]
    print(f"SUMMARY 周期が有意 {sum(x['significant'] for x in sp)}/{len(sp)}銘柄・前半後半で同じ周期 {sum(abs(x['peakFirstHalf'] - x['peakSecondHalf']) < 3 for x in sp)}銘柄"
          f" / 周期売買の的中率 {res['cycleTrading']['hitRate']:.3f}（{res['cycleTrading']['n']}回）"
          f" / 月別の前半後半の相関 {res['seasonality']['monthCorrHalves']:.2f}"
          f" / 権利取り前10日 {res['exDividend']['preMeanPct']:+.2f}% 後10日 {res['exDividend']['postMeanPct']:+.2f}%")
    t = next((x for x in sp if x["sym"] == "7203"), None)
    by = {k: v for k, v in res["cycleTrading"]["bySymbol"].items() if v is not None}
    best = sorted(by.items(), key=lambda kv: -kv[1])[:3]
    print(f"DETAIL トヨタ: 最も強い周期 {t['peakDays']}日（偶然の{t['power']:.2f}倍・有意={t['significant']}）前半 {t['peakFirstHalf']}日 後半 {t['peakSecondHalf']}日 / 周期売買の的中率 {by.get('7203', 0):.3f}"
          f" / 的中率が高い銘柄 " + " ".join(f"{LARGE[k]}{v:.2f}" for k, v in best) + f" / 最低 {min(by.values()):.2f}")
    mp = res["seasonality"]["monthPct"]
    print("MONTH " + " ".join(f"{m}月:{a:+.1f}/{b:+.1f}" for m, (a, b) in mp.items()))
    print("DOW " + " ".join(f"{'月火水木金'[w]}:{a:+.3f}/{b:+.3f}" for w, (a, b) in res["seasonality"]["dowPct"].items() if w < 5))
    print("EXDIV " + json.dumps(res["exDividend"]["byYear"]) + f" 勝率 {res['exDividend']['preWin']:.2f} n={res['exDividend']['n']}")
    print("AUTOCORR " + " ".join(f"{k}日:{v['meanCorr']:+.3f}({v['negative']}/{v['n']})" for k, v in res["autocorr"].items()))


if __name__ == "__main__":
    sys.exit(main())
