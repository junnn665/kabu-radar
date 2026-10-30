"""決算短信 XBRL：読めなかったものの中身（調査用）"""
import io, re, sys, traceback, urllib.request, zipfile
sys.path.insert(0, "scripts")
import tdnet as T  # noqa: E402
for z in ["081220261006546359.zip", "081220261005546296.zip"]:
    try:
        with urllib.request.urlopen(urllib.request.Request(T.BASE + z, headers=T.UA), timeout=30) as r:
            zf = zipfile.ZipFile(io.BytesIO(r.read()))
        names = zf.namelist()
        print("PROBE ===== " + z + " files " + " ".join(names)[:500])
        for n in names:
            if n.endswith("ixbrl.htm") and "sm" in n.split("/")[-1][:16]:
                h = zf.read(n).decode("utf-8", "replace")
                ctx = sorted(set(re.findall(r'contextRef="([^"]+)"', h)))
                print("PROBE ctx " + " ".join(ctx)[:1500])
                names2 = sorted(set(re.findall(r'name="([^"]+)"', h)))
                print("PROBE names " + " ".join(names2)[:800])
                print("PROBE result " + str(T.parse_tanshin(h)))
    except Exception:  # noqa: BLE001
        print("PROBE ERROR " + traceback.format_exc().replace("\n", " / "))
open("result.json", "w").write("{}")
