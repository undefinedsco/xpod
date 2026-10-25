/**
 * Immutable ab94021 published-slice regression.
 *
 * Contract this test encodes (same machinery as the f6/FB058/e4ea/fae slices):
 *  1. the ab94021 published whole histories are preserved BYTE-FOR-BYTE at every
 *     published index, including the last one — prefix subset is NOT enough;
 *  2. the frozen ab canonical snapshot keeps its exact published bytes and row
 *     count, so rewriting the live canonical can never rewrite ab history;
 *  3. the live canonical binds every row's ACTUAL bytes on disk;
 *  4. every old canonical member path is still present after the append;
 *  5. each family still selects itself uniquely and refuses missing/mixed/
 *     ambiguous/unregistered roles — no provenance gate is weakened.
 *
 * The fixture is an immutable historical vector. It is never regenerated to
 * satisfy a later change, and its own hashes are never edited.
 */
import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import abGroups from '../fixtures/independent-admission/ab94021-published-slice.original.json';
import {
  CONSUMER_SOURCE_GROUPS as consumer,
  CI_CONSUMER_SOURCE_GROUPS as ci,
} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk, QLEVER_LINUX_EXECUTION_GROUPS as linux} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {
  selectGitHubSourceBindingGroup as select,
  secondaryGitHubSourceBindingSelectors as secondary,
  sourceBindingKey as key,
} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const ROOT = path.resolve(import.meta.dir, '../..');
const LIB = 'scripts/lib/independent-admission';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hashValue = (v: unknown) => sha(JSON.stringify(v));
const families = {sdk, consumer, ci, api, linux} as const;

test('immutable ab94021 baseline proves every published prefix byte-for-byte', () => {
  expect((abGroups as any).base).toBe('ab94021fc5596073bf57b19f051f61d7ce48cfaa');
  expect([abGroups.published.sdk, abGroups.published.consumer, abGroups.published.ci,
    abGroups.published.api, abGroups.published.linux]).toEqual([70, 85, 168, 28, 71]);
  for (const [name, groups] of Object.entries(families)) {
    const published = (abGroups.groupHashes as any)[name] as unknown[];
    expect(published.length).toBe((abGroups.published as any)[name]);
    // EVERY published index, including the last, must be byte-identical.
    for (let i = 0; i < published.length; i++) expect(hashValue(groups[i])).toBe(published[i]);
    // Appends may only extend; they may never shorten or rewrite history.
    expect(groups.length).toBeGreaterThanOrEqual(published.length);
  }
});

test('the frozen ab canonical snapshot keeps its published rows and bytes', () => {
  const snapshotPath = `${LIB}/consumer-execution-ab94021-snapshot.json`;
  const bytes = fs.readFileSync(path.join(ROOT, snapshotPath));
  expect((abGroups as any).canonical.path).toBe('scripts/lib/independent-admission/consumer-execution-current.json');
  expect((abGroups as any).canonical.rows).toBe(478);
  expect((abGroups as any).canonical.sha256).toBe(sha(bytes));
  const snapshot = JSON.parse(bytes.toString('utf8'));
  expect(snapshot.length).toBe(478);
});

test('the live canonical binds every actual row byte and retains every old member', () => {
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(ROOT, LIB, 'consumer-execution-ab94021-snapshot.json'), 'utf8')) as {path: string; sha256: string}[];
  const byPath = new Map((current as {path: string; sha256: string}[]).map(row => [row.path, row.sha256]));
  // No published member path may disappear.
  for (const row of snapshot) expect(byPath.has(row.path)).toBe(true);
  // Every current row must match the real bytes on disk (never a stale claim).
  for (const row of current as {path: string; sha256: string}[]) {
    expect(sha(fs.readFileSync(path.join(ROOT, row.path)))).toBe(row.sha256);
  }
  // The append only adds members; it never drops below the published count.
  expect((current as unknown[]).length).toBeGreaterThanOrEqual(snapshot.length);
});

test('every published and appended family group selects uniquely and refuses bad roles', () => {
  for (const [name, groups] of Object.entries(families)) {
    for (const [index, group] of (groups as readonly any[]).entries()) {
      const observed = new Map<string, string>();
      for (const row of group.selectors) observed.set(key(row), row.sha256);
      const required = secondary(groups as readonly any[], observed);
      for (const role of required) {
        const own = [...group.selectors, ...(group.secondarySelectors ?? []), ...group.sourceBindings]
          .find((row: any) => key(row) === key(role));
        expect(own).toBeDefined();
        observed.set(key(role), own!.sha256);
      }
      // Positive: the complete tuple resolves to exactly this group.
      expect(select(groups as readonly any[], observed)).toBe(group);
      // Negative: a missing required role must be refused.
      for (const role of required) {
        const missing = new Map(observed);
        missing.delete(key(role));
        expect(() => select(groups as readonly any[], missing)).toThrow();
      }
      // Negative: a mixed (unknown) hash must be refused, never adopted.
      for (const role of required) {
        const mixed = new Map(observed);
        mixed.set(key(role), 'f'.repeat(64));
        expect(() => select(groups as readonly any[], mixed)).toThrow();
      }
      void index; void name;
    }
  }
});

test('an unregistered tuple cannot borrow a published group', () => {
  // A tuple whose only change is an unknown hash for one selector must not match.
  for (const groups of Object.values(families)) {
    const group = (groups as readonly any[])[0]!;
    const tuple = new Map<string, string>();
    for (const row of group.selectors) tuple.set(key(row), row.sha256);
    const victim = group.selectors[0]!;
    tuple.set(key(victim), 'a'.repeat(64));
    expect(() => select(groups as readonly any[], tuple)).toThrow();
  }
});
