import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { materializeStructuralSymbols } from '../worker/src/codebase-structural-parse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('materialized symbols use account + repository + generation identity', async () => {
  const context = {
    account_id: 'au_test',
    repository_id: 'github:org/repo',
    repo_full_name: 'org/repo',
    revision_sha: '0123456789abcdef0123456789abcdef01234567',
    run_id: 'cidxrun_test',
    index_generation_id: 'cidxgen_test',
  };
  const [symbol] = await materializeStructuralSymbols(
    [{ node_type: 'function', node_name: 'hello', line_start: 1, line_end: 2 }],
    { path: 'src/a.js', git_blob_sha: 'blob_test' },
    context,
    'js',
    'js-treesitter-v1',
    'treesitter',
    'file_hash_test',
  );

  assert.equal(symbol.account_id, context.account_id);
  assert.equal(symbol.repository_id, context.repository_id);
  assert.equal(symbol.repo_full_name, context.repo_full_name);
  assert.equal(symbol.index_generation_id, context.index_generation_id);
  assert.equal('workspace_id' in symbol, false);
});

test('/parse contract contains no workspace ownership requirement', async () => {
  const source = await readFile(join(ROOT, 'worker/src/index.js'), 'utf8');
  assert.match(source, /!context\.account_id/);
  assert.match(source, /!context\.repository_id/);
  assert.doesNotMatch(source, /context\.workspace_id/);
});
