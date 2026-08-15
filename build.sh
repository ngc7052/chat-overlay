#!/usr/bin/env bash
#
# Assemble the portable Windows build.
#
# Compiles the TypeScript sources, downloads the official Electron win32-x64
# runtime, and drops the compiled app into resources/app. No Windows toolchain,
# no wine, no code-signing setup — and the shipped app still has no runtime
# dependencies of its own.
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

VERSION="$(node -p "require('$ROOT/package.json').version")"
TAG="v$VERSION"
echo "==> app version $VERSION (release tag $TAG)"

# package.json is the one source of truth. Clients decide whether to update from
# the release *tag* and refuse to install a manifest whose version disagrees with
# it, so a tag that drifts from package.json makes every install offer an update
# that can never succeed. Refuse to build one.
if HEAD_TAG="$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null)" && [ "$HEAD_TAG" != "$TAG" ]; then
  echo "!! HEAD is tagged $HEAD_TAG but package.json says $VERSION" >&2
  echo "   bump package.json and re-tag, or check out the commit that matches" >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "==> installing dev dependencies"
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --prefix "$ROOT"
fi

echo "==> compiling"
npm run --prefix "$ROOT" --silent build

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

echo "==> building update manifest"
node "$DIST/tools/make-payload.cjs" "$ROOT/app/payload" "$DIST/app-payload.json.gz"
echo "$TAG" > "$DIST/RELEASE_TAG"

if [ "${1:-}" = "--zip" ]; then
  echo "==> zipping"
  rm -f "$DIST/ChatOverlay.zip"
  (cd "$OUT" && zip -rq "$DIST/ChatOverlay.zip" .)
  echo "    $DIST/ChatOverlay.zip"
fi

echo "==> done: $OUT/ChatOverlay.exe"
echo "==> releases are automatic: bump package.json version and merge to master"
