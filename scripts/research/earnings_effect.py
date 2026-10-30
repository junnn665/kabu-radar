"""決算・適時開示のあと、株価はどう動いたか（調査用）
発表の翌営業日の始値で買い、5営業日後の終値で売った場合の「市場平均との差」を、決算の中身ごとに比べる。
入力: tdnet/（tdnet ブランチ）、cache/history.json.gz（日足）"""
import glob, gzip, json, sys
import numpy as np

items = [x for f in glob.glob("tdnet/*.json") for x in json.load(open(f))["items"]]
bars = json.load(gzip.open("cache/history.json.gz", "rt"))["bars"]
# 銘柄ごとに 日付→位置
idx = {s: {d: i for i, d in enumerate(b["d"])} for s, b in bars.items()}
all_dates = sorted({d for b in bars.values() for d in b["d"][-120:]})

def turnover_ok(b, i):
    lo = max(0, i - 20)
    return np.mean([b["c"][k] * b["v"][k] for k in range(lo, i)]) >= 1e8 if i > 5 else False

# 市場平均（売買代金1億円以上の銘柄の等加重）：日付 d の翌日始値→5日後終値
mkt_cache = {}
def market(d0, H=5):
    if d0 in mkt_cache:
        return mkt_cache[d0]
    rs = []
    for s, b in bars.items():
        i = idx[s].get(d0)
        if i is None or i + H >= len(b["d"]) or not turnover_ok(b, i):
            continue
        o = b["o"][i + 1]
        if o > 0:
            rs.append(b["c"][i + H] / o - 1)
    mkt_cache[d0] = float(np.mean(rs)) if len(rs) > 100 else None
    return mkt_cache[d0]

def reaction(code, d, tm, H=5):
    """発表日 d（15時以降なら当日の終値の後）→ 翌営業日の始値で買い、H日後の終値"""
    b = bars.get(code)
    if not b:
        return None
    # 発表が取引時間中（15:00前）なら当日中に反応している。公平のため、どちらも「発表後に最初に買える始値」で入る
    after = tm >= "15:00"
    dates = b["d"]
    k = next((j for j, x in enumerate(dates) if (x > d if after else x > d)), None)
    if k is None or k + H - 1 >= len(dates) or k < 1:
        return None
    i0 = k - 1  # 前日（発表日）
    if not turnover_ok(b, i0):
        return None
    m = market(dates[i0], H)
    if m is None:
        return None
    entry = b["o"][k]
    gap = entry / b["c"][i0] - 1  # 発表直後の寄り付きでの反応
    ret = b["c"][k + H - 1] / entry - 1
    return {"ex": ret - m, "gap": gap}

groups = {}
def add(name, r):
    groups.setdefault(name, []).append(r)

for d, tm, code, _n, title, cat, pdf, *rest in items:
    x = rest[1] if len(rest) > 1 else None
    r = reaction(code, d, tm)
    if not r:
        continue
    add("全部の開示（参考）", r) if cat == "other" else None
    if cat == "earnings" and x and x.get("profitYoY") is not None:
        y = x["profitYoY"]
        add("決算：増益（+10%以上）" if y >= 10 else "決算：減益（−10%以下）" if y <= -10 else "決算：ほぼ横ばい", r)
        if x.get("progress") is not None and x["q"] < 4:
            diff = x["progress"] - x["q"] * 0.25
            add("決算：進捗が順調（目安+5pt以上）" if diff >= 0.05 else "決算：進捗が遅れ（目安−5pt以下）" if diff <= -0.05 else "決算：進捗ふつう", r)
    if cat in ("up", "down", "buyback", "divup", "divdown", "tob", "split"):
        add({"up": "上方修正", "down": "下方修正", "buyback": "自社株買い", "divup": "増配", "divdown": "減配", "tob": "TOB", "split": "株式分割"}[cat], r)

for name, rs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    ex = np.array([r["ex"] for r in rs]); gap = np.array([r["gap"] for r in rs])
    se = ex.std(ddof=1) / np.sqrt(len(ex)) if len(ex) > 1 else float("nan")
    print(f"SUMMARY {name}: {len(rs)}件 ｜発表直後の寄り付き {gap.mean() * 100:+.2f}% ｜その後5日の市場平均との差 {ex.mean() * 100:+.2f}%（±{se * 200:.2f}%） 勝率 {np.mean(ex > 0) * 100:.0f}%")
print(f"DETAIL 期間 {min(x[0] for x in items)}〜{max(x[0] for x in items)}・日足 {len(bars)}銘柄")
open("result.json", "w").write("{}")
