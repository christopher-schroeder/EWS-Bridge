#!/usr/bin/env bash
# Package the add-on as an .xpi (tests and test artefacts excluded).
#
# The build is reproducible: file order, timestamps and permissions are fixed,
# so two runs of this script on the same source produce byte-identical output.
# ATN rejects a submission whose XPI does not match a build from the sources,
# so the printed SHA-256 is what a reviewer should be able to recreate with:
#
#     git checkout v<version> && ./build.sh
#
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/ews-bridge-$VERSION.xpi"
mkdir -p dist
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import os, sys, zipfile

out = sys.argv[1]
include = ["manifest.json", "LICENSE", "background.html", "background.js",
           "core", "platform", "experiments", "ui", "icons", "_locales"]

# Fixed epoch: the earliest timestamp the zip format can represent.
DATE_TIME = (1980, 1, 1, 0, 0, 0)

def collect():
    for item in sorted(include):
        if os.path.isfile(item):
            yield item
            continue
        for root, dirs, files in os.walk(item):
            dirs.sort()
            for f in sorted(files):
                yield os.path.join(root, f)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for path in sorted(collect()):
        info = zipfile.ZipInfo(path, date_time=DATE_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        info.create_system = 3  # Unix, so the attrs above are honoured
        with open(path, "rb") as fh:
            z.writestr(info, fh.read())

print(out, os.path.getsize(out), "bytes")
PY
sha256sum "$OUT"
