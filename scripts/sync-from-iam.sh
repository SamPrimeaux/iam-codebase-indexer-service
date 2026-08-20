#!/usr/bin/env bash
# Sync IAM-CODEBASE-INDEXER-SERVICE from inneranimalmedia monorepo into this product repo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IAM_ROOT="${IAM_ROOT:-$HOME/inneranimalmedia}"
SRC="$IAM_ROOT/services/iam-codebase-indexer-service"

if [[ ! -f "$SRC/wrangler.toml" ]]; then
  echo "sync-from-iam: missing $SRC/wrangler.toml (set IAM_ROOT=…)" >&2
  exit 1
fi

rsync -a \
  --exclude node_modules \
  --exclude .wrangler \
  --exclude .dev.vars \
  --exclude .git \
  "$SRC/" "$ROOT/"

echo "sync-from-iam: ok $SRC → $ROOT"
