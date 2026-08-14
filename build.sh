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

if [ "${1:-}" = "--zip" ]; then
  echo "==> zipping"
  rm -f "$DIST/ChatOverlay.zip"
  (cd "$OUT" && zip -rq "$DIST/ChatOverlay.zip" .)
  echo "    $DIST/ChatOverlay.zip"
fi

echo "==> done: $OUT/ChatOverlay.exe"
