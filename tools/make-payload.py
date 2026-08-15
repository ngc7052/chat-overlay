#!/usr/bin/env python3
"""Pack app/payload into the gzipped manifest the in-app updater consumes.

    make-payload.py <payload-dir> <out.json.gz>

Layout:
    {"version": "1.0.1",
     "files": {"main.js": {"sha256": "...", "enc": "utf8", "data": "..."}, ...}}

Text files go in as UTF-8 so a release diff stays readable; binaries are base64.
"""
import gzip
import hashlib
import json
import os
import sys

TEXT_SUFFIXES = {".js", ".json", ".html", ".css", ".svg", ".md", ".txt"}
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]

    with open(os.path.join(src, "version.json")) as fh:
        version = json.load(fh)["version"]

    files = {}
    for root, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if name in SKIP_NAMES or name.startswith("."):
                continue
            abs_path = os.path.join(root, name)
            rel = os.path.relpath(abs_path, src).replace(os.sep, "/")
            raw = open(abs_path, "rb").read()
            entry = {"sha256": hashlib.sha256(raw).hexdigest()}
            if os.path.splitext(name)[1].lower() in TEXT_SUFFIXES:
                try:
                    entry["enc"] = "utf8"
                    entry["data"] = raw.decode("utf-8")
                except UnicodeDecodeError:
                    entry["enc"] = "base64"
                    entry["data"] = __import__("base64").b64encode(raw).decode("ascii")
            else:
                entry["enc"] = "base64"
                entry["data"] = __import__("base64").b64encode(raw).decode("ascii")
            files[rel] = entry

    for required in ("main.js", "preload.js", "version.json", "renderer/index.html"):
        if required not in files:
            sys.exit(f"payload is missing {required}")

    blob = json.dumps({"version": version, "files": files},
                      ensure_ascii=False, sort_keys=True).encode("utf-8")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with gzip.open(out, "wb", compresslevel=9) as fh:
        fh.write(blob)

    print(f"    {out}  v{version}  {len(files)} files  "
          f"{os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
