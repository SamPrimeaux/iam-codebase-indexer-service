/**
 * IAM-CODEBASE-INDEXER-SERVICE
 * Sibling Worker: structural tree-sitter parse only (static CompiledWasm).
 * Main Worker binds as IAM_CODEBASE_INDEXER — queue/crawl/embed/activate stay on main.
 */

import { parseStructuralForFile } from './codebase-structural-parse.js';
import { ensureTreeSitterRuntime } from './codebase-treesitter-runtime.js';

const SERVICE_NAME = 'iam-codebase-indexer-service';

/**
 * @param {any} body
 * @param {number} [status]
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-iam-service': SERVICE_NAME,
    },
  });
}

/**
 * @param {Request} request
 * @param {any} env
 */
function assertServiceKey(request, env) {
  // AGENTSAM_BRIDGE_KEY supersedes IAM_SERVICE_KEY as of 2026-08. Keep both
  // accepted until the bridge key is confirmed provisioned on this Worker
  // (wrangler secret put AGENTSAM_BRIDGE_KEY --name iam-codebase-indexer-service).
  const bridgeKey = env?.AGENTSAM_BRIDGE_KEY != null ? String(env.AGENTSAM_BRIDGE_KEY).trim() : '';
  const legacyKey = env?.IAM_SERVICE_KEY != null ? String(env.IAM_SERVICE_KEY).trim() : '';
  if (!bridgeKey && !legacyKey) return;
  const got = request.headers.get('X-IAM-Service-Key') || '';
  if (got !== bridgeKey && got !== legacyKey) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

/**
 * @param {Request} request
 * @param {any} env
 */
async function handleParse(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  assertServiceKey(request, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const content = body?.content;
  if (typeof content !== 'string') {
    return json({ ok: false, error: 'content_required' }, 400);
  }
  const file = body?.file && typeof body.file === 'object' ? body.file : {};
  const context = body?.context && typeof body.context === 'object' ? body.context : {};
  if (!context.workspace_id || !context.repo_full_name || !context.revision_sha || !context.run_id) {
    return json(
      {
        ok: false,
        error: 'context_required',
        need: ['workspace_id', 'repo_full_name', 'revision_sha', 'run_id'],
      },
      400,
    );
  }

  const t0 = Date.now();
  try {
    const parsed = await parseStructuralForFile(content, file, {
      ...context,
      env,
    });
    return json({
      ok: true,
      service: SERVICE_NAME,
      elapsed_ms: Date.now() - t0,
      symbols: parsed?.symbols || [],
      call_sites: parsed?.call_sites || [],
      import_bindings: parsed?.import_bindings || [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'parse_failed');
    return json(
      {
        ok: false,
        service: SERVICE_NAME,
        error: message.slice(0, 500),
        elapsed_ms: Date.now() - t0,
      },
      422,
    );
  }
}

/**
 * @param {any} env
 */
async function handleWarm(env) {
  const t0 = Date.now();
  await ensureTreeSitterRuntime();
  return json({
    ok: true,
    service: SERVICE_NAME,
    warm: true,
    elapsed_ms: Date.now() - t0,
  });
}

export default {
  /**
   * @param {Request} request
   * @param {any} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    try {
      if (path === '/health' || path === '/api/health') {
        return json({
          ok: true,
          service: SERVICE_NAME,
          product: 'IAM-CODEBASE-INDEXER-SERVICE',
          role: 'structural_parse',
          wasm: 'CompiledWasm_static_import',
        });
      }

      if (path === '/warm' || path === '/api/warm') {
        if (method !== 'POST' && method !== 'GET') {
          return json({ ok: false, error: 'method_not_allowed' }, 405);
        }
        assertServiceKey(request, env);
        return await handleWarm(env);
      }

      if (path === '/parse' || path === '/api/parse') {
        return await handleParse(request, env);
      }

      return json({ ok: false, error: 'not_found', service: SERVICE_NAME }, 404);
    } catch (err) {
      const status = Number(err?.status) || 500;
      const message = err instanceof Error ? err.message : String(err || 'error');
      return json({ ok: false, error: message.slice(0, 300), service: SERVICE_NAME }, status);
    }
  },
};
