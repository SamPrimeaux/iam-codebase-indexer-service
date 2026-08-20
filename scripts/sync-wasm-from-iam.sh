#!/usr/bin/env bash
# Copy tree-sitter WASM + web-tree-sitter.js from IAM vendor/ into this service.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IAM_ROOT="${IAM_ROOT:-$(cd "$ROOT/../.." && pwd)}"
SRC="$IAM_ROOT/vendor/tree-sitter"
DST_WASM="$ROOT/worker/src/wasm"
DST_JS="$ROOT/worker/src"

if [[ ! -f "$SRC/web-tree-sitter.wasm" ]]; then
  echo "sync-wasm: missing $SRC/web-tree-sitter.wasm (set IAM_ROOT=…)" >&2
  exit 1
fi

mkdir -p "$DST_WASM"
cp -f "$SRC"/*.wasm "$DST_WASM/"
cp -f "$SRC/web-tree-sitter.js" "$DST_JS/web-tree-sitter.js"
echo "sync-wasm: ok → $DST_WASM ($(du -sh "$DST_WASM" | awk '{print $1}'))"
