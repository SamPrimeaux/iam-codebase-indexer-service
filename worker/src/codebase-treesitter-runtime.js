/**
 * IAM-CODEBASE-INDEXER-SERVICE — tree-sitter runtime with static CompiledWasm imports.
 * workerd precompiles *.wasm at deploy; never WebAssembly.compile/instantiate from bytes.
 */

import coreWasm from './wasm/web-tree-sitter.wasm';
import pythonWasm from './wasm/tree-sitter-python.wasm';
import goWasm from './wasm/tree-sitter-go.wasm';
import javascriptWasm from './wasm/tree-sitter-javascript.wasm';
import typescriptWasm from './wasm/tree-sitter-typescript.wasm';
import tsxWasm from './wasm/tree-sitter-tsx.wasm';

const LANG_WASM = {
  python: pythonWasm,
  go: goWasm,
  javascript: javascriptWasm,
  typescript: typescriptWasm,
  tsx: tsxWasm,
};

const PARSER_INIT_TIMEOUT_MS = 15_000;
const LANGUAGE_LOAD_TIMEOUT_MS = 15_000;

/** @type {Promise<{ Parser: any, Language: any, Query: any }>|null} */
let initPromise = null;
/** @type {Map<string, any>} */
const languageCache = new Map();

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} code
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${code}:timeout_ms=${ms}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * @param {WebAssembly.Module} module
 * @param {WebAssembly.Imports} imports
 * @param {(instance: WebAssembly.Instance, module: WebAssembly.Module) => void} receiveInstance
 * @returns {Promise<WebAssembly.Instance>}
 */
async function instantiateCompiledWasm(module, imports, receiveInstance) {
  const result = await WebAssembly.instantiate(module, imports);
  const instance = result instanceof WebAssembly.Instance ? result : result?.instance;
  if (!(instance instanceof WebAssembly.Instance)) {
    throw new Error('treesitter_wasm_instantiate_invalid_result');
  }
  receiveInstance(instance, module);
  return instance;
}

/**
 * @param {unknown} err
 * @param {string} code
 */
function asTreesitterError(err, code) {
  if (err instanceof Error) {
    if (String(err.message || '').startsWith('treesitter_')) return err;
    const wrapped = new Error(`${code}:${err.message || err.name || 'failed'}`);
    wrapped.cause = err;
    return wrapped;
  }
  return new Error(`${code}:${String(err || 'failed')}`);
}

/**
 * @returns {Promise<{ Parser: any, Language: any, Query: any }>}
 */
export async function ensureTreeSitterRuntime() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const mod = await import('./web-tree-sitter.js');
    const Parser = mod.Parser || mod.default?.Parser || mod.default;
    const Language = mod.Language || mod.default?.Language;
    const Query = mod.Query || mod.default?.Query;
    if (!Parser?.init || !Language?.load || !Query) {
      throw new Error('treesitter_web_exports_missing');
    }

    await withTimeout(
      Parser.init({
        instantiateWasm(info, receiveInstance) {
          return instantiateCompiledWasm(coreWasm, info, receiveInstance).catch((err) => {
            throw asTreesitterError(err, 'treesitter_wasm_instantiate_failed');
          });
        },
      }),
      PARSER_INIT_TIMEOUT_MS,
      'treesitter_parser_init',
    );

    return { Parser, Language, Query };
  })().catch((e) => {
    initPromise = null;
    throw asTreesitterError(e, 'treesitter_runtime_init_failed');
  });

  return initPromise;
}

/**
 * @param {'python'|'go'|'javascript'|'typescript'|'tsx'} langKey
 */
export async function loadTreeSitterLanguage(langKey) {
  const cached = languageCache.get(langKey);
  if (cached) return cached;
  const rt = await ensureTreeSitterRuntime();
  const wasmModule = LANG_WASM[langKey];
  if (!wasmModule) throw new Error(`treesitter_lang_unsupported:${langKey}`);

  let language;
  try {
    language = await withTimeout(
      rt.Language.load(wasmModule),
      LANGUAGE_LOAD_TIMEOUT_MS,
      `treesitter_language_load:${langKey}`,
    );
  } catch (err) {
    throw asTreesitterError(err, `treesitter_language_load_failed:${langKey}`);
  }

  languageCache.set(langKey, language);
  return language;
}

/**
 * @param {'python'|'go'|'javascript'|'typescript'|'tsx'} langKey
 * @param {string} source
 * @param {string} querySource
 * @returns {Promise<{ tree: any, matches: any[], Query: any, language: any, parser: any }>}
 */
export async function parseWithTreeSitterQuery(env, langKey, source, querySource, _opts = {}) {
  // env/opts kept for API parity with main Worker module (callers pass env first).
  void env;
  void _opts;
  const rt = await ensureTreeSitterRuntime();
  const language = await loadTreeSitterLanguage(langKey);
  let parser;
  let tree;
  let query;
  let matches;
  try {
    parser = new rt.Parser();
    parser.setLanguage(language);
    tree = parser.parse(String(source ?? ''));
    query = new rt.Query(language, querySource);
    matches = query.matches(tree.rootNode);
  } catch (err) {
    throw asTreesitterError(err, 'treesitter_parse_failed');
  }
  return { tree, matches, Query: rt.Query, language, parser };
}
