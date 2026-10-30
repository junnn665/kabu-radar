"""決算短信（TDnet）の XBRL の中身を調べる（調査用）"""
import io, re, sys, traceback, urllib.request, zipfile, datetime as dt
sys.path.insert(0, "scripts")
import tdnet as T  # noqa: E402

def main():
    found = []
    d = dt.date.today()
    for back in range(0, 6):
        day = d - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        for x in T.fetch_day(day):
            if x[5] == "earnings" and len(x) > 7 and x[7]:
                found.append(x)
        if len(found) > 30:
            break
    print(f"PROBE 決算短信 {len(found)}件")
    seen = set()
    for x in found:
        kind = "連結" if "連結" in x[4] else "非連結"
        q = re.search(r"第[１-３1-3]四半期|中間|通期|期末", x[4])
        key = (kind, q.group(0) if q else "?")
        if key in seen:
            continue
        seen.add(key)
        print(f"PROBE ===== {x[2]} {x[4][:60]} / {x[7]}")
        with urllib.request.urlopen(urllib.request.Request(T.BASE + x[7], headers=T.UA), timeout=30) as r:
            zf = zipfile.ZipFile(io.BytesIO(r.read()))
        names = zf.namelist()
        print("PROBE files " + " ".join(n.split("/")[-1] for n in names)[:600])
        for n in names:
            if n.endswith("ixbrl.htm") and ("Summary" in n or "sm" in n.split("/")[-1][:12] or "ed" in n.split("/")[-1][:12]):
                h = re.sub(r"<ix:nonFraction[^>]*/>", "", zf.read(n).decode("utf-8", "replace"))
                facts = []
                for attrs, text in T.FACT.findall(h):
                    a = dict(T.ATTR.findall(attrs))
                    t = T.TAG.sub("", text).strip()
                    if t:
                        facts.append(f"{a.get('name','').split(':')[-1]}|{a.get('contextRef','')}|{('-' if a.get('sign')=='-' else '')}{t}")
                print(f"PROBE {n.split('/')[-1]} facts {len(facts)}")
                for f in facts[:70]:
                    print("PROBE  " + f)
                break
        if len(seen) >= 3:
            break

try:
    main()
except Exception:  # noqa: BLE001
    print("PROBE ERROR " + traceback.format_exc().replace("\n", " / "))
open("result.json", "w").write("{}")
