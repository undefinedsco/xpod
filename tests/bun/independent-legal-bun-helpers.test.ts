import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bunHelperOriginalView, deriveBunHelperStatementBindings, mapBunHelperPrefix } from '../../scripts/lib/independent-admission/legal-bun-helpers';
const objects = new URL('../../packages/xpod-client/licenses/javascript/generated/1.4.2/objects/', import.meta.url);
const read = (digest: string) => readFileSync(new URL(digest + '.txt', objects));
const bindings = deriveBunHelperStatementBindings(read('02644972b775ee7bc4ed4b088808a3ea34ac6922ec52f897b7ea76b9f0ed92c4'), read('37b70e3bc5f3a5f10d5ccb6e3efb13dab7010225605fb505908b634f5f47c00d'));
test('actual Bun 1.4.2 ESM, CJS and AFS prefix statements map completely to fixed runtime source', () => {
  for (const digest of ['a3e72d01f26bcd39142331f3a6d2033a495188dc06ab7b477f728f88afcff0a7', 'b7da41c9687f29df76843d1ec3b196850f0bd4881b29cdc42d23b621dcf6e102', '3e894e682e09c0212315cf6e24be4b47f7157330888eb9de90c13823ff9d2dd6']) {
    const result = mapBunHelperPrefix(read(digest), bindings);
    expect(result.pending).toEqual([]); expect(result.mapped.length > 0).toBe(true);
  }
});
test('changed helper, unknown injected code, unscoped comments and duplicate statements remain uncovered', () => {
  const prefix = read('a3e72d01f26bcd39142331f3a6d2033a495188dc06ab7b477f728f88afcff0a7');
  expect(mapBunHelperPrefix(Buffer.from(prefix.toString().replace('Object.create', 'evil.create')), bindings).pending).toContain('Unmapped actual Bun helper statement: __create');
  expect(mapBunHelperPrefix(Buffer.concat([prefix, Buffer.from('\nrunUntrustedCode();')]), bindings).pending.length > 0).toBe(true);
  expect(mapBunHelperPrefix(Buffer.from('// Additional licensing restriction\n' + prefix), bindings).pending).toContain('Unmapped helper prefix trivia');
  expect(mapBunHelperPrefix(Buffer.concat([prefix, Buffer.from('\nvar __create = Object.create;')]), bindings).pending).toContain('Unmapped actual Bun helper statement: __create');
});
test('pure source/printer bindings are never an official upstream original capability', () => {
  expect(bunHelperOriginalView(bindings)).toBeUndefined(); expect(bunHelperOriginalView({ status: 'verified', bindings })).toBeUndefined();
  expect(mapBunHelperPrefix(Buffer.alloc(0), bindings)).toEqual({ mapped: [], pending: [] });
});
