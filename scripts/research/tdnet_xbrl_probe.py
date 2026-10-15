"""TDnet の「業績予想の修正」に付いている XBRL の中身を調べる（調査用）"""
import argparse
import datetime as dt
import io
import json
import re
import sys
import urllib.request
import zipfile

BASE = "https://www.release.tdnet.info/inbs/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; kabuka-hack/1.0)"}


def get(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        b = r.read()
    return b if binary else b.decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.parse_args()
    found = []
    day = dt.date.today()
    for back in range(0, 20):
        d = day - dt.timedelta(days=back)
        if d.weekday() >= 5:
            continue
        for page in range(1, 15):
            try:
                body = get(f"{BASE}I_list_{page:03d}_{d:%Y%m%d}.html")
            except Exception:  # noqa: BLE001
                break
            for tr in re.findall(r"<tr>(.*?)</tr>", body, re.S):
                if "業績予想" in tr and "修正" in tr and ".zip" in tr:
                    found.append(tr)
            if len(found) >= 3:
                break
        if len(found) >= 3:
            break
    print(f"PROBE 見つかった行 {len(found)}")
    for tr in found[:3]:
        title = re.sub(r"<[^>]+>", "", re.search(r'kjTitle[^>]*>(.*?)</td>', tr, re.S).group(1)).strip()
        z = re.search(r'href="([^"]+\.zip)"', tr).group(1)
        print(f"PROBE 表題 {title} / {z}")
        zf = zipfile.ZipFile(io.BytesIO(get(BASE + z, binary=True)))
        names = zf.namelist()
        print("PROBE files " + " ".join(names)[:900])
        for n in names:
            if n.endswith(("ixbrl.htm", ".htm")) and ("Summary" in n or "rvfc" in n or "sm" in n.lower()):
                h = zf.read(n).decode("utf-8", "replace")
                facts = re.findall(r'<ix:nonFraction[^>]*name="([^"]+)"[^>]*contextRef="([^"]+)"[^>]*>([^<]*)<', h)
                facts += [(a, b, c) for b, a, c in re.findall(r'<ix:nonFraction[^>]*contextRef="([^"]+)"[^>]*name="([^"]+)"[^>]*>([^<]*)<', h)]
                print(f"PROBE {n} facts {len(facts)}")
                for f in facts[:60]:
                    print("PROBE  " + " | ".join(f))
                break


if __name__ == "__main__":
    sys.exit(main())
