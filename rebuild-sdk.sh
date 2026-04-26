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
cd "$OPENCODE_DIR/packages/opencode/dist/nanoclaw"
bun pm pack --destination "$DEPS_DIR"
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
