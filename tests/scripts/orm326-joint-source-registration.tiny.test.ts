import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import f803 from '../fixtures/independent-admission/f803e9c2-published-slice.original.json';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci,CONTROLLER_POLICY_BINDINGS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_LINUX_EXECUTION_GROUPS as linux} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import {CLI_SOURCE_VERSION_GROUPS as cli} from '../../scripts/lib/independent-admission/source-rules';
import {selectGitHubSourceBindingGroup as select,sourceBindingKey as key} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';

/** Authority is the actual working tree plus the frozen f803 published fixture.
 * No serialized approval boolean is consulted anywhere in this file. */
const ROOT = path.resolve(import.meta.dir, '../..');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const groups = {sdk, consumer, ci, linux, api, cli} as const;
const PATCH_25 = 'patches/@undefineds.co%2Fdrizzle-solid@0.3.25.patch';
const PATCH_26 = 'patches/@undefineds.co%2Fdrizzle-solid@0.3.26.patch';
const SNAPSHOT = 'scripts/lib/independent-admission/consumer-execution-f803e9c2-snapshot.json';

test('every published f803 prefix stays byte-identical; only the ORM 0.3.26 tail appends', () => {
  // The baseline is the REAL published f803 catalogue, captured before this append.
  expect(f803.base).toBe('f803e9c2dc53fe145d6f5124fbd0356f2a484e93');
  expect(f803.published).toEqual({sdk:74, consumer:89, ci:176, linux:75, api:28, cli:11});
  for (const name of Object.keys(groups) as (keyof typeof groups)[]) {
    const frozen = (f803.groupHashes as Record<string, string[]>)[name]!;
    const live = groups[name] as readonly unknown[];
    expect(frozen.length).toBe(f803.published[name]);
    expect(live.slice(0, frozen.length).map(digest)).toEqual(frozen);
    // sdk +1 and linux +1 are the ORM 0.3.26 joint SDK tuple (the f803 prefix
    // above stays byte-identical); api +1, cli +1, consumer +1, CI +2 append.
    // SDK81 + the SDK82 failed-transport consumer/CI tails are appended after this slice.
    expect(live.length - frozen.length).toBe({sdk: 13, consumer: 10, ci: 20, linux: 13, api: 1, cli: 1}[name] ?? 0);
  }
  expect([sdk.length, linux.length, consumer.length, ci.length, api.length, cli.length]).toEqual([87, 88, 99, 196, 29, 12]);
});

test('the frozen f803 snapshot is the published canonical bytes and the moving canonical only appends', () => {
  const snapshot = fs.readFileSync(path.join(ROOT, SNAPSHOT));
  expect(createHash('sha256').update(snapshot).digest('hex')).toBe(f803.canonicalHash);
  expect(f803.canonicalHash).toBe('e6f52d0933f25e4f024f93614c0d99aef5c412de73dfa0be45033760b0e61954');
  const frozenRows: {path: string; sha256: string}[] = JSON.parse(snapshot.toString('utf8'));
  expect(frozenRows.length).toBe(487);
  // The moving canonical retains every f803 row at its published position.
  expect(current.slice(0, frozenRows.length).map(row => row.path)).toEqual(frozenRows.map(row => row.path));
  expect(current.length).toBe(CURRENT_CANONICAL_SOURCE_ROWS);
  // Two genuine appends follow the frozen f803 rows: the ORM 0.3.26 patch +
  // f803 snapshot pair, then the SDK19 telemetry canonical snapshot.
  expect(current.slice(frozenRows.length).map(row => row.path)).toEqual([PATCH_26, SNAPSHOT,
    'scripts/lib/independent-admission/consumer-execution-19fe-snapshot.json',
    'qlever/tests/test_sdk70_mremap_predicate.py',
    'qlever/tests/test_sdk70_mremap_observer.py',
    'qlever/tests/test_sdk70_mremap_native.py',
    'qlever/tests/test_sdk70_mremap_e2e.py',
    'qlever/tests/run_sdk70_mremap_gate.py',
    'tests/scripts/sdk70-remap-policy.test.ts',
    'scripts/lib/independent-admission/consumer-execution-0d-snapshot.json',
    'scripts/lib/independent-admission/consumer-execution-6b-snapshot.json',
    'qlever/tests/test_sdk70_mremap_barrier_e2e.py',
    'scripts/lib/independent-admission/consumer-execution-71f9-snapshot.json',
    'qlever/tests/test_qlever_read_lease_diagnostic.py',
    'scripts/lib/independent-admission/consumer-execution-cbb-snapshot.json',
    'qlever/tests/test_qlever_archive_lifecycle.py',
    'scripts/lib/independent-admission/consumer-execution-dca-snapshot.json',
    'qlever/scripts/sdk-generated-producer-transport.py']);
  expect(new Set(current.map(row => row.path)).size).toBe(current.length);
});

test('the current canonical binds actual disk bytes and re-hashes only rows that genuinely moved', () => {
  for (const row of [...current, ...CONTROLLER_POLICY_BINDINGS]) expect(sha(row.path)).toBe(row.sha256);
  const frozenRows: {path: string; sha256: string}[] = JSON.parse(fs.readFileSync(path.join(ROOT, SNAPSHOT), 'utf8'));
  const moved = frozenRows.filter(row => row.sha256 !== current.find(next => next.path === row.path)!.sha256).map(row => row.path);
  // Every moved row is a genuinely registered source row whose ACTUAL disk bytes
  // differ from the frozen f803 value; no row may move without a real byte change.
  for (const movedPath of moved) expect(sha(movedPath)).toBe(current.find(row => row.path === movedPath)!.sha256);
  // The ORM 0.3.26 facts themselves must be re-bound in the current canonical.
  for (const required of ['bun.lock', 'package.json',
    'scripts/lib/independent-admission/afs-verifier-patch-originals.ts',
    'scripts/lib/independent-admission/legal-registry-originals.ts']) expect(moved).toContain(required);
  // Rows owned by other workers that legitimately changed registered bytes are
  // re-bound too, never dropped; nothing outside the frozen row set is invented.
  const frozenPaths = new Set(frozenRows.map(row => row.path));
  for (const movedPath of moved) expect(frozenPaths.has(movedPath)).toBe(true);
  expect(current.length).toBe(CURRENT_CANONICAL_SOURCE_ROWS);
  // Historical facts are never dropped or relabelled.
  const patch25 = current.find(row => row.path === PATCH_25)!;
  expect(patch25.sha256).toBe('15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789');
  expect(current.some(row => row.path === PATCH_25.replace('0.3.25', '0.3.26'))).toBe(true);
});

test('manifest/lock/installed facts bind the published ORM 0.3.26 release exactly once', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declarations = Object.keys(manifest.patchedDependencies ?? {}).filter(name => name.startsWith('@undefineds.co/drizzle-solid@'));
  expect(declarations).toEqual(['@undefineds.co/drizzle-solid@0.3.26']);
  expect(manifest.patchedDependencies[declarations[0]!]).toBe(PATCH_26);
  expect((manifest.resolutions ?? {})['@undefineds.co/drizzle-solid']).toBe('0.3.26');
  const lock = fs.readFileSync(path.join(ROOT, 'bun.lock'), 'utf8');
  expect(lock).toContain('"@undefineds.co/drizzle-solid@0.3.26": "' + PATCH_26 + '"');
  expect(lock).not.toContain('"@undefineds.co/drizzle-solid@0.3.25"');
  expect(lock).toContain('sha512-x51lhiVpNmLcky4G66pF32WdR9vRfSse9ZufKe3CmD+5/Fi4L7f6x75E8V4SokR9AHUNTYCbccldeTtxHRSkqw==');
  const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@undefineds.co/drizzle-solid/package.json'), 'utf8'));
  expect(installed.version).toBe('0.3.26');
  // The 26 patch is byte-identical to the historical 25 patch, but is its own fact.
  expect(sha(PATCH_26)).toBe(sha(PATCH_25));
  expect(sha(PATCH_26)).toBe('15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789');
});

test('the appended consumer/CI tails bind every ORM 0.3.26 fact and keep the 0.3.25 history', () => {
  const f803Api = (f803.groupHashes as Record<string, string[]>).api!;
  // Index 27 is the PUBLISHED f803 tuple; index 28 is the new ORM 0.3.26 tail.
  const published = api[27]!;
  expect(api.length).toBe(29);
  expect(digest(published)).toBe(f803Api[f803Api.length - 1]!);
  expect(api[28]!.selectors.some(row => row.path === PATCH_26)).toBe(true);
  expect(published.selectors.some(row => row.path === PATCH_26)).toBe(false);
  // No 29th group: the controlled-recipe 10-role predicate cannot separate groups
  // that differ only in manifest/lock, so an appended group would be ambiguous.
  for (const list of [consumer, ci]) {
    const tail = list[list.length - 1]!;
    const rows = [...tail.selectors, ...(tail.secondarySelectors ?? []), ...tail.sourceBindings];
    for (const required of [PATCH_25, PATCH_26, 'package.json', 'bun.lock',
      'scripts/lib/independent-admission/legal-registry-originals.ts',
      'scripts/lib/independent-admission/afs-verifier-patch-originals.ts']) {
      const row = rows.find(candidate => candidate.path === required);
      if (!row) throw new Error(required + ' must be bound by the appended tail');
      expect(sha(required)).toBe(row.sha256);
    }
    // The 0.3.25 row is a retained historical fact, not a relabel of 0.3.26.
    // The 26 patch appears exactly once per role: primary (disambiguation) and
    // source binding (the complete byte universe), never twice in one role.
    expect(tail.selectors.filter(candidate => candidate.path === PATCH_26).length).toBe(1);
    expect(tail.sourceBindings.filter(candidate => candidate.path === PATCH_26).length).toBe(1);
    expect((tail.secondarySelectors ?? []).filter(candidate => candidate.path === PATCH_26).length).toBe(0);
    expect(rows.find(candidate => candidate.path === PATCH_25)!.sha256).toBe(sha(PATCH_26));
  }
});

test('old and new tails are strictly disambiguated by actual bytes, never loosened', () => {
  // Selection must be unique: exactly one group owns the complete observed tuple.
  for (const [name, list] of [['consumer', consumer], ['ci', ci]] as const) {
    for (const group of list) {
      const observed = new Map([...group.selectors, ...(group.secondarySelectors ?? []), ...group.sourceBindings].map(row => [key(row), row.sha256] as const));
      expect(select(list, observed)).toBe(group);
      expect(name === 'consumer' ? consumer.includes(select(list, observed)) : ci.includes(select(list, observed))).toBe(true);
    }
  }
  const tail = consumer[consumer.length - 1]!;
  const patchRow = tail.selectors.find(row => row.path === PATCH_26)!;
  expect(patchRow.sha256).toBe(sha(PATCH_26));
  const observed = () => new Map([...tail.selectors, ...(tail.secondarySelectors ?? []), ...tail.sourceBindings].map(row => [key(row), row.sha256] as const));
  // Removing the 26 patch from the observed set must NOT fall back to the f803 tail.
  const without = observed();
  without.delete(key(patchRow));
  expect(() => select(consumer, without)).toThrow();
  // Retaining the 26 patch but drifting the 26 bytes must not match either.
  const drifted = observed();
  drifted.set(key(patchRow), '0'.repeat(64));
  expect(() => select(consumer, drifted)).toThrow();
  // An extra observed fact cannot steal or block selection: only declared
  // selectors participate, so the tuple still resolves to this exact group.
  const unknown = observed();
  unknown.set('source:tests/fixtures/independent-admission/f803e9c2-published-slice.original.json', '0'.repeat(64));
  expect(select(consumer, unknown)).toBe(tail);
  // The previous PUBLISHED consumer tail (index 97, the SDK82 failed-transport
  // slice) still selects itself, untouched. f803 is only the consumer-89 prefix
  // proved above, so it is not claimed as this previous tail. Index 98 is the
  // separately registered SDK83 fixture-isolation tail.
  const publishedTail = consumer[consumer.length - 2]!;
  expect(consumer.indexOf(publishedTail)).toBe(97);
  expect(select(consumer, new Map([...publishedTail.selectors, ...(publishedTail.secondarySelectors ?? []), ...publishedTail.sourceBindings].map(row => [key(row), row.sha256] as const)))).toBe(publishedTail);
});
