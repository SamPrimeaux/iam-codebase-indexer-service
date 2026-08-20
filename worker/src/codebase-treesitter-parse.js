/**
 * Tree-sitter WASM structural parse for JS/TS/TSX/Python/Go → one IR.
 * Failures throw — no heuristic fallback (index degrades file to chunks_only).
 */

import {
  JS_TREESITTER_PARSER_ID,
  PYTHON_TREESITTER_PARSER_ID,
  GO_TREESITTER_PARSER_ID,
  materializeStructuralSymbols,
  nearestEnclosingSymbol,
} from './codebase-structural-parse.js';
import { parseWithTreeSitterQuery } from './codebase-treesitter-runtime.js';

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

function lineOf(node) {
  return (node?.startPosition?.row ?? 0) + 1;
}

function endLineOf(node) {
  return (node?.endPosition?.row ?? node?.startPosition?.row ?? 0) + 1;
}

function stripQuotes(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('`') && t.endsWith('`')) return t.slice(1, -1);
  return t;
}

const PYTHON_QUERY = `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @class
(call function: (identifier) @callee)
(call function: (attribute attribute: (identifier) @callee))
(import_from_statement module_name: (dotted_name) @mod)
(import_statement name: (dotted_name) @mod)
`;

const GO_QUERY = `
(function_declaration name: (identifier) @name) @fn
(method_declaration name: (field_identifier) @name) @method
(type_spec name: (type_identifier) @name type: (struct_type)) @struct
(type_spec name: (type_identifier) @name type: (interface_type)) @iface
(call_expression function: (identifier) @callee)
(call_expression function: (selector_expression field: (field_identifier) @callee))
(import_spec path: (interpreted_string_literal) @path)
`;

const JS_QUERY = `
(function_declaration name: (identifier) @name) @function
(class_declaration name: (_) @name) @class
(method_definition name: (property_identifier) @name) @method
(lexical_declaration
  (variable_declarator name: (identifier) @binding_name value: (arrow_function) @binding_value) @binding)
(variable_declaration
  (variable_declarator name: (identifier) @binding_name value: (function_expression) @binding_value) @binding)
(function_expression) @function_expression
(arrow_function) @arrow
(call_expression function: (identifier) @callee) @call
(call_expression
  function: (member_expression object: (_) @member_object property: (property_identifier) @callee))
  @member_call
(call_expression function: (subscript_expression) @dynamic_fn) @dynamic_call
(import_statement source: (string) @source) @import
(export_statement source: (string) @source) @export
`;

function captureMap(match) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const c of match.captures || []) {
    out[c.name] = c.node;
  }
  return out;
}

function importBindingsFromStatement(importNode, source, line) {
  const bindings = [];
  let clause = null;
  for (let i = 0; i < importNode.childCount; i += 1) {
    if (importNode.child(i)?.type === 'import_clause') {
      clause = importNode.child(i);
      break;
    }
  }
  if (!clause) return bindings;
  for (let i = 0; i < clause.childCount; i += 1) {
    const child = clause.child(i);
    if (child?.type === 'identifier') {
      bindings.push({
        local: child.text,
        imported: 'default',
        specifier: source,
        line,
        re_export: false,
      });
    } else if (child?.type === 'namespace_import') {
      const local = child.child(0)?.text;
      if (local) {
        bindings.push({
          local,
          imported: '*',
          specifier: source,
          line,
          re_export: false,
        });
      }
    } else if (child?.type === 'named_imports') {
      for (let j = 0; j < child.childCount; j += 1) {
        const specifier = child.child(j);
        if (specifier?.type !== 'import_specifier') continue;
        const name = specifier.childForFieldName('name')?.text;
        const alias = specifier.childForFieldName('alias')?.text;
        if (name) {
          bindings.push({
            local: alias || name,
            imported: name,
            specifier: source,
            line,
            re_export: false,
          });
        }
      }
    }
  }
  return bindings;
}

/** Tree-sitter node wrappers are not always === across capture vs field lookup. */
function sameTreeSpan(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.type === b.type &&
    Number(a.startIndex) === Number(b.startIndex) &&
    Number(a.endIndex) === Number(b.endIndex)
  );
}

/**
 * Name for a function/arrow only when it is the direct `value` of a
 * `variable_declarator` whose binding is a plain identifier.
 * Nested callbacks under a destructuring LHS must not steal the pattern text
 * (or the outer binding name).
 */
function enclosingVariableName(node) {
  let current = node?.parent;
  while (current) {
    if (current.type === 'variable_declarator') {
      const value = current.childForFieldName('value');
      // Direct binding only — not a callback nested inside the RHS.
      if (!sameTreeSpan(value, node)) return null;
      const nameNode = current.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'identifier') return null;
      const text = nameNode.text;
      return text != null && String(text).trim() ? String(text) : null;
    }
    // Do not walk past another declarator / statement boundary looking for a name.
    if (
      current.type === 'lexical_declaration' ||
      current.type === 'variable_declaration' ||
      current.type === 'program' ||
      current.type === 'statement_block'
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function enclosingClassName(node) {
  let current = node?.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      return current.childForFieldName('name')?.text || null;
    }
    current = current.parent;
  }
  return null;
}

function isExportedJs(node) {
  let current = node?.parent;
  while (current) {
    if (current.type === 'export_statement') return true;
    if (current.type === 'program') break;
    current = current.parent;
  }
  return false;
}

function jsLanguageKey(language) {
  const lang = String(language || '').toLowerCase().replace(/^\./, '').trim();
  if (lang === 'ts') return 'typescript';
  if (lang === 'tsx') return 'tsx';
  return 'javascript';
}

/**
 * Parse JavaScript-family source into the shared structural IR.
 * @param {string} content
 * @param {object} file
 * @param {object} context
 * @param {any} env
 */
function parseOptsFromContext(context) {
  const jobId =
    context?.run_id != null
      ? String(context.run_id).trim()
      : context?.job_id != null
        ? String(context.job_id).trim()
        : '';
  return jobId ? { jobId } : {};
}

export async function parseJsTreesitter(content, file, context, env) {
  const fileHash = context.file_hash || (await sha256Hex(content));
  const parsed = await parseWithTreeSitterQuery(
    env,
    jsLanguageKey(file?.language || file?.path),
    content,
    JS_QUERY,
    parseOptsFromContext(context),
  );
  const raw = [];
  const importBindings = [];
  const callSitesRaw = [];
  const seenSymbols = new Set();
  const seenImports = new Set();
  const seenCalls = new Set();

  for (const match of parsed.matches) {
    const cap = captureMap(match);
    if (cap.import) {
      const source = stripQuotes(cap.source?.text || '');
      const line = lineOf(cap.import);
      const key = `${source}|${line}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        raw.push({
          node_type: 'import',
          node_name: source,
          exported: false,
          line_start: line,
          line_end: endLineOf(cap.import),
          signature: String(cap.import.text || '').split('\n')[0].slice(0, 200),
        });
        importBindings.push(...importBindingsFromStatement(cap.import, source, line));
      }
      continue;
    }
    if (cap.export && cap.source) {
      const source = stripQuotes(cap.source.text);
      const line = lineOf(cap.export);
      const key = `export:${source}|${line}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        raw.push({
          node_type: 'import',
          node_name: source,
          exported: true,
          line_start: line,
          line_end: endLineOf(cap.export),
          signature: String(cap.export.text || '').split('\n')[0].slice(0, 200),
          re_export: true,
        });
      }
      continue;
    }
    if (cap.class && cap.name) {
      const key = `class|${cap.name.text}|${lineOf(cap.class)}`;
      if (!seenSymbols.has(key)) {
        seenSymbols.add(key);
        raw.push({
          node_type: 'class',
          node_name: cap.name.text,
          exported: isExportedJs(cap.class),
          line_start: lineOf(cap.class),
          line_end: endLineOf(cap.class),
          signature: String(cap.class.text || '').split('\n')[0].slice(0, 200),
        });
      }
      continue;
    }
    if (cap.method && cap.name) {
      const key = `method|${cap.name.text}|${lineOf(cap.method)}`;
      if (!seenSymbols.has(key)) {
        seenSymbols.add(key);
        raw.push({
          node_type: 'method',
          node_name: cap.name.text,
          exported: false,
          line_start: lineOf(cap.method),
          line_end: endLineOf(cap.method),
          signature: String(cap.method.text || '').split('\n')[0].slice(0, 200),
          parent_name: enclosingClassName(cap.method),
        });
      }
      continue;
    }
    if (cap.function && cap.name) {
      const key = `function|${cap.name.text}|${lineOf(cap.function)}`;
      if (!seenSymbols.has(key)) {
        seenSymbols.add(key);
        raw.push({
          node_type: 'function',
          node_name: cap.name.text,
          exported: isExportedJs(cap.function),
          line_start: lineOf(cap.function),
          line_end: endLineOf(cap.function),
          signature: String(cap.function.text || '').split('\n')[0].slice(0, 200),
        });
      }
      continue;
    }
    if (cap.binding && cap.binding_name && cap.binding_value) {
      const name = cap.binding_name.text;
      const key = `binding|${name}|${lineOf(cap.binding)}`;
      if (!seenSymbols.has(key)) {
        seenSymbols.add(key);
        raw.push({
          node_type: 'arrow_function',
          node_name: name,
          exported: isExportedJs(cap.binding),
          line_start: lineOf(cap.binding),
          line_end: endLineOf(cap.binding_value),
          signature: String(cap.binding.text || '').split('\n')[0].slice(0, 200),
        });
      }
      continue;
    }
    if (cap.function_expression || cap.arrow) {
      const node = cap.function_expression || cap.arrow;
      const name = enclosingVariableName(node);
      if (name) {
        const key = `binding|${name}|${lineOf(node)}`;
        if (!seenSymbols.has(key)) {
          seenSymbols.add(key);
          raw.push({
            node_type: cap.arrow ? 'arrow_function' : 'function',
            node_name: name,
            exported: isExportedJs(node),
            line_start: lineOf(node),
            line_end: endLineOf(node),
            signature: String(node.text || '').split('\n')[0].slice(0, 200),
          });
        }
      }
      continue;
    }
    if (cap.dynamic_call) {
      const node = cap.dynamic_call;
      const key = `dyn|${lineOf(node)}|${cap.dynamic_fn?.text || ''}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        callSitesRaw.push({
          line: lineOf(node),
          callee_name: null,
          member_path: null,
          dynamic: true,
        });
      }
      continue;
    }
    if (cap.call || cap.member_call) {
      const node = cap.call || cap.member_call;
      const callee = cap.callee?.text || null;
      if (!callee) continue;
      const key = `${lineOf(node)}|${callee}|${cap.member_object?.text || ''}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        callSitesRaw.push({
          line: lineOf(node),
          callee_name: callee,
          member_path: cap.member_object ? `${cap.member_object.text}.${callee}` : null,
          dynamic: false,
        });
      }
    }
  }

  const language = String(file?.language || '').toLowerCase();
  const symbols = await materializeStructuralSymbols(
    raw,
    file,
    context,
    language === 'tsx' ? 'tsx' : 'js',
    JS_TREESITTER_PARSER_ID,
    'treesitter',
    fileHash,
  );
  const functionLike = symbols.filter((s) =>
    ['function', 'method', 'arrow_function', 'component', 'hook'].includes(s.node_type),
  );
  const call_sites = [];
  for (const cs of callSitesRaw) {
    const enclosing = nearestEnclosingSymbol(functionLike, cs.line);
    if (!enclosing) continue;
    call_sites.push({
      ...cs,
      enclosing_node_id: enclosing.id,
      enclosing_name: enclosing.node_name,
      enclosing_line_start: enclosing.line_start,
    });
  }
  return { symbols, call_sites, import_bindings: importBindings };
}

function isExportedPy(name) {
  return Boolean(name && !String(name).startsWith('_'));
}

function isExportedGo(name) {
  return Boolean(name && /^[A-Z]/.test(name));
}

function findParentClassName(defNode) {
  let n = defNode?.parent;
  while (n) {
    if (n.type === 'class_definition') {
      for (let i = 0; i < n.childCount; i += 1) {
        const ch = n.child(i);
        if (ch?.type === 'identifier') return ch.text;
      }
    }
    n = n.parent;
  }
  return null;
}

function goReceiverType(methodNode) {
  for (let i = 0; i < methodNode.childCount; i += 1) {
    const ch = methodNode.child(i);
    if (ch?.type !== 'parameter_list') continue;
    // First parameter_list is receiver.
    const text = ch.text || '';
    const m = text.match(/\*?\s*([A-Za-z_][\w]*)\s*\)/);
    if (m) return m[1];
    break;
  }
  return null;
}

/**
 * @param {string} content
 * @param {object} file
 * @param {object} context
 * @param {any} env
 */
export async function parsePythonTreesitter(content, file, context, env) {
  const fileHash = context.file_hash || (await sha256Hex(content));
  const parsed = await parseWithTreeSitterQuery(
    env,
    'python',
    content,
    PYTHON_QUERY,
    parseOptsFromContext(context),
  );

  /** @type {Array<object>} */
  const raw = [];
  /** @type {Array<object>} */
  const importBindings = [];
  /** @type {Array<object>} */
  const callSitesRaw = [];

  for (const match of parsed.matches) {
    const cap = captureMap(match);
    if (cap.class && cap.name) {
      raw.push({
        node_type: 'class',
        node_name: cap.name.text,
        exported: isExportedPy(cap.name.text),
        line_start: lineOf(cap.class),
        line_end: endLineOf(cap.class),
        signature: String(cap.class.text || '').split('\n')[0].slice(0, 200),
      });
      continue;
    }
    if (cap.def && cap.name) {
      const parent = findParentClassName(cap.def);
      raw.push({
        node_type: parent ? 'method' : 'function',
        node_name: cap.name.text,
        exported: isExportedPy(cap.name.text),
        line_start: lineOf(cap.def),
        line_end: endLineOf(cap.def),
        signature: String(cap.def.text || '').split('\n')[0].slice(0, 200),
        parent_name: parent,
      });
      continue;
    }
    if (cap.mod) {
      const spec = cap.mod.text;
      raw.push({
        node_type: 'import',
        node_name: spec,
        exported: false,
        line_start: lineOf(cap.mod),
        line_end: lineOf(cap.mod),
        signature: `import ${spec}`.slice(0, 200),
      });
      // Best-effort binding: module basename as local.
      const local = String(spec).split('.').pop();
      if (local) {
        importBindings.push({
          local,
          imported: local,
          specifier: spec,
          line: lineOf(cap.mod),
          re_export: false,
        });
      }
      continue;
    }
    if (cap.callee) {
      callSitesRaw.push({
        line: lineOf(cap.callee),
        callee_name: cap.callee.text,
        member_path: null,
        dynamic: false,
      });
    }
  }

  const symbols = await materializeStructuralSymbols(
    raw,
    file,
    context,
    'py',
    PYTHON_TREESITTER_PARSER_ID,
    'treesitter',
    fileHash,
  );
  const functionLike = symbols.filter((s) =>
    ['function', 'method', 'class'].includes(s.node_type),
  );
  const call_sites = [];
  for (const cs of callSitesRaw) {
    const enclosing = nearestEnclosingSymbol(functionLike, cs.line);
    if (!enclosing || enclosing.node_type === 'class') continue;
    call_sites.push({
      ...cs,
      enclosing_node_id: enclosing.id,
      enclosing_name: enclosing.node_name,
      enclosing_line_start: enclosing.line_start,
    });
  }

  return { symbols, call_sites, import_bindings: importBindings };
}

/**
 * @param {string} content
 * @param {object} file
 * @param {object} context
 * @param {any} env
 */
export async function parseGoTreesitter(content, file, context, env) {
  const fileHash = context.file_hash || (await sha256Hex(content));
  const parsed = await parseWithTreeSitterQuery(
    env,
    'go',
    content,
    GO_QUERY,
    parseOptsFromContext(context),
  );

  /** @type {Array<object>} */
  const raw = [];
  /** @type {Array<object>} */
  const importBindings = [];
  /** @type {Array<object>} */
  const callSitesRaw = [];

  for (const match of parsed.matches) {
    const cap = captureMap(match);
    if (cap.struct && cap.name) {
      raw.push({
        node_type: 'class',
        node_name: cap.name.text,
        exported: isExportedGo(cap.name.text),
        line_start: lineOf(cap.struct),
        line_end: endLineOf(cap.struct),
        signature: String(cap.struct.text || '').split('\n')[0].slice(0, 200),
      });
      continue;
    }
    if (cap.iface && cap.name) {
      raw.push({
        node_type: 'interface',
        node_name: cap.name.text,
        exported: isExportedGo(cap.name.text),
        line_start: lineOf(cap.iface),
        line_end: endLineOf(cap.iface),
        signature: String(cap.iface.text || '').split('\n')[0].slice(0, 200),
      });
      continue;
    }
    if (cap.method && cap.name) {
      raw.push({
        node_type: 'method',
        node_name: cap.name.text,
        exported: isExportedGo(cap.name.text),
        line_start: lineOf(cap.method),
        line_end: endLineOf(cap.method),
        signature: String(cap.method.text || '').split('\n')[0].slice(0, 200),
        parent_name: goReceiverType(cap.method),
      });
      continue;
    }
    if (cap.fn && cap.name) {
      raw.push({
        node_type: 'function',
        node_name: cap.name.text,
        exported: isExportedGo(cap.name.text),
        line_start: lineOf(cap.fn),
        line_end: endLineOf(cap.fn),
        signature: String(cap.fn.text || '').split('\n')[0].slice(0, 200),
      });
      continue;
    }
    if (cap.path) {
      const spec = stripQuotes(cap.path.text);
      let local = spec.split('/').pop() || spec;
      // Sibling package_identifier when present.
      const parent = cap.path.parent;
      if (parent?.type === 'import_spec') {
        for (let i = 0; i < parent.childCount; i += 1) {
          const ch = parent.child(i);
          if (ch?.type === 'package_identifier') local = ch.text;
        }
      }
      raw.push({
        node_type: 'import',
        node_name: spec,
        exported: false,
        line_start: lineOf(cap.path),
        line_end: lineOf(cap.path),
        signature: `import ${spec}`.slice(0, 200),
      });
      importBindings.push({
        local: String(local),
        imported: String(local),
        specifier: spec,
        line: lineOf(cap.path),
        re_export: false,
      });
      continue;
    }
    if (cap.callee) {
      callSitesRaw.push({
        line: lineOf(cap.callee),
        callee_name: cap.callee.text,
        member_path: null,
        dynamic: false,
      });
    }
  }

  const symbols = await materializeStructuralSymbols(
    raw,
    file,
    context,
    'go',
    GO_TREESITTER_PARSER_ID,
    'treesitter',
    fileHash,
  );
  const functionLike = symbols.filter((s) =>
    ['function', 'method', 'class'].includes(s.node_type),
  );
  const call_sites = [];
  for (const cs of callSitesRaw) {
    const enclosing = nearestEnclosingSymbol(functionLike, cs.line);
    if (!enclosing || enclosing.node_type === 'class') continue;
    call_sites.push({
      ...cs,
      enclosing_node_id: enclosing.id,
      enclosing_name: enclosing.node_name,
      enclosing_line_start: enclosing.line_start,
    });
  }

  return { symbols, call_sites, import_bindings: importBindings };
}
