"""tdnet.py の業績修正の読み取りを1件試す（調査用）"""
import io
import re
import sys
import traceback
import urllib.request
import zipfile

sys.path.insert(0, "scripts")
import tdnet as T  # noqa: E402

z = "091220261014550461.zip"
try:
    req = urllib.request.Request(T.BASE + z, headers=T.UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    print(f"PROBE size {len(data)}")
    zf = zipfile.ZipFile(io.BytesIO(data))
    for n in zf.namelist():
        if n.endswith("ixbrl.htm"):
            h = zf.read(n).decode("utf-8", "replace")
            facts = T.FACT.findall(h)
            print(f"PROBE {n} facts {len(facts)}")
            for a, t in facts[:4]:
                print("PROBE attrs " + a[:300] + " TEXT " + t[:80])
            print("PROBE ctx " + " ".join(sorted({dict(T.ATTR.findall(a)).get('contextRef', '?') for a, _ in facts})[:12]))
            print("PROBE result " + str(T.parse_revision(h)))
except Exception:  # noqa: BLE001
    print("PROBE ERROR " + traceback.format_exc().replace("\n", " / "))
open("result.json", "w").write("{}")
