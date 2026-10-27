/** SDK87 absent link/unlink operand slice (APPEND-ONLY, UNPUBLISHED).
 *
 * SDK87 inherits SDK86 whole, adds no stage, and re-pins ONLY the roles whose
 * bytes actually moved: the observer body (4 inherited occurrences) and SDK81's
 * mandatory regression leaf (1 sourceBinding). The binder is NOT changed by this
 * slice and keeps SDK86's exact value. SDK86 itself is historical and immutable.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {it, expect} from 'vitest';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK, QLEVER_LINUX_EXECUTION_GROUPS as LINUX} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup, sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved} from './source-binding-group.fixture';
import historicalWhole from '../fixtures/independent-admission/sdk86-historical-whole-hashes.json';

const ROOT = path.resolve(import.meta.dirname, '../..');
const whole = (g: unknown) => createHash('sha256').update(JSON.stringify(g)).digest('hex');
const sha = (p: string) => createHash('sha256').update(readFileSync(path.join(ROOT, p))).digest('hex');
const BINDER = 'qlever/scripts/sdk-generation-multiprocess-bindings.py';
const OBSERVER = 'qlever/scripts/sdk-ptrace-execution.py';
const LEAF = 'tests/scripts/candidate-producer-attempt-binding.test.ts';
const all = (g: any) => [...g.selectors, ...(g.secondarySelectors ?? []), ...(g.secondarySelectorStages ?? []).flat(), ...g.sourceBindings];

/** SDK86's published bytes — HISTORICAL, never replaced with today's tree. */
const SDK86_FROZEN: Readonly<Record<string, string>> = Object.freeze({
  [BINDER]: 'c59c84466007a7641fa69147bfb5f3301a259085f064ceea0962b04d84f23233',
  [OBSERVER]: '1bb9533e6a499b35347c2bc5d66644360cf6eff733251c9fac15d2f704e0662d',
  [LEAF]: '6018218f537a88607be392cb081a53cbdc64cf0fd3f21a00df6f7f9eaf178b76',
});

it('SDK87 whole-inherits SDK86 and re-pins only the observer and the leaf', () => {
  const inherited = SDK[85]!, next = SDK[86]!;
  expect(JSON.stringify(next.selectors)).toBe(JSON.stringify(inherited.selectors));
  expect(JSON.stringify(next.candidateServiceRelationship)).toBe(JSON.stringify(inherited.candidateServiceRelationship));
  expect(JSON.stringify(next.outerExecutor)).toBe(JSON.stringify(inherited.outerExecutor));
  // this slice adds no stage and keeps the whole stage surface
  expect((next.secondarySelectorStages ?? []).length).toBe((inherited.secondarySelectorStages ?? []).length);
  expect(JSON.stringify(next.secondarySelectorStages)).toBe(JSON.stringify(inherited.secondarySelectorStages));
  expect(next.sourceBindings.length).toBe(inherited.sourceBindings.length);
  const before = all(inherited), after = all(next);
  expect(after.length).toBe(before.length);
  const moved: string[] = [];
  for (let i = 0; i < before.length; i++) {
    expect(after[i].path, `role[${i}].path`).toBe(before[i].path);
    if (before[i].sha256 !== after[i].sha256) moved.push(after[i].path);
  }
  // ONLY the observer (4 inherited occurrences) and the leaf (1) move.
  expect(new Set(moved)).toEqual(new Set([OBSERVER, LEAF]));
  expect(moved.filter(p => p === OBSERVER)).toHaveLength(4);
  expect(moved.filter(p => p === LEAF)).toHaveLength(1);
  // the binder is untouched by this slice
  expect(moved).not.toContain(BINDER);
  // current-tree roles bind today's real bytes (OBSERVER/LEAF) ...
  for (const row of all(next).filter((r: any) => r.path === OBSERVER)) expect(row.sha256).toBe(sha(OBSERVER));
  expect(next.sourceBindings.find(r => r.path === LEAF)!.sha256).toBe(sha(LEAF));
  // ... while the binder still carries SDK86's frozen bytes, equal to disk today
  for (const row of all(next).filter((r: any) => r.path === BINDER)) expect(row.sha256).toBe(SDK86_FROZEN[BINDER]!);
  expect(SDK86_FROZEN[BINDER]).toBe(sha(BINDER));
});

it('historical SDK86 keeps its own frozen bytes and is not rewritten', () => {
  const sdk86 = SDK[85]!;
  // SDK86's published whole value is unchanged by this slice.
  expect(whole(sdk86)).toBe('af71219e3880a846ddee306382cb014b14122db91fcbb6cffc418c80e1d8d2a7');
  for (const role of [BINDER, OBSERVER, LEAF]) {
    const rows = all(sdk86).filter((r: any) => r.path === role);
    expect(new Set(rows.map((r: any) => r.sha256))).toEqual(new Set([SDK86_FROZEN[role]!]));
  }
  // SDK86's observer/leaf are stale against today's tree BY DESIGN.
  expect(SDK86_FROZEN[OBSERVER]).not.toBe(sha(OBSERVER));
  expect(SDK86_FROZEN[LEAF]).not.toBe(sha(LEAF));
});

it('the 85-group frozen prefix is untouched and SDK81 keeps its frozen leaf', () => {
  expect(historicalWhole).toHaveLength(85);
  for (let i = 0; i < historicalWhole.length; i++) {
    expect(whole(SDK[i]), `SDK[${i}]`).toBe(historicalWhole[i]);
  }
  const sdk81 = all(SDK[80]).find((r: any) => r.path === LEAF);
  expect(sdk81!.sha256).toBe('f1a165e7a2f2ad3a6f8f5443c0eb6c255cb84c6caf08eaf0bdb23bc916f895e9');
});

it('generic selector resolves SDK86/current/stale against the real bytes', () => {
  const inherited = SDK[85]!, next = SDK[86]!;
  const peers = SDK.slice(70, 87);
  const oldObservation = new Map<string, string>();
  for (const row of [...inherited.selectors, ...(inherited.secondarySelectors ?? []), ...(inherited.secondarySelectorStages ?? []).flat()])
    oldObservation.set(sourceBindingKey(row), row.sha256);
  expect(selectGitHubSourceBindingGroup(peers, oldObservation)).toBe(inherited);
  expect(selectGitHubSourceBindingGroup(peers, completeObserved(peers, next))).toBe(next);
  for (const stale of [OBSERVER, LEAF, BINDER]) {
    const map = new Map(completeObserved(peers, next));
    map.set('source:' + stale, 'f'.repeat(64));
    expect(() => selectGitHubSourceBindingGroup(peers, map)).toThrow();
  }
});

it('the canonical holds 504 unique rows matching the live tree', () => {
  const rows = JSON.parse(readFileSync(path.join(ROOT, 'scripts/lib/independent-admission/consumer-execution-current.json'), 'utf8')) as { path: string; sha256: string }[];
  expect(rows).toHaveLength(504);
  expect(new Set(rows.map(r => r.path)).size).toBe(504);
  for (const row of rows) expect(sha(row.path), row.path).toBe(row.sha256);
  expect(LINUX).toHaveLength(SDK.length + 1);
  expect(LINUX.some((g: any) => whole(g) === whole(SDK[SDK.length - 1]))).toBe(true);
});
