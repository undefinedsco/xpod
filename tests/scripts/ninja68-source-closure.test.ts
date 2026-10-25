/** SDK68 load-bearing import closure, exercised ONLY through the generic production
 * selector used by the SDK issuer. No bespoke validator, no parallel API:
 * if any new helper is missing or changed, SDK68 must not select. */
import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {
  QLEVER_SDK_EXECUTION_GROUPS, QLEVER_SDK_NINJA_SOURCE_BINDINGS,
} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {
  selectGitHubSourceBindingGroup, sourceBindingKey,
} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const ROOT = path.resolve(import.meta.dir, '../..');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NEW_ROLES = [
  'qlever/scripts/cmake_file_api.py',
  'qlever/scripts/link_command_adapter.py',
  'qlever/scripts/link_command_origin.py',
] as const;
const current = () => QLEVER_SDK_EXECUTION_GROUPS.at(-1)!;
/** observed map built from ACTUAL bytes on disk for every member of the slice */
const observedFromDisk = () => {
  const g = current();
  const rows = [...g.selectors, ...(g.secondarySelectors ?? []), ...g.sourceBindings];
  return new Map(rows.map(r => [sourceBindingKey(r), sha(readFileSync(path.join(ROOT, r.path)))]));
};

/** The immutable e4 declaration pins HISTORICAL bytes. It must keep the exact
 * values it was published with even though the files have since changed; the
 * CURRENT slice is what must match the real bytes today. */
const HISTORICAL_NINJA_SHA: Readonly<Record<string, string>> = Object.freeze({
  'qlever/scripts/cmake_file_api.py': 'cee5f61c2f2fa072827bd67901d6a129b07f98876469f25c5ca8bacb441b9412',
  'qlever/scripts/link_command_adapter.py': '6da48b0625ed18c725081a2bc36e87176474deda3a1f6368a6163c7b0d029bcf',
  'qlever/scripts/link_command_origin.py': '0696060070de7d585e15a92eebf4d796a89ca31a0efa8b86225d2ff068d69c0c',
});

test('the immutable e4 declaration keeps its published historical pins', () => {
  expect(QLEVER_SDK_NINJA_SOURCE_BINDINGS.map(r => r.path)).toEqual([...NEW_ROLES].sort());
  for (const row of QLEVER_SDK_NINJA_SOURCE_BINDINGS) {
    expect(row.sha256).toBe(HISTORICAL_NINJA_SHA[row.path]);
  }
});

test('the CURRENT slice binds the same three paths to the real bytes today', () => {
  const g = current();
  const rows = [...g.selectors, ...(g.secondarySelectors ?? []), ...g.sourceBindings];
  for (const row of QLEVER_SDK_NINJA_SOURCE_BINDINGS) {
    const live = rows.find(r => r.path === row.path);
    expect(live).toBeDefined();
    expect(live!.sha256).toBe(sha(readFileSync(path.join(ROOT, row.path))));
    expect(live!.sha256).not.toBe(row.sha256);
  }
});

test('the new helpers are declared in BOTH secondarySelectors and sourceBindings', () => {
  const g = current();
  for (const role of NEW_ROLES) {
    expect((g.secondarySelectors ?? []).some(r => r.path === role)).toBe(true);
    expect(g.sourceBindings.some(r => r.path === role)).toBe(true);
  }
});

test('the generic selector selects SDK68 from real current bytes', () => {
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS, observedFromDisk())).toBe(current());
});

test('a mutated new-helper digest makes SDK68 unselectable (generic selector)', () => {
  for (const role of NEW_ROLES) {
    const observed = observedFromDisk();
    for (const r of [...(current().secondarySelectors ?? []), ...current().sourceBindings]) {
      if (r.path === role) observed.set(sourceBindingKey(r), 'f'.repeat(64));
    }
    expect(() => selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS, observed))
      .toThrow(/exact workflow\/source group not reviewed/u);
  }
});

test('a suppressed new-helper role makes SDK68 unselectable (generic selector)', () => {
  for (const role of NEW_ROLES) {
    const observed = observedFromDisk();
    for (const r of [...(current().secondarySelectors ?? []), ...current().sourceBindings]) {
      if (r.path === role) observed.delete(sourceBindingKey(r));
    }
    expect(() => selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS, observed))
      .toThrow(/exact workflow\/source group not reviewed/u);
  }
});
