#!/usr/bin/env bash
#
# Assemble the portable Windows build.
#
# Downloads the official Electron win32-x64 runtime, drops `app/` into
# resources/app, and renames electron.exe. No wine, no Windows toolchain, no
# npm install — the app itself has zero dependencies.
#
#   ./build.sh              -> dist/ChatOverlay/
#   ./build.sh --zip        -> also dist/ChatOverlay.zip
#
set -euo pipefail

ELECTRON_VERSION="${ELECTRON_VERSION:-43.4.0}"
ARCH="${ARCH:-x64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
OUT="$DIST/ChatOverlay"
ZIP_NAME="electron-v${ELECTRON_VERSION}-win32-${ARCH}.zip"
CACHE="$DIST/$ZIP_NAME"
URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}"

mkdir -p "$DIST"

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/app/payload/version.json'))['version'])")"
TAG="v$VERSION"
echo "==> app version $VERSION (release tag $TAG)"

# app/payload/version.json is the one source of truth. Clients decide whether
# to update from the release *tag* and refuse to install a manifest whose
# version disagrees with it, so a tag that drifts from version.json makes every
# install offer an update that can never succeed. Refuse to build one.
if HEAD_TAG="$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null)" && [ "$HEAD_TAG" != "$TAG" ]; then
  echo "!! HEAD is tagged $HEAD_TAG but app/payload/version.json says $VERSION" >&2
  echo "   bump version.json and re-tag, or check out the commit that matches" >&2
  exit 1
fi

if [ ! -f "$CACHE" ]; then
  echo "==> downloading Electron ${ELECTRON_VERSION} (${ARCH})"
  curl -L --fail --retry 3 -o "$CACHE.part" "$URL"
  mv "$CACHE.part" "$CACHE"
else
  echo "==> using cached $ZIP_NAME"
fi

echo "==> unpacking runtime"
rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q "$CACHE" -d "$OUT"

echo "==> installing app"
mv "$OUT/electron.exe" "$OUT/ChatOverlay.exe"
rm -rf "$OUT/resources/app"
mkdir -p "$OUT/resources/app"
cp -r "$ROOT/app/." "$OUT/resources/app/"
cp "$ROOT/README.md" "$OUT/README.md"

# Keep the Electron-visible version in step with the payload.
python3 - "$OUT/resources/app/package.json" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as fh:
    pkg = json.load(fh)
pkg["version"] = version
with open(path, "w") as fh:
    json.dump(pkg, fh, indent=2)
    fh.write("\n")
PY

echo "==> building update manifest"
python3 "$ROOT/tools/make-payload.py" "$ROOT/app/payload" "$DIST/app-payload.json.gz"
echo "$TAG" > "$DIST/RELEASE_TAG"

if [ "${1:-}" = "--zip" ]; then
  echo "==> zipping"
  rm -f "$DIST/ChatOverlay.zip"
  (cd "$OUT" && zip -rq "$DIST/ChatOverlay.zip" .)
  echo "    $DIST/ChatOverlay.zip"
fi

echo "==> done: $OUT/ChatOverlay.exe"
echo "==> to publish (tag must be $TAG — it is what installs compare against):"
echo "    gh release create $TAG dist/ChatOverlay.zip dist/app-payload.json.gz --title \"ChatOverlay $VERSION\" --notes \"...\""
