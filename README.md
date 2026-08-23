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

Client: `src/core/codebase-indexer-service-client.js` → `POST /parse`.

**Required in production:** shared secret `AGENTSAM_BRIDGE_KEY` on **both** this Worker and `inneranimalmedia` (`Authorization: Bearer` or `X-IAM-Service-Key`). Binding: `IAM_CODEBASE_INDEXER` → this service.

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

## API

| Path | Method | Auth | Result |
|------|--------|------|--------|
| `/health` | GET/HEAD | none (`?deep=1` needs bridge) | liveness + endpoint map |
| `/poll` | GET/HEAD | none | minimal uptime probe |
| `/push` | POST | `AGENTSAM_BRIDGE_KEY` | warm WASM (cron/webhook target) |
| `/warm` | GET/POST | bridge | pre-init Parser |
| `/parse` | POST | bridge | `{ symbols, call_sites, import_bindings }` |

Public host (optional): `https://iam-codebase-indexer-service.meauxbility.workers.dev`

Cron `*/15 * * * *` self-warms via `scheduled()` — main Worker should set
`CODEBASE_INDEXER_EXTERNAL_WARM=1` to skip per-batch warm on the binding.

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
