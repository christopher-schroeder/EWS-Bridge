#!/usr/bin/env bash
# Package the add-on as an .xpi (tests and test artefacts excluded).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/ews-bridge-$VERSION.xpi"
mkdir -p dist
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
include = ["manifest.json", "LICENSE", "background.html", "background.js", "core", "platform", "experiments", "ui", "icons", "_locales"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in include:
        if os.path.isfile(item):
            z.write(item)
            continue
        for root, _, files in os.walk(item):
            for f in sorted(files):
                z.write(os.path.join(root, f))
print(out, os.path.getsize(out), "bytes")
PY
