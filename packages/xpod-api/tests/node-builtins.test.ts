import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { nodeBuiltinAuthority, verifyNodeBuiltinAuthority } from '../scripts/node-builtins';

test('portable builtin authority uses actual supported Node and binds the exact request and binary', () => {
  const specifiers = ['ws', 'node:ws', 'undici', 'node:undici', 'node:fs', 'bun:sqlite'];
  const receipt = nodeBuiltinAuthority(specifiers, '>=22 <27');
  const values = new Map(receipt.results.map(row => [row.specifier, row.builtin]));
  assert.equal(values.get('node:fs'), true);
  for (const name of ['ws', 'node:ws', 'undici', 'node:undici', 'bun:sqlite']) assert.equal(values.get(name), false);
  assert.throws(() => verifyNodeBuiltinAuthority(receipt, [...specifiers, 'unknown-package'], '>=22 <27'), /authority/);
  assert.throws(() => verifyNodeBuiltinAuthority({ ...receipt, binarySHA256: '0'.repeat(64) }, specifiers, '>=22 <27'), /authority/);
  assert.throws(() => verifyNodeBuiltinAuthority(receipt, specifiers, '<1'), /authority/);
  const changed = structuredClone(receipt); changed.results[0].builtin = 'yes' as unknown as boolean;
  assert.throws(() => verifyNodeBuiltinAuthority(changed, specifiers, '>=22 <27'), /authority/);
});
