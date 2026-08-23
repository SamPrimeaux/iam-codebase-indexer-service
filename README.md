# IAM-CODEBASE-INDEXER-SERVICE

**Inner Animal Media structural parse Worker** — static `CompiledWasm` tree-sitter for JS/TS/TSX/Python/Go.

Deploy: Cloudflare Worker `iam-codebase-indexer-service` · Git: [SamPrimeaux/iam-codebase-indexer-service](https://github.com/SamPrimeaux/iam-codebase-indexer-service) · Consumed by **inneranimalmedia.com** via service binding `IAM_CODEBASE_INDEXER`.

> Do **not** instantiate WASM from R2 bytes on the main Worker — workerd forbids runtime Wasm codegen (`Wasm code generation disallowed by embedder`).

## Main worker binding

`inneranimalmedia` / `wrangler.production.toml`:

```toml
[[services]]
binding = "IAM_CODEBASE_INDEXER"
service = "iam-codebase-indexer-service"
```

Client: `backend/agentsam/codebase/indexer-client.js` (main repo) → binding `POST /parse`.

**Auth:** `AGENTSAM_BRIDGE_KEY` on **both** Workers — used on the **service binding** path only (not a public URL).

**No public host** — `workers_dev = false`. Cron `scheduled()` self-warms WASM every 15m.

## Layout

```
iam-codebase-indexer-service/
├── wrangler.toml
├── worker/src/
│   ├── index.js                        # /health · /warm · /parse
│   ├── codebase-treesitter-runtime.js  # static import *.wasm
│   ├── codebase-treesitter-parse.js
│   ├── codebase-structural-parse.js
│   ├── web-tree-sitter.js
│   └── wasm/*.wasm
└── scripts/
    ├── sync-wasm-from-iam.sh
    └── sync-from-iam.sh                # pull latest from monorepo services/
```

## API (service binding only)

| Path | Method | Auth | Result |
|------|--------|------|--------|
| `/health` | GET/HEAD | none | liveness |
| `/warm` | GET/POST | bridge | pre-init Parser |
| `/parse` | POST | bridge | `{ symbols, call_sites, import_bindings }` |

`/poll` and `/push` remain for binding callers; not exposed on the public internet.

`context` requires `workspace_id`, `repo_full_name`, `revision_sha`, `run_id`.

## Deploy

**Ship this Worker before** a structural-first full index on main (or with the binding change).

```bash
npm install   # first time
npm run check
npx wrangler deploy -c wrangler.toml   # always -c wrangler.toml
```

Then deploy main (`deploy:fast` / `deploy:full` on Mac) so the binding is live.

## Sync from IAM monorepo

```bash
IAM_ROOT=/path/to/inneranimalmedia npm run sync
# or: bash scripts/sync-from-iam.sh
```

## Sync WASM only

```bash
npm run sync:wasm
```
