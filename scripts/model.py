"""AI予測モデル：全銘柄の日足から「5営業日後に市場平均（その日の全銘柄平均）をどれだけ上回るか」を予測する。

- モデル  : LightGBM（勾配ブースティング木）。テクニカル指標・出来高・値動きの大きさ・市場区分・業種・指数の状態など約35項目
- 学習    : 売買代金1億円以上の銘柄・日だけを使う。正解は5営業日後の「市場平均との差」（±30%で頭打ち）
- 検証    : ウォークフォワード。20営業日ごとに「その時点で結果が分かっているデータだけ」で学習し直し、
            次の20営業日を予測して成績を測る（学習に使っていない期間だけで評価するので、本番に近い成績になる）
- 本番    : 毎朝、最新までのデータで学習したモデルを cache/ に保存。日中はそのモデルで予測だけ行う

使い方:
  python scripts/model.py --history raw/history_full.json --universe raw/universe.json --market raw/market.json \
                          --cache cache --out raw [--train]
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time

import numpy as np
import pandas as pd

H = 5                    # 何営業日後を予測するか
MIN_TURNOVER = 1e8       # 学習・評価に使う売買代金（20日平均）の下限
TEST_BLOCK = 20          # 何営業日ごとに学び直すか
TRAIN_WINDOW = 500       # 学習に使う過去の営業日数（約2年）
TEST_DAYS = 250          # 検証する期間（直近約1年）
MIN_TRAIN_DAYS = int(os.environ.get("MODEL_MIN_TRAIN_DAYS", 120))
MIN_ROWS = int(os.environ.get("MODEL_MIN_ROWS", 5000))
JST = dt.timezone(dt.timedelta(hours=9))
PARAMS = dict(objective="huber", alpha=0.05, learning_rate=0.04, num_leaves=31, min_data_in_leaf=400,
              feature_fraction=0.8, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, verbose=-1, seed=7,
              num_threads=0)
ROUNDS = 300


def clean(o):
    """NaN・無限大は JSON にできないので null にする"""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean(obj), f, ensure_ascii=False, allow_nan=False)


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def rsi(close, n):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def stock_features(b):
    """1銘柄分の特徴量（その日までの情報だけで計算＝未来を見ない）"""
    df = pd.DataFrame({"o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]}, index=pd.Index(b["d"], name="date"), dtype="float64")
    c, o, h, l, v = df.c, df.o, df.h, df.l, df.v
    f = pd.DataFrame(index=df.index)
    lc = np.log(c)
    for n in (1, 5, 20, 60):
        f[f"ret{n}"] = lc.diff(n)
    for n in (5, 25, 75):
        f[f"dev{n}"] = c / c.rolling(n).mean() - 1
    s75 = c.rolling(75).mean()
    f["slope75"] = s75 / s75.shift(10) - 1
    f["rsi2"] = rsi(c, 2)
    f["rsi14"] = rsi(c, 14)
    m20, sd20 = c.rolling(20).mean(), c.rolling(20).std(ddof=0)
    f["bbz"] = (c - m20) / sd20.replace(0, np.nan)
    f["volr"] = np.log((v + 1) / (v.shift(1).rolling(20).mean() + 1))
    turn = (c * v).rolling(20).mean()
    f["lturn"] = np.log10(turn + 1)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    f["atrp"] = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean() / c
    f["vol20"] = lc.diff().rolling(20).std()
    lo60, hi60 = l.rolling(60).min(), h.rolling(60).max()
    f["pos60"] = (c - lo60) / (hi60 - lo60).replace(0, np.nan)
    f["dist250"] = c / h.rolling(250, min_periods=120).max() - 1
    f["gap"] = o / c.shift() - 1
    rng = (h - l).replace(0, np.nan)
    f["body"] = (c - o) / rng
    f["lshadow"] = (np.minimum(o, c) - l) / rng
    f["updays5"] = (c.diff() > 0).astype(float).rolling(5).sum()
    f["lprice"] = np.log10(c)
    # 正解：H営業日後のリターン（あとで市場平均を引く）
    fwd = c.shift(-H) / c - 1
    # 朝に見て寄り付きで買う場合の正解：翌営業日の始値で買い、H営業日後の終値で売る
    fwd_o = c.shift(-H) / o.shift(-1) - 1
    return f, fwd, turn, fwd_o


def market_features(market):
    out = pd.DataFrame()
    # 全銘柄に共通する値なので、相場の状態（押し目が効きやすい局面か等）を表す最小限だけ使う
    for k, col in (("N225", "n225"), ("VIX", "vix")):
        cs = market.get(k)
        if not cs:
            continue
        s = pd.Series([x["close"] for x in cs], index=[x["date"] for x in cs], dtype="float64")
        s = s[~s.index.duplicated(keep="last")]
        if k == "VIX":
            out["vix"] = s
        else:
            out[f"{col}_ret5"] = np.log(s).diff(5)
            out[f"{col}_dev25"] = s / s.rolling(25).mean() - 1
    return out.sort_index()


US_LINK = ("SOX", "BANK", "USDJPY", "TNX")  # 銘柄ごとの「つられやすさ」を測る米国側の指標


def us_table(us, jp_dates):
    """日本の各営業日 t に対して
    usp_*：t の取引開始前までに終わった米国の取引（＝t の東証の値動きにもう反映済み）
    usn_*：t の引け後〜翌営業日の寄り付き前に終わった米国の取引（朝の時点で分かる「前の晩」の米国）"""
    if not us:
        return None
    jp = pd.DataFrame({"date": jp_dates})
    jp["dt"] = pd.to_datetime(jp["date"])
    jp["next"] = jp["dt"].shift(-1).fillna(pd.Timestamp("2100-01-01"))
    out = jp[["date"]].copy()
    for k, v in us.items():
        sr = pd.Series(v["c"], index=pd.to_datetime(v["d"]), dtype="float64")
        sr = sr[~sr.index.duplicated(keep="last")].sort_index()
        if k == "TNX":
            f = pd.DataFrame({"r1": sr.diff(), "r5": sr.diff(5)})
        else:
            ls = np.log(sr)
            f = pd.DataFrame({"r1": ls.diff(), "r5": ls.diff(5)})
        f.index.name = "udt"
        f = f.reset_index().sort_values("udt")
        for pre, key in (("usp", "dt"), ("usn", "next")):
            m = pd.merge_asof(jp[[key]].rename(columns={key: "k"}).sort_values("k"), f.rename(columns={"udt": "k"}),
                              on="k", direction="backward", allow_exact_matches=False)
            m.index = jp.sort_values(key).index
            m = m.sort_index()
            out[f"{pre}_{k}_r1"] = m["r1"].values
            out[f"{pre}_{k}_r5"] = m["r5"].values
    return out.set_index("date")


def add_us_links(f, ut):
    """銘柄ごとに、米国の前夜の動きへの感応度（過去120日のβ）と、それ×前夜の動き"""
    u = ut.reindex(f.index)
    for k in US_LINK:
        xp = u.get(f"usp_{k}_r1")
        if xp is None:
            continue
        y = f["ret1"]
        cov = (y * xp).rolling(120, min_periods=60).mean() - y.rolling(120, min_periods=60).mean() * xp.rolling(120, min_periods=60).mean()
        var = xp.rolling(120, min_periods=60).var(ddof=0)
        beta = (cov / var.replace(0, np.nan)).clip(-5, 5)
        f[f"beta_{k}"] = beta
        f[f"lkp_{k}"] = beta * xp
        f[f"lkn_{k}"] = beta * u[f"usn_{k}_r1"]
    for c in u.columns:
        f[c] = u[c].values
    return f


# ---------------- 決算（J-Quants の決算サマリー）----------------
def _num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def fins_table(fins_dir):
    """決算サマリーを銘柄ごとの「いつから分かったか」付きの表にする（未来の情報を使わないため）。
    15:30（大引け）より前の開示はその日の終値から、15:30以降の開示は翌営業日から使える"""
    import glob
    rows = []
    for path in glob.glob(os.path.join(fins_dir, "*.json")):
        rows += load(path, {}).get("items", [])
    if not rows:
        return None, None
    df = pd.DataFrame(rows)
    df["code"] = df["Code"].astype(str).str[:4]
    df["ts"] = pd.to_datetime(df["DiscDate"] + " " + df["DiscTime"].fillna("00:00:00").replace("", "00:00:00"), errors="coerce")
    for c in ("Sales", "OP", "OdP", "NP", "EPS", "BPS", "FSales", "FOP", "FOdP", "FEPS", "NxFOP", "NxFEPS", "FDivAnn", "NxFDivAnn"):
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
    df = df.dropna(subset=["ts"]).sort_values(["code", "ts"])
    df["profit"] = df["OP"].where(df["OP"].notna(), df["OdP"])
    df["fprofit"] = df["FOP"].where(df["FOP"].notna(), df["FOdP"])
    q = df["CurPerType"].map({"1Q": 1, "2Q": 2, "3Q": 3, "4Q": 4, "FY": 4}).astype("float")
    df["q"] = q
    # 前年同期（同じ銘柄・同じ四半期・期末日がおよそ1年前）
    df["per_en"] = pd.to_datetime(df["CurPerEn"], errors="coerce")
    res = df[df["profit"].notna() & df["per_en"].notna()][["code", "CurPerType", "per_en", "profit", "Sales"]].copy()
    res["per_en_next"] = res["per_en"] + pd.DateOffset(years=1)
    prev = res.rename(columns={"profit": "profit_prev", "Sales": "sales_prev"}).drop(columns=["per_en"])
    df = df.merge(prev.drop_duplicates(["code", "CurPerType", "per_en_next"], keep="last"),
                  left_on=["code", "CurPerType", "per_en"], right_on=["code", "CurPerType", "per_en_next"], how="left")
    yoy = lambda a, b: ((a - b) / b.abs()).where(b.abs() > 0).clip(-3, 3)  # noqa: E731
    df["fn_profit_yoy"] = yoy(df["profit"], df["profit_prev"])
    df["fn_sales_yoy"] = yoy(df["Sales"], df["sales_prev"])
    # 通期予想に対する進捗（四半期のみ）
    df["fn_progress"] = ((df["profit"] / df["fprofit"]) - df["q"] * 0.25).where((df["fprofit"] > 0) & (df["q"] < 4)).clip(-1, 1)
    # 会社予想の修正：同じ決算期の、前回の予想と比べて
    df["fy"] = df["CurFYEn"]
    df["fprofit_prev"] = df.groupby(["code", "fy"])["fprofit"].transform(lambda x: x.ffill().shift(1))
    df["fn_fc_rev"] = yoy(df["fprofit"], df["fprofit_prev"])
    # 割安度の材料（株価で割るのは後で）：予想EPS（本決算なら来期予想）、1株純資産、予想配当
    df["feps"] = df["FEPS"].where(df["q"] < 4, df["NxFEPS"]).where(lambda x: x.notna(), df["FEPS"])
    df["fdiv"] = df["FDivAnn"].where(df["q"] < 4, df["NxFDivAnn"]).where(lambda x: x.notna(), df["FDivAnn"])
    df["bps"] = df.groupby("code")["BPS"].transform(lambda x: x.ffill())
    # 進捗は同じ決算期の中だけで引き継ぐ（本決算の後は空に）
    df["fn_progress"] = df.groupby(["code", "fy"])["fn_progress"].transform(lambda x: x.ffill())
    df.loc[df["q"] == 4, "fn_progress"] = np.nan
    keep = ["code", "ts", "fn_profit_yoy", "fn_sales_yoy", "fn_progress", "fn_fc_rev", "feps", "fdiv", "bps"]
    out = df[keep].copy()
    # 項目ごとに「その時点で最新の値」を使う（予想修正の開示には実績が無い等）
    for c in ("fn_profit_yoy", "fn_sales_yoy", "feps", "fdiv", "bps"):
        out[c] = out.groupby("code")[c].transform(lambda x: x.ffill())
    last = str(df["DiscDate"].max())
    return {c: g.drop(columns=["code"]).reset_index(drop=True) for c, g in out.groupby("code")}, last


def add_fins(f, ft, close):
    """銘柄の日足（f の index＝日付）に、その時点で分かっている最新の決算情報を付ける"""
    row_ts = pd.to_datetime(pd.Series(f.index)) + pd.Timedelta(hours=15, minutes=30)
    cols = ["fn_profit_yoy", "fn_sales_yoy", "fn_progress", "fn_fc_rev", "fn_ep", "fn_bp", "fn_dy", "fn_days"]
    if ft is None or not len(ft):
        for c in cols:
            f[c] = np.nan
        return f
    m = pd.merge_asof(pd.DataFrame({"rts": row_ts}), ft.sort_values("ts"), left_on="rts", right_on="ts", direction="backward", allow_exact_matches=False)
    for c in ("fn_profit_yoy", "fn_sales_yoy", "fn_progress", "fn_fc_rev", "feps", "bps", "fdiv"):
        m[c] = pd.to_numeric(m[c], errors="coerce")
    for c in ("fn_profit_yoy", "fn_sales_yoy", "fn_progress", "fn_fc_rev"):
        f[c] = m[c].to_numpy(dtype="float64")
    c = close.to_numpy()
    f["fn_ep"] = (m["feps"].to_numpy() / c).clip(-1, 1)
    f["fn_bp"] = (m["bps"].to_numpy() / c).clip(0, 10)
    f["fn_dy"] = (m["fdiv"].to_numpy() / c).clip(0, 0.3)
    f["fn_days"] = np.log1p((m["rts"] - m["ts"]).dt.days.to_numpy())
    return f


def build_frame(history, universe, market, us=None, fins=None):
    segs = {"P": 0, "S": 1, "G": 2}
    meta = {u["sym"]: u for u in universe}
    sectors = sorted({u.get("sector") for u in universe if u.get("sector")})
    sec_id = {s: i for i, s in enumerate(sectors)}
    parts = []
    jp_dates = sorted({d for b in history.values() for d in b.get("d", [])})
    ut = us_table(us, jp_dates) if us else None
    for sym, b in history.items():
        if not b.get("d") or len(b["d"]) < 80:
            continue
        f, fwd, turn, fwd_o = stock_features(b)
        if ut is not None:
            f = add_us_links(f, ut)
        if fins is not None:
            f = add_fins(f, fins.get(sym), pd.Series(b["c"], index=f.index, dtype="float64"))
        f["fwd"] = fwd.values
        f["fwd_o"] = fwd_o.values
        f["turn"] = turn.values
        f["sym"] = sym
        u = meta.get(sym, {})
        f["seg"] = segs.get(u.get("seg"), 3)
        f["sector"] = sec_id.get(u.get("sector"), -1)
        parts.append(f.reset_index())
    df = pd.concat(parts, ignore_index=True)
    mf = market_features(market)
    if len(mf):
        # 指数は同じ日付（無ければ直近の値）で合わせる。米国指数・VIXは前日の値を使う
        mf.index = pd.to_datetime(mf.index)
        mf.index.name = "dt"
        mf = mf.reset_index().sort_values("dt")
        us_cols = [c for c in mf.columns if c.startswith("vix")]
        mf[us_cols] = mf[us_cols].shift(1)
        df["dt"] = pd.to_datetime(df["date"])
        df = pd.merge_asof(df.sort_values("dt"), mf, on="dt", direction="backward").drop(columns=["dt"])
    df["sym"] = df["sym"].astype("category")
    for col in df.columns:
        if df[col].dtype == "float64":
            df[col] = df[col].astype("float32")
    return df, sectors


FEATURES_EXCLUDE = {"date", "sym", "fwd", "turn", "ex", "ex_sec", "liquid", "fwd_o", "ex_o"}
MARKET_COLS = ("n225_ret5", "n225_dev25", "vix")
US_PREV, US_NIGHT = ("usp_", "lkp_", "beta_"), ("usn_", "lkn_")

# 比較する設計。target: 'market'＝市場平均との差 / 'sector'＝同じ業種の平均との差（業種の当たり外れを除いて銘柄選びだけを学ぶ）
# entry: 'close'＝その日の終値で買う想定 / 'open'＝翌朝の寄り付きで買う想定（前の晩の米国を見てから買える）
# 米国の入力（us_*）は、指定した設計だけが使う
NO_US = US_PREV + US_NIGHT
VARIANTS = {
    "A_all": {"target": "market", "drop": [], "drop_prefix": NO_US},
    "B_no_market": {"target": "market", "drop": list(MARKET_COLS), "drop_prefix": NO_US},
    "C_no_market_sector": {"target": "market", "drop": list(MARKET_COLS) + ["sector"], "drop_prefix": NO_US},
    "D_sector_neutral": {"target": "sector", "drop": list(MARKET_COLS), "drop_prefix": NO_US},
    # 2026-10 追加の比較：前の晩の米国市場（SOX・米銀行株・S&P500・ナスダック・ドル円・米10年金利）
    "B_us_prev": {"target": "market", "drop": list(MARKET_COLS), "drop_prefix": US_NIGHT},
    "B_open": {"target": "market", "entry": "open", "drop": list(MARKET_COLS), "drop_prefix": NO_US},
    "B_open_us": {"target": "market", "entry": "open", "drop": list(MARKET_COLS), "drop_prefix": ()},
    # 2026-10 追加の比較：相場の流れの変化への強さ（学習期間・学び直す間隔・新しい日を重く・順位で学ぶ）
    "B_w250": {"target": "market", "drop": list(MARKET_COLS), "opts": {"window": 250}},
    "B_w120": {"target": "market", "drop": list(MARKET_COLS), "opts": {"window": 120}},
    "B_weekly": {"target": "market", "drop": list(MARKET_COLS), "opts": {"block": 5}},
    "B_decay60": {"target": "market", "drop": list(MARKET_COLS), "opts": {"half_life": 60}},
    "B_rank": {"target": "market", "drop": list(MARKET_COLS), "opts": {"rank_label": True}},
    "C_rank": {"target": "market", "drop": list(MARKET_COLS) + ["sector"], "opts": {"rank_label": True}},
    "R_reversal5": {"target": "market", "drop": [], "opts": {"rule": ("ret5", -1)}},
    # 2026-10-30 追加：決算の数字（利益・売上の前年比、通期予想への進捗、会社予想の修正、予想PER/PBR/配当利回り、発表からの日数）
    "B_rank_fins": {"target": "market", "drop": list(MARKET_COLS), "opts": {"rank_label": True}, "fins": True},
    "C_rank_fins": {"target": "market", "drop": list(MARKET_COLS) + ["sector"], "opts": {"rank_label": True}, "fins": True},
    "F_value_only": {"target": "market", "drop": list(MARKET_COLS), "opts": {"rank_label": True}, "fins": True, "only": ["fn_ep", "fn_bp", "fn_dy", "seg", "sector", "lturn"]},
    "R_momentum60": {"target": "market", "drop": [], "opts": {"rule": ("ret60", 1)}},
}
EXP_SETS = {"base": ["A_all", "B_no_market", "C_no_market_sector", "D_sector_neutral"],
            "us": ["B_no_market", "B_us_prev", "B_open", "B_open_us"],
            "sector": ["B_no_market", "C_no_market_sector", "D_sector_neutral"],
            "adapt": ["B_no_market", "B_w250", "B_w120", "B_weekly", "B_decay60", "B_rank", "C_rank", "R_reversal5"],
            "rank": ["B_no_market", "B_rank", "C_rank"],
            "fins": ["B_rank", "B_rank_fins", "C_rank_fins"]}
DEFAULT_VARIANT = os.environ.get("MODEL_VARIANT") or "B_rank"  # 2026-10-28 の比較で、1週間・1か月とも B_no_market より成績・安定性が上（順位で学ぶ）


def add_target(df):
    liquid = df["turn"] >= MIN_TURNOVER
    ok = liquid & df["fwd"].notna()
    m = df.loc[ok].groupby("date")["fwd"].mean()
    df["ex"] = (df["fwd"] - df["date"].map(m)).clip(-0.3, 0.3)
    ok_o = liquid & df["fwd_o"].notna()
    mo = df.loc[ok_o].groupby("date")["fwd_o"].mean()
    df["ex_o"] = (df["fwd_o"] - df["date"].map(mo)).clip(-0.3, 0.3)
    ms = df.loc[ok].groupby(["date", "sector"])["fwd"].transform("mean")
    df["ex_sec"] = np.nan
    df.loc[ok, "ex_sec"] = (df.loc[ok, "fwd"] - ms).clip(-0.3, 0.3)
    df["liquid"] = liquid
    return df


def feature_cols(df, variant=None):
    v = variant or VARIANTS[DEFAULT_VARIANT]
    drop, pre = set(v["drop"]), tuple(v.get("drop_prefix", NO_US))
    if v.get("only"):
        return [c for c in v["only"] if c in df.columns]
    if not v.get("fins"):  # 決算の入力は、使う設計だけ
        pre = pre + ("fn_",)
    return [c for c in df.columns if c not in FEATURES_EXCLUDE and c not in drop and not (pre and c.startswith(pre))]


def label_col(variant):
    if variant.get("entry") == "open":
        return "ex_o"
    return "ex_sec" if variant["target"] == "sector" else "ex"


def eval_cols(variant):
    return ("ex_o", "fwd_o") if variant.get("entry") == "open" else ("ex", "fwd")


def train(df_train, cols, label="ex", half_life=None, rank_label=False):
    import lightgbm as lgb
    d = df_train[df_train[label].notna()]
    cats = [c for c in ("seg", "sector") if c in cols]
    y = d[label]
    if rank_label:  # 外れ値に振り回されないよう、日ごとの順位（-0.5〜+0.5）を正解にする
        y = d.groupby("date")[label].rank(pct=True) - 0.5
    w = None
    if half_life:  # 新しい日ほど重く（相場の流れの変化に早く合わせる）
        days = pd.to_datetime(d["date"])
        age = (days.max() - days).dt.days.to_numpy()
        w = np.power(0.5, age / half_life)
    ds = lgb.Dataset(d[cols], label=y, weight=w, categorical_feature=cats, free_raw_data=True)
    return lgb.train(PARAMS, ds, num_boost_round=ROUNDS)


def evaluate(df, cols, label="ex", quiet=False, ev=("ex", "fwd"), opts=None):
    """ウォークフォワード検証：学習に使っていない期間の成績（評価は常に「市場平均との差」）"""
    dates = np.array(sorted(df["date"].unique()))
    usable = df[df["liquid"] & df[ev[0]].notna()].rename(columns={ev[0]: "_ev", ev[1]: "_evf"})
    usable["ex"], usable["fwd"] = usable["_ev"], usable["_evf"]
    if label == ev[0]:
        label = "ex"
    n_days = len(dates)
    test_start = max(MIN_TRAIN_DAYS + H + 1, n_days - H - TEST_DAYS)
    preds = []
    o = opts or {}
    block, window = o.get("block", TEST_BLOCK), o.get("window", TRAIN_WINDOW)
    for s in range(test_start, n_days - H, block):
        test_dates = dates[s:min(s + block, n_days - H)]
        train_end = dates[s - H - 1]  # 正解（H日後）が分かっている日まで
        train_start = dates[max(0, s - H - 1 - window)]
        tr = usable[(usable["date"] >= train_start) & (usable["date"] <= train_end)]
        te = usable[usable["date"].isin(test_dates)]
        if len(tr) < MIN_ROWS or not len(te):
            continue
        if o.get("rule"):  # 学習なしの単純なルール（比較用）
            col, sgn = o["rule"]
            pr = sgn * te[col].to_numpy()
        else:
            pr = train(tr, cols, label, o.get("half_life"), o.get("rank_label")).predict(te[cols])
        preds.append(pd.DataFrame({"date": te["date"].values, "sym": te["sym"].values, "pred": pr, "ex": te["ex"].values,
                                   "fwd": te["fwd"].values, "sector": te["sector"].values}))
        if not quiet:
            print(f"  検証ブロック {test_dates[0]}〜{test_dates[-1]}: 学習 {len(tr):,}件 → 予測 {len(te):,}件", flush=True)
    if not preds:
        return None
    p = pd.concat(preds, ignore_index=True)
    p["rank"] = p.groupby("date")["pred"].rank(pct=True)
    p["decile"] = np.minimum((p["rank"] * 10).astype(int), 9)
    dec = p.groupby("decile").agg(excess=("ex", "mean"), win=("ex", lambda x: float((x > 0).mean())), n=("ex", "size")).reset_index()
    ic = p.groupby("date").apply(lambda g: g["pred"].rank().corr(g["ex"].rank()), include_groups=False)

    def top(k):
        t = p.sort_values(["date", "pred"], ascending=[True, False]).groupby("date").head(k)
        return {"k": k, "n": int(len(t)), "excess": float(t["ex"].mean()), "win": float((t["fwd"] > 0).mean()),
                "exWin": float((t["ex"] > 0).mean()), "avg": float(t["fwd"].mean())}

    top2 = p[p["rank"] >= 0.98]
    monthly = top2.assign(m=lambda x: x["date"].str[:7]).groupby("m")["ex"].mean()
    # 業種の当たり外れを除いた順位（同じ日・同じ業種の平均予測を引く）でも上位2%を見る
    p["pred_sn"] = p["pred"] - p.groupby(["date", "sector"])["pred"].transform("mean")
    p["rank_sn"] = p.groupby("date")["pred_sn"].rank(pct=True)
    top2sn = p[p["rank_sn"] >= 0.98]
    daily = top2.groupby("date")["ex"].mean()
    daily_sn = top2sn.groupby("date")["ex"].mean()
    # 偏り：上位2%のうち最も多い業種が占める割合（日ごとの平均）
    conc = top2.groupby("date")["sector"].agg(lambda x: x.value_counts(normalize=True).iloc[0]).mean()
    return {
        "sectorConcentration": float(conc), "positiveMonths": float((monthly > 0).mean()),
        "from": str(p["date"].min()), "to": str(p["date"].max()), "rows": int(len(p)), "days": int(p["date"].nunique()),
        "ic": float(ic.mean()), "icPositiveDays": float((ic > 0).mean()),
        "deciles": [{"decile": int(r.decile) + 1, "excess": float(r.excess), "win": float(r.win), "n": int(r.n)} for r in dec.itertuples()],
        "top": [top(10), top(20), top(50)],
        "top2pct": {"excess": float(p.loc[p["rank"] >= 0.98, "ex"].mean()), "win": float((p.loc[p["rank"] >= 0.98, "fwd"] > 0).mean()), "n": int((p["rank"] >= 0.98).sum())},
        "bottom2pct": {"excess": float(p.loc[p["rank"] <= 0.02, "ex"].mean()), "n": int((p["rank"] <= 0.02).sum())},
        "top2pctSectorNeutral": {"excess": float(top2sn["ex"].mean()), "win": float((top2sn["fwd"] > 0).mean()), "n": int(len(top2sn)),
                                 "worstDay5pct": float(daily_sn.quantile(0.05)), "negDays": float((daily_sn < 0).mean()),
                                 "sectorConcentration": float(top2sn.groupby("date")["sector"].agg(lambda x: x.value_counts(normalize=True).iloc[0]).mean())},
        "top2Risk": {"worstDay5pct": float(daily.quantile(0.05)), "negDays": float((daily < 0).mean())},
        "monthlyTop2pct": {k: float(v) for k, v in monthly.items()},
        # 予測の値 → 市場平均との差（%）への換算（順位で学ぶ設計は予測が「順位の点数」なので、検証結果から換算の傾きを求める）
        "calib": {"slope": float(np.polyfit(p["pred"].to_numpy(), p["ex"].to_numpy(), 1)[0])},
        "recent": {  # 直近の成績（相場の流れが変わったときに強いか）
            "top2_3m": float(top2.loc[top2["date"] >= sorted(p["date"].unique())[-63], "ex"].mean()),
            "top2_1m": float(top2.loc[top2["date"] >= sorted(p["date"].unique())[-21], "ex"].mean()),
            "ic_3m": float(ic[ic.index >= sorted(p["date"].unique())[-63]].mean()),
            "bottom2_3m": float(p.loc[(p["rank"] <= 0.02) & (p["date"] >= sorted(p["date"].unique())[-63]), "ex"].mean()),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default="raw/history_full.json")
    ap.add_argument("--universe", default="raw/universe.json")
    ap.add_argument("--market", default="raw/market.json")
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--out", default="raw")
    ap.add_argument("--train", action="store_true", help="学習（と検証）も行う。指定しなければ保存済みモデルで予測だけ")
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--experiment", action="store_true", help="複数の設計を同じ期間で比較して結果を出力")
    ap.add_argument("--horizon", type=int, default=5, help="何営業日後を予測するか（5＝1週間、20＝1か月）")
    ap.add_argument("--tag", default="", help="出力ファイル名に付ける印（例: 20 → predictions_20.json）")
    ap.add_argument("--fins", help="J-Quants の決算サマリー（fins ブランチ）のフォルダ")
    args = ap.parse_args()
    global H
    H = args.horizon
    suf = f"_{args.tag}" if args.tag else ""
    t0 = time.time()
    import lightgbm as lgb

    history = load(args.history, {})
    universe = load(args.universe, {}).get("symbols", [])
    market = load(args.market, {})
    # 米国の入力は、使う設計（比較のとき・本番の設計が米国を使うとき）だけ読み込む（日中の予測を遅くしないため）
    need_us = args.experiment or tuple(VARIANTS[DEFAULT_VARIANT].get("drop_prefix", NO_US)) != NO_US
    us = load(os.path.join(os.path.dirname(args.market), "us.json"), {}) if need_us else {}
    need_fins = args.fins and (args.experiment or VARIANTS[DEFAULT_VARIANT].get("fins"))
    fins, fins_end = fins_table(args.fins) if need_fins else (None, None)
    if fins:
        print(f"決算サマリー {len(fins):,}銘柄（〜{fins_end}）", flush=True)
    model_path = os.path.join(args.cache, f"model{suf}.txt")
    meta_path = os.path.join(args.cache, f"model_meta{suf}.json")
    predict_only = not args.train and not args.experiment and os.path.exists(model_path) \
        and load(meta_path, {}).get("variant", "A_all") == DEFAULT_VARIANT
    full_history = history
    if predict_only:  # 予測だけなら直近300営業日あれば足りる（52週高値などの計算に250日使う）
        history = {s: {k: v[-300:] for k, v in b.items()} for s, b in history.items()}
    df, sectors = build_frame(history, universe, market, us, fins)
    df = add_target(df)
    if args.experiment:
        res = {}
        exp_df = df
        if fins_end and os.environ.get("EXP_SET") == "fins":
            # 決算データがある期間（無料プランは直近12週間なし）だけで、全部の設計を同じ条件で比べる
            exp_df = df[df["date"] <= fins_end]
            print(f"比較は {exp_df['date'].min()}〜{fins_end} の範囲で行います", flush=True)
        for name in EXP_SETS.get(os.environ.get("EXP_SET", "base"), EXP_SETS["base"]):
            v = VARIANTS[name]
            t1 = time.time()
            r = evaluate(exp_df, feature_cols(exp_df, v), label_col(v), quiet=True, ev=eval_cols(v), opts=v.get("opts"))
            res[name] = {k: r[k] for k in ("ic", "icPositiveDays", "top2pct", "bottom2pct", "sectorConcentration", "positiveMonths", "top2pctSectorNeutral", "top2Risk", "recent", "monthlyTop2pct")} | {"top20": r["top"][1]}
            sn, rk = r["top2pctSectorNeutral"], r["top2Risk"]
            print(f"EXP {name}: IC {r['ic']:.3f} top2% {r['top2pct']['excess'] * 100:+.2f}% win {r['top2pct']['win'] * 100:.0f}% "
                  f"偏り {r['sectorConcentration'] * 100:.0f}% 月勝率 {r['positiveMonths'] * 100:.0f}% 悪い日(5%) {rk['worstDay5pct'] * 100:+.2f}% 負け日 {rk['negDays'] * 100:.0f}% "
                  f"｜業種内順位 top2% {sn['excess'] * 100:+.2f}% ｜直近3か月 top2% {r['recent']['top2_3m'] * 100:+.2f}% IC {r['recent']['ic_3m']:.3f} bottom2% {r['recent']['bottom2_3m'] * 100:+.2f}% ｜直近1か月 top2% {r['recent']['top2_1m'] * 100:+.2f}% ({time.time() - t1:.0f}s)", flush=True)
        dump(res, os.path.join(args.out, f"experiments{suf}.json"))
    variant = VARIANTS[DEFAULT_VARIANT]
    label = label_col(variant)
    cols = feature_cols(df, variant)
    print(f"特徴量 {len(cols)}項目 / {df['sym'].nunique():,}銘柄 / {df['date'].nunique()}営業日 / {len(df):,}行 ({time.time() - t0:.0f}s)", flush=True)

    report = load(os.path.join(args.cache, f"model_report{suf}.json"), None)
    model = None
    if not args.train and os.path.exists(model_path):
        meta = load(meta_path, {})
        if meta.get("features") == cols and meta.get("variant", "A_all") == DEFAULT_VARIANT:  # 設計が変わったら学び直す
            model = lgb.Booster(model_file=model_path)
        else:
            print("特徴量が変わったので学習し直します")
    if model is None and predict_only:  # 学び直しには全期間が要るので作り直す
        df, sectors = build_frame(full_history, universe, market, us, fins)
        df = add_target(df)
        cols = feature_cols(df, variant)
    if model is None:
        if not args.no_eval:
            report = evaluate(df, cols, label, ev=eval_cols(variant), opts=variant.get("opts"))
            if report:
                report["variant"] = DEFAULT_VARIANT
        usable = df[df["liquid"] & df[label].notna()]
        dates = sorted(usable["date"].unique())
        usable = usable[usable["date"] >= dates[max(0, len(dates) - TRAIN_WINDOW)]]
        vo = variant.get("opts") or {}
        model = train(usable, cols, label, vo.get("half_life"), vo.get("rank_label"))
        os.makedirs(args.cache, exist_ok=True)
        open(os.path.join(args.out, "model_trained"), "w").close()  # このモデルをキャッシュに保存させる目印
        model.save_model(model_path)
        imp = sorted(zip(cols, model.feature_importance("gain")), key=lambda x: -x[1])
        total = sum(v for _, v in imp) or 1
        dump({"variant": DEFAULT_VARIANT, "horizon": H, "features": cols, "trainedAt": dt.datetime.now(JST).isoformat(), "trainEnd": str(usable["date"].max()),
              "rows": int(len(usable)), "importance": [[k, round(float(v) / total, 4)] for k, v in imp[:15]]}, meta_path)
        if report:
            dump(report, os.path.join(args.cache, f"model_report{suf}.json"))

    # 最新日の予測（全銘柄）。順位は売買代金1億円以上の銘柄の中での位置
    last = df.sort_values("date").groupby("sym", observed=True).tail(1)
    last = last[last["date"] >= sorted(df["date"].unique())[-3]]  # 取引停止などで古い銘柄は除く
    pred = model.predict(last[cols])
    # 中央寄せ：学習は外れ値に強い方法（huber）なので、予測は「平均」でなく「中央値」寄りになり、株価の上がり方の偏りのぶん
    # ほとんどの銘柄がマイナスに出てしまう。売買代金のある銘柄の平均を 0 にそろえて「平均的な銘柄と比べて上か下か」にする（順位は変わらない）
    liq_mask = last["liquid"].to_numpy()
    center = float(np.mean(pred[liq_mask])) if liq_mask.any() else 0.0
    pred = pred - center
    # 順位で学ぶ設計は、予測を「市場平均との差（の目安）」に換算して表示する
    scale = 1.0
    if (variant.get("opts") or {}).get("rank_label"):
        # 傾きがマイナス（検証で当たっていない）でも順位の向きは変えない
        scale = max(float((report or {}).get("calib", {}).get("slope") or 0.05), 0.01)
        pred = pred * scale
    last = last.assign(pred=pred)
    liq = last[last["liquid"]]
    ranks = liq["pred"].rank(pct=True)
    rank_by = dict(zip(liq["sym"].astype(str), ranks))
    out = {str(s): [round(float(p) * 100, 3), round(float(rank_by[str(s)]), 4) if str(s) in rank_by else None]
           for s, p in zip(last["sym"].astype(str), last["pred"]) if math.isfinite(float(p))}
    # 判断理由：各入力が予測をどれだけ押し上げ／押し下げたか（SHAP 寄与度、単位は%ポイント）。売買代金のある銘柄だけ
    reasons = {}
    if len(liq):
        contrib = model.predict(liq[cols], pred_contrib=True)  # 最後の列は全銘柄共通の基準値
        contrib = contrib * scale
        base = float(contrib[0, -1]) * 100 if len(contrib) else 0.0
        vals = liq[cols].to_numpy()
        for sym, row, v in zip(liq["sym"].astype(str), contrib[:, :-1], vals):
            order = np.argsort(row)
            ups = [i for i in order[::-1][:3] if row[i] > 0]
            downs = [i for i in order[:2] if row[i] < 0]
            reasons[sym] = [[cols[i], round(float(row[i]) * 100, 3), None if not math.isfinite(float(v[i])) else round(float(v[i]), 4)] for i in ups + downs]
        meta_reason = {"base": round(base, 3), "sectors": sectors, "segs": ["P", "S", "G", "X"]}
    else:
        meta_reason = {}
    dump({"date": str(df["date"].max()), "reasons": reasons, **meta_reason}, os.path.join(args.out, f"ai_reasons{suf}.json"))
    meta = load(meta_path, {})
    dump({"date": str(df["date"].max()), "horizon": H, "model": meta, "report": report, "center": round(center * 100, 3), "preds": out}, os.path.join(args.out, f"predictions{suf}.json"))
    print(f"予測 {len(out):,}銘柄（{time.time() - t0:.0f}s）", json.dumps({k: report[k] for k in ("ic", "top2pct")} if report else {}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
