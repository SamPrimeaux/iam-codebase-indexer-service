/**
 * IAM-CODEBASE-INDEXER-SERVICE
 * Sibling Worker: structural tree-sitter parse only (static CompiledWasm).
 * Main Worker binds as IAM_CODEBASE_INDEXER — queue/crawl/embed/activate stay on main.
 *
 * Public workers.dev (optional): /health · /poll (no auth) · /push · /warm (bridge auth).
 * Cron scheduled() self-warms so inneranimalmedia need not call /warm per index batch.
 */

import { parseStructuralForFile } from './codebase-structural-parse.js';
import { ensureTreeSitterRuntime } from './codebase-treesitter-runtime.js';
import { verifyBridgeKey } from './bridge-key-auth.js';

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
function requireBridgeAuth(request, env) {
  if (!verifyBridgeKey(request, env)) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

/**
 * @param {any} env
 */
function publicBaseUrl(env) {
  const fromVar = env?.PUBLIC_WORKERS_DEV_URL != null ? String(env.PUBLIC_WORKERS_DEV_URL).trim() : '';
  if (fromVar) return fromVar.replace(/\/$/, '');
  return null;
}

/**
 * Liveness — no auth (uptime monitors, CF health checks).
 * @param {Request} request
 * @param {any} env
 */
function handleHealth(request, env) {
  const url = new URL(request.url);
  const deep = url.searchParams.get('deep') === '1';
  if (deep) {
    requireBridgeAuth(request, env);
  }
  return json({
    ok: true,
    service: SERVICE_NAME,
    product: 'IAM-CODEBASE-INDEXER-SERVICE',
    role: 'structural_parse',
    wasm: 'CompiledWasm_static_import',
    public_url: publicBaseUrl(env),
    endpoints: {
      health: '/health',
      poll: '/poll',
      push: '/push',
      warm: '/warm',
      parse: '/parse',
    },
    deep,
  });
}

/**
 * Minimal pull probe — tiny payload for external poll monitors.
 */
function handlePoll() {
  return json({ ok: true, service: SERVICE_NAME, mode: 'poll' });
}

/**
 * @param {Request} request
 * @param {any} env
 */
async function handleParse(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  requireBridgeAuth(request, env);

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
 * @param {{ source?: string }} [opts]
 */
async function handleWarm(opts = {}) {
  const t0 = Date.now();
  await ensureTreeSitterRuntime();
  return json({
    ok: true,
    service: SERVICE_NAME,
    warm: true,
    source: opts.source || 'http',
    elapsed_ms: Date.now() - t0,
  });
}

/**
 * Push warm — cron / external webhook hits workers.dev instead of main Worker binding.
 * @param {Request} request
 * @param {any} env
 */
async function handlePush(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  requireBridgeAuth(request, env);
  return handleWarm({ source: 'push' });
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
        if (method !== 'GET' && method !== 'HEAD') {
          return json({ ok: false, error: 'method_not_allowed' }, 405);
        }
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'x-iam-service': SERVICE_NAME, 'cache-control': 'no-store' },
          });
        }
        return handleHealth(request, env);
      }

      if (path === '/poll' || path === '/api/poll') {
        if (method !== 'GET' && method !== 'HEAD') {
          return json({ ok: false, error: 'method_not_allowed' }, 405);
        }
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'x-iam-service': SERVICE_NAME, 'cache-control': 'no-store' },
          });
        }
        return handlePoll();
      }

      if (path === '/push' || path === '/api/push') {
        return await handlePush(request, env);
      }

      if (path === '/warm' || path === '/api/warm') {
        if (method !== 'POST' && method !== 'GET') {
          return json({ ok: false, error: 'method_not_allowed' }, 405);
        }
        requireBridgeAuth(request, env);
        return await handleWarm({ source: 'warm' });
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

  /**
   * Self-warm on cron — keeps WASM hot without main Worker batch warm.
   * @param {ScheduledEvent} _event
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      ensureTreeSitterRuntime()
        .then(() => {
          console.log('[indexer] scheduled_warm_ok', { service: SERVICE_NAME });
        })
        .catch((err) => {
          console.warn('[indexer] scheduled_warm_failed', err?.message || err);
        }),
    );
  },
};
