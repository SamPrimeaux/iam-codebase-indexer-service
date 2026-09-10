/**
 * Structural parse dispatch — JS/TS/TSX + Python/Go tree-sitter WASM.
 * Same IR: { symbols, call_sites, import_bindings }.
 * Py/Go failures throw — caller degrades file to chunks_only (no heuristic net).
 */

/** Canonical JS/TS/TSX tree-sitter lane. */
export const JS_TREESITTER_PARSER_ID = 'js-treesitter-v1';
export const STRUCTURAL_PARSER_ID = JS_TREESITTER_PARSER_ID;
/** Py/Go lanes (tree-sitter WASM). */
export const PYTHON_TREESITTER_PARSER_ID = 'py-treesitter-v1';
export const GO_TREESITTER_PARSER_ID = 'go-treesitter-v1';
/** @deprecated alias — classify/skip compatibility */
export const PYTHON_STRUCTURAL_PARSER_ID = PYTHON_TREESITTER_PARSER_ID;
/** @deprecated alias — classify/skip compatibility */
export const GO_STRUCTURAL_PARSER_ID = GO_TREESITTER_PARSER_ID;

const JS_LANGS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);

/**
 * @param {string|null|undefined} languageOrExt
 */
export function normalizeCodeLanguage(languageOrExt) {
  return String(languageOrExt || '')
    .toLowerCase()
    .replace(/^\./, '')
    .trim();
}

/**
 * @param {string|null|undefined} languageOrExt
 */
export function structuralParserIdForLanguage(languageOrExt) {
  const lang = normalizeCodeLanguage(languageOrExt);
  if (JS_LANGS.has(lang)) return STRUCTURAL_PARSER_ID;
  if (lang === 'py' || lang === 'python') return PYTHON_TREESITTER_PARSER_ID;
  if (lang === 'go') return GO_TREESITTER_PARSER_ID;
  return null;
}

/**
 * @param {{ language?: string, path?: string, classification?: string, parser_id?: string|null }} file
 */
export function structuralParserIdForFile(file) {
  if (file?.parser_id) return String(file.parser_id);
  const fromLang = structuralParserIdForLanguage(file?.language);
  if (fromLang) return fromLang;
  const base = String(file?.path || '').split('/').pop() || '';
  const at = base.lastIndexOf('.');
  return at >= 0 ? structuralParserIdForLanguage(base.slice(at + 1)) : null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

/**
 * GitHub `owner/name` for code-index identity — not a local filesystem root.
 * @param {object} context
 * @returns {string}
 */
function requireGithubRepoFullName(context) {
  const slug = String(context?.repo_full_name || '').trim();
  if (!slug || !slug.includes('/')) {
    throw new Error('repo_full_name_required');
  }
  return slug;
}

/**
 * Materialize raw matches into D1-shaped symbol rows.
 * @param {Array<object>} rawSymbols
 * @param {object} file
 * @param {{ account_id: string, repository_id: string, repo_full_name: string, revision_sha: string, run_id: string }} context
 * @param {string} language
 * @param {string} parserId
 * @param {string} structuralQuality
 * @param {string} fileHash
 */
export async function materializeStructuralSymbols(
  rawSymbols,
  file,
  context,
  language,
  parserId,
  structuralQuality,
  fileHash,
) {
  const repoFullName = requireGithubRepoFullName(context);
  const symbols = [];
  for (const match of rawSymbols || []) {
    if (!match?.node_name || !match?.node_type) continue;
    const identity = [
      context.workspace_id,
      repoFullName,
      context.revision_sha,
      // Must match main worker: generation in id hash so force rebuilds don't PK-collide.
      context.index_generation_id != null && String(context.index_generation_id).trim()
        ? String(context.index_generation_id).trim()
        : '',
      file.path,
      fileHash,
      match.node_type,
      match.node_name,
      match.line_start,
    ].join('|');
    const id = `node_${(await sha256Hex(identity)).slice(0, 32)}`;
    symbols.push({
      id,
      workspace_id: context.workspace_id,
      // D1/PG code-index scope key — GitHub owner/name only.
      repo_full_name: repoFullName,
      revision_sha: context.revision_sha,
      file_path: file.path,
      file_hash: fileHash,
      git_blob_sha: file.git_blob_sha || null,
      index_job_id: context.run_id,
      index_generation_id:
        context.index_generation_id != null && String(context.index_generation_id).trim()
          ? String(context.index_generation_id).trim()
          : null,
      node_type: match.node_type,
      node_name: String(match.node_name),
      signature: match.signature || null,
      docstring: match.docstring || null,
      line_start: Number(match.line_start) || 1,
      line_end: Number(match.line_end) || Number(match.line_start) || 1,
      is_exported: match.exported || match.is_exported ? 1 : 0,
      is_default_export: match.default_export || match.is_default_export ? 1 : 0,
      language,
      parser_id: parserId,
      structural_quality: structuralQuality,
      parent_name: match.parent_name || null,
    });
  }
  return symbols;
}

/**
 * @param {string} content
 * @param {{ path: string, language?: string, git_blob_sha?: string|null, classification?: string, parser_id?: string|null }} file
 * @param {{ workspace_id: string, repo_full_name: string, revision_sha: string, run_id: string, index_generation_id?: string|null, file_hash?: string, parser_id?: string, env?: any }} context
 *   `repo_full_name` = GitHub owner/name. Not a local checkout path.
 */
export async function parseStructuralForFile(content, file, context) {
  const lang = normalizeCodeLanguage(
    file?.language ||
      (() => {
        const base = String(file?.path || '').split('/').pop() || '';
        const at = base.lastIndexOf('.');
        return at >= 0 ? base.slice(at + 1) : '';
      })(),
  );
  const env = context?.env || null;
  const parserId =
    context.parser_id ||
    file?.parser_id ||
    structuralParserIdForLanguage(lang) ||
    STRUCTURAL_PARSER_ID;

  if (JS_LANGS.has(lang)) {
    const { parseJsTreesitter } = await import('./codebase-treesitter-parse.js');
    return parseJsTreesitter(content, { ...file, language: lang }, {
      ...context,
      parser_id: JS_TREESITTER_PARSER_ID,
    }, env);
  }
  if (lang === 'py' || lang === 'python') {
    const { parsePythonTreesitter } = await import('./codebase-treesitter-parse.js');
    return parsePythonTreesitter(
      content,
      { ...file, language: 'py' },
      { ...context, parser_id: PYTHON_TREESITTER_PARSER_ID },
      env,
    );
  }
  if (lang === 'go') {
    const { parseGoTreesitter } = await import('./codebase-treesitter-parse.js');
    return parseGoTreesitter(
      content,
      { ...file, language: 'go' },
      { ...context, parser_id: GO_TREESITTER_PARSER_ID },
      env,
    );
  }
  return { symbols: [], call_sites: [], import_bindings: [] };
}

/**
 * Nearest enclosing function-like symbol for a line (call-site owner).
 * @param {Array<object>} symbols
 * @param {number} line
 */
export function nearestEnclosingSymbol(symbols, line) {
  let winner = null;
  let bestSpan = Infinity;
  for (const s of symbols || []) {
    const start = Number(s.line_start) || 0;
    const end = Number(s.line_end) || start;
    if (line < start || line > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      winner = s;
    }
  }
  return winner;
}
