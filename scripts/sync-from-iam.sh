#!/usr/bin/env bash
# Retired: the standalone iam-codebase-indexer-service repo is the runtime authority.
# inneranimalmedia owns the caller/schema contract and no longer contains
# services/iam-codebase-indexer-service to rsync from.
set -euo pipefail
cat >&2 <<'EOF'
sync-from-iam is retired.

Runtime authority: SamPrimeaux/iam-codebase-indexer-service
Caller/schema contract: SamPrimeaux/inneranimalmedia backend/agentsam/codebase/indexer-client.js

Use `npm run sync:wasm` only when intentionally refreshing vendored tree-sitter assets.
EOF
exit 2
