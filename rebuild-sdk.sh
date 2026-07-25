#!/bin/bash
# Rebuild OpenCode from local source, pack as tarball for container use,
# and optionally rebuild the container image.
#
# Usage: ./rebuild-sdk.sh [--no-container]

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="$ROOT_DIR/nanoclaw"
OPENCODE_DIR="$ROOT_DIR/opencode"
DEPS_DIR="$NANOCLAW_DIR/container/deps"

echo "=== Installing OpenCode dependencies ==="
cd "$OPENCODE_DIR"
bun install

echo ""
echo "=== Building OpenCode (nanoclaw target) ==="
bun run packages/opencode/script/build-nanoclaw.ts
echo "Build complete."

echo ""
echo "=== Packing tarball ==="
mkdir -p "$DEPS_DIR"
# Drop any previous tarball so deps/ holds only the current build (small, unambiguous COPY context).
rm -f "$DEPS_DIR"/opencode-*.tgz
cd "$OPENCODE_DIR/packages/opencode/dist/nanoclaw"
bun pm pack --destination "$DEPS_DIR"

# Stamp a content hash into the filename. Any change to the built bundle yields a
# NEW filename, so the container's `COPY deps/` layer (and bun install) can never
# reuse a stale same-named tarball — no `docker buildx prune` needed. The tracked
# agent-runner/package.json pin is rewritten to match (targeted edit, JSON left as-is).
PACKED=$(ls "$DEPS_DIR"/opencode-*.tgz | head -1)
HASH=$( { shasum -a 256 "$PACKED" 2>/dev/null || sha256sum "$PACKED"; } | cut -c1-12 )
BASE=$(basename "$PACKED" .tgz)          # e.g. opencode-1.17.11
HASHED_NAME="${BASE}-${HASH}.tgz"        # e.g. opencode-1.17.11-a1b2c3d4e5f6.tgz
mv "$PACKED" "$DEPS_DIR/$HASHED_NAME"

PKG="$NANOCLAW_DIR/container/agent-runner/package.json"
sed -E "s#(\"opencode\": \"file:\./deps/)opencode-[^\"]*\.tgz#\1${HASHED_NAME}#" "$PKG" > "$PKG.tmp" && mv "$PKG.tmp" "$PKG"
echo "Packed: $HASHED_NAME (pin updated in agent-runner/package.json)"
echo "Tarballs in $DEPS_DIR:"
ls -lh "$DEPS_DIR"/opencode-*.tgz

if [ "$1" = "--no-container" ]; then
  echo ""
  echo "Skipping container build (--no-container)."
  echo "Run nanoclaw/container/build.sh to rebuild the container image."
  exit 0
fi

echo ""
echo "=== Building container image ==="
cd "$NANOCLAW_DIR"
./container/build.sh

echo ""
echo "Done. Restart service with: launchctl kickstart -k gui/\$(id -u)/com.nanoclaw-opencode"
