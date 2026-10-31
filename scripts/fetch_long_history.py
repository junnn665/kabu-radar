"""比較用：長い期間（既定8年）の日足を取る。AIの比較（experiment.yml）でだけ使い、本番の日足キャッシュは変えない。
使い方: python scripts/fetch_long_history.py --codes codes.txt --years 8 --out exp/raw/history.json"""
import argparse
import json
import sys

sys.path.insert(0, "scripts")
import fetch_data as F  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", required=True)
    ap.add_argument("--years", type=int, default=8)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    codes = [ln.strip() for ln in open(args.codes) if ln.strip()]
    got = F.download([f"{c}.T" for c in codes], f"{args.years}y")
    bars = {}
    for t, sub in got.items():
        b, _ = F.frame_to_bars(sub)
        if b["d"]:
            bars[t[:-2]] = b
    json.dump(bars, open(args.out, "w"))
    n = max((len(b["d"]) for b in bars.values()), default=0)
    print(f"{len(bars)}銘柄・最長 {n}日（{min(b['d'][0] for b in bars.values())}〜）")


if __name__ == "__main__":
    main()
