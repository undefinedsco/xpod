import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeCatalog} from './sdk-helper-catalog.fixture';
import {selectSdkControllerHelperGroup as select} from '../../scripts/lib/independent-admission/sdk-controller-helper-groups';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HASH = (name: string) =>
  createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, name.startsWith('qlever/') || name.startsWith('scripts/') ? name : 'qlever/scripts/' + name)))
    .digest('hex');
/** the real bytes on disk for a whole tuple */
const actual = (group: readonly (readonly [string, string])[]) => new Map(group.map(([name]) => [name, HASH(name)]));

for (const [file, historicalName, currentName, historicalCount, currentCount] of [
  ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT', 30, 33],
  ['qlever-sdk-upstream-source.ts', 'REVIEWED_HELPER_GROUPS', 'REVIEWED_HELPER_GROUPS', 7, 7],
  ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_NEXT', 'REVIEWED_HELPER_GROUPS_CURRENT', 33, 36],
  ['qlever-sdk-readonly-executor.ts', 'REVIEWED_READONLY_HELPER_GROUPS', 'REVIEWED_READONLY_HELPER_GROUPS', 6, 6],
] as const) it(file + ' keeps its whole historical tuples and admits the real current bytes', () => {
  // The published/historical catalogue is frozen history: every one of its whole
  // tuples must still select exclusively from its own declared bytes, even though
  // the files on disk have legitimately moved on.
  const historical = decodeCatalog('scripts/lib/independent-admission/' + file, historicalName, 100) as readonly (readonly (readonly [string, string])[])[];
  expect(historical).toHaveLength(historicalCount);
  for (const group of historical) expect(select(historical, new Map(group))).toBe(group);
  // the frozen prefix of the history is untouched and each tuple is a whole recipe
  expect(historical[0]!.map(([name]) => name)).toEqual(
    historical[historical.length - 1]!.slice(0, historical[0]!.length).map(([name]) => name));

  // The catalogue production actually selects from today is the CURRENT one: its
  // appended final tuple must match the real files, and the generic selector must
  // pick exactly that one.
  const current = decodeCatalog('scripts/lib/independent-admission/' + file, currentName, 100) as readonly (readonly (readonly [string, string])[])[];
  expect(current).toHaveLength(currentCount);
  expect(current.slice(0, historicalCount)).toEqual(historical);
  const latest = current[current.length - 1]!;
  expect(select(current, actual(latest))).toBe(latest);
  for (const group of current) expect(select(current, new Map(group))).toBe(group);

  // refusals stay load-bearing on the CURRENT catalogue
  for (const group of current) {
    for (const [name] of group) {
      const missing = new Map(group);
      missing.delete(name);
      expect(() => select(current, missing)).toThrow();
      const unknown = new Map(group);
      unknown.set(name, 'f'.repeat(64));
      expect(() => select(current, unknown)).toThrow();
    }
  }

  if (currentCount > historicalCount) {
    // genuine append: the new tail adds exactly the reviewed extra roles
    expect(latest.slice(historical[0]!.length).map(([name]) => name)).toEqual(
      ['sdk-generated-vma-originals.py', 'sdk-coordinated-wait.py', 'sdk-original-chunk-store.py', 'sdk-raw-wire-reader.py', 'sdk-executable-memory-policy.py']);
  } else {
    expect(latest).toHaveLength(historical[0]!.length);
  }

  // every mixture must itself be one reviewed whole tuple, otherwise it is refused
  for (const group of current) {
    for (const [name, sha] of group) {
      const mixed = new Map(latest);
      mixed.set(name, sha);
      const matches = current.filter(row => row.length === mixed.size && row.every(([key, value]) => mixed.get(key) === value));
      if (matches.length === 1) expect(select(current, mixed)).toBe(matches[0]);
      else expect(() => select(current, mixed)).toThrow();
    }
  }
});

it('bounds thirty-six reviewed whole tuples, accepting only the production maximum and rejecting thirty-seven or an ambiguous tuple', () => {
  // The declared VERSION maximum is genuinely 36: the B794 owned-window
  // diagnostic gave fetch CURRENT a real 36th tuple, so the catalogue policy
  // admits exactly that many DECLARED versions. This is a version-count ceiling,
  // never a capture/role capacity: the observed PER-TUPLE role bound stays 32
  // (asserted by the next case), and 1s/1800/8192 are untouched.
  // Expected numbers come from the published ce9 baselines (controller 32,
  // fetch 35) plus this one genuine append - NOT from reading the implementation.
  const groups = Array.from({length: 36}, (_, i) => Object.freeze([Object.freeze(['helper', String(i)] as const)]));
  // the genuine 36th version is the current production maximum and selects
  expect(groups).toHaveLength(36);
  expect(select(groups, new Map(groups[35]!))).toBe(groups[35]);
  expect(select(groups, new Map(groups[0]!))).toBe(groups[0]);
  // a 37th declared version exceeds the reviewed catalogue and is refused
  expect(() => select([...groups, [['helper', '36']]], new Map([['helper', '36']]))).toThrow();
  // a duplicate/ambiguous tuple is refused
  expect(() => select([...groups.slice(0, 25), groups[0]!], new Map(groups[0]!))).toThrow();
});

it('still refuses more than thirty-two observed roles per tuple', () => {
  const wide = Object.freeze(Array.from({length: 33}, (_, i) => Object.freeze(['role' + i, 'a'.repeat(64)] as const)));
  expect(() => select([wide] as any, new Map(wide as any))).toThrow();
});
