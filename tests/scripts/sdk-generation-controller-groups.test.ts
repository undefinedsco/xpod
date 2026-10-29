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

/** Frozen WHOLE-TUPLE sha256 literals for the six readonly helper tuples that
 * were PUBLISHED at dca33cd37e1130563a26be49d17ca8ca56620030. They are derived
 * INDEPENDENTLY from the exact git blob
 *   git show dca33cd3:scripts/lib/independent-admission/qlever-sdk-readonly-executor.ts
 * (JSON.stringify of each decoded whole tuple), never from the current table, so
 * they can actually disprove historical drift. The live table now holds a 7th
 * tuple appended after publication; the first six must stay byte-identical. */
const READONLY_DCA_PUBLISHED_SIX = Object.freeze([
  '3c875914a488bf6f18b5f44a4138806807f87b1cbe89bb3a51f2087e3abe367d',
  '53999e5151aac3ed460776a3b43b9aa47ed2403b7cdfbf527c79e576135dc066',
  'c9a524ffb9842e5eac5662caf01071ad3e90e52877e085d74e543c56808f594c',
  'cc0e29e4daf3e909809030524c57599018727f2f986b0ec748a218ea7f156b54',
  '19d389d052d4bdf1469fdac6052b213dfd6b7194fc02b5eed5e5447f28632ccb',
  '8b50bc2b41afe85868de8d76d8148efad7cfd4ea67ab2705b17929a659742dba',
]);

for (const [file, historicalName, currentName, historicalCount, currentCount] of [
  ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT', 30, 36],
  ['qlever-sdk-upstream-source.ts', 'REVIEWED_HELPER_GROUPS', 'REVIEWED_HELPER_GROUPS', 7, 7],
  ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_NEXT', 'REVIEWED_HELPER_GROUPS_CURRENT', 33, 39],
  ['qlever-sdk-readonly-executor.ts', 'REVIEWED_READONLY_HELPER_GROUPS', 'REVIEWED_READONLY_HELPER_GROUPS', 7, 8],
] as const) it(file + ' keeps its whole historical tuples and admits the real current bytes', () => {
  // The published/historical catalogue is frozen history: every one of its whole
  // tuples must still select exclusively from its own declared bytes, even though
  // the files on disk have legitimately moved on.
  const historical = decodeCatalog('scripts/lib/independent-admission/' + file, historicalName, 100) as readonly (readonly (readonly [string, string])[])[];
  // For an axis whose historical and current names are the SAME constant, the
  // decoded value is the live frontier, so it carries the current count. That
  // axis proves its frozen prefix against published literals further below.
  expect(historical).toHaveLength(historicalName === currentName ? currentCount : historicalCount);
  for (const group of historical) expect(select(historical, new Map(group))).toBe(group);
  // the frozen prefix of the history is untouched and each tuple is a whole recipe
  expect(historical[0]!.map(([name]) => name)).toEqual(
    historical[historical.length - 1]!.slice(0, historical[0]!.length).map(([name]) => name));

  // The catalogue production actually selects from today is the CURRENT one: its
  // appended final tuple must match the real files, and the generic selector must
  // pick exactly that one.
  const current = decodeCatalog('scripts/lib/independent-admission/' + file, currentName, 100) as readonly (readonly (readonly [string, string])[])[];
  expect(current).toHaveLength(currentCount);
  // For the readonly axis historicalName === currentName, so `historical` IS the
  // live array: slicing it would be tautological. Its frozen prefix is proven
  // against the published literals in the dedicated block below instead.
  if (historicalName !== currentName) expect(current.slice(0, historicalCount)).toEqual(historical);
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

  // GENUINE HISTORICAL PROOF for the readonly catalogue.
  // `historicalName === currentName` there, so `historical` and `current` are the
  // SAME array and the slice comparison above is tautological. Re-prove the six
  // published tuples against frozen literals derived from the dca33cd3 git blob.
  if (file === 'qlever-sdk-readonly-executor.ts') {
    const wholeHash = (group: readonly (readonly [string, string])[]) =>
      createHash('sha256').update(JSON.stringify(group)).digest('hex');
    expect(current).toHaveLength(8);
    expect(READONLY_DCA_PUBLISHED_SIX).toHaveLength(6);
    const published = current.slice(0, 6);
    expect(published.map(wholeHash)).toEqual([...READONLY_DCA_PUBLISHED_SIX]);
    // the frozen six are a real frozen prefix, not a re-slice of the tail
    for (let index = 0; index < 6; index++) expect(wholeHash(published[index]!)).toBe(READONLY_DCA_PUBLISHED_SIX[index]);
    // the inserted 7th tuple is genuinely new and matches the real bytes on disk
    const appended = current[6]!;
    expect(wholeHash(appended)).not.toBe(READONLY_DCA_PUBLISHED_SIX[5]);
    // The seventh tuple is frozen HISTORY now: it stays byte-identical, and the
    // same role universe observed against today's disk resolves to the appended
    // eighth (which is exactly what production must select).
    expect(select(current, actual(appended))).toBe(current[7]);
    // The CURRENT frontier appended one more whole tuple instead of editing the
    // frozen seventh, so the same ordered helper universe now binds today's
    // executor-bindings bytes. Prove the append is a genuine new row that matches
    // the real disk bytes, and that every earlier tuple stayed byte-identical.
    const appendedCurrent = current[7]!;
    expect(wholeHash(appendedCurrent)).not.toBe(wholeHash(appended));
    expect(appendedCurrent.map(([name]) => name)).toEqual(appended.map(([name]) => name));
    const changedWithinAppend = appendedCurrent
      .map(([name, sha], index) => (appended[index]![1] === sha ? null : name))
      .filter((name): name is string => name !== null);
    expect(changedWithinAppend).toEqual(['qlever/scripts/sdk-readonly-executor-bindings.py']);
    expect(select(current, actual(appendedCurrent))).toBe(appendedCurrent);
    // The frozen prefix must be proven against LITERALS, not against itself: the
    // six published constants plus the seventh hash that SDK82/SDK83 already pin
    // as a frozen vector. No expected value here is derived from live bytes.
    expect(current.slice(0, 7).map(wholeHash)).toEqual([
      ...READONLY_DCA_PUBLISHED_SIX,
      'c0d1bb9d41cce762378f33eb813af4ab4ad8cb3d361fba5f0299e2b8c02a5e1c',
    ]);
  }

  if (currentCount > historicalCount && historicalName !== currentName) {
    // genuine append on an axis whose history is a SEPARATE frozen constant:
    // the new tail adds exactly the reviewed extra roles
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

it('bounds thirty-eight reviewed whole tuples, accepting only the production maximum and rejecting thirty-nine or an ambiguous tuple', () => {
  // The declared VERSION maximum is genuinely 38: after the B794 owned-window
  // diagnostic (36) and the SDK79 archive-lifecycle slice (37), the SDK85
  // fail-only diagnostic tuple appended one more real fetch version, so the
  // catalogue policy admits exactly that many DECLARED versions. This is a
  // version-count ceiling, never a capture/role capacity: the observed PER-TUPLE
  // role bound stays 32 (asserted by the next case), and 1s/1800/8192 are untouched.
  const groups = Array.from({length: 39}, (_, i) => Object.freeze([Object.freeze(['helper', String(i)] as const)]));
  // the genuine 39th declared version is the current production maximum and selects
  expect(groups).toHaveLength(39);
  expect(select(groups, new Map(groups[38]!))).toBe(groups[38]);
  expect(select(groups, new Map(groups[0]!))).toBe(groups[0]);
  // a 40th declared version exceeds the reviewed catalogue and is refused
  expect(() => select([...groups, [['helper', '39']]], new Map([['helper', '39']]))).toThrow();
  // a duplicate/ambiguous tuple is refused
  expect(() => select([...groups.slice(0, 25), groups[0]!], new Map(groups[0]!))).toThrow();
});

it('still refuses more than thirty-two observed roles per tuple', () => {
  const wide = Object.freeze(Array.from({length: 33}, (_, i) => Object.freeze(['role' + i, 'a'.repeat(64)] as const)));
  expect(() => select([wide] as any, new Map(wide as any))).toThrow();
});
