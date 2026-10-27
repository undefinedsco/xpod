/** SDK86 metadata/ownership slice (APPEND-ONLY, UNPUBLISHED).
 *
 * The slice composes the retained timestamp/link metadata correction with the
 * component-level task-ownership descriptor-sharing simplification. It inherits
 * SDK85 whole, adds no stage, and re-pins ONLY the roles whose bytes moved: the
 * two runtime helpers plus SDK81's mandatory regression leaf (whose frontier
 * counts move on every append).
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

it('SDK86 whole-inherits SDK85 and re-pins exactly the two runtime helpers plus the leaf', () => {
  const inherited = SDK[84]!, next = SDK[85]!;
  expect(JSON.stringify(next.selectors)).toBe(JSON.stringify(inherited.selectors));
  expect(JSON.stringify(next.candidateServiceRelationship)).toBe(JSON.stringify(inherited.candidateServiceRelationship));
  expect(JSON.stringify(next.outerExecutor)).toBe(JSON.stringify(inherited.outerExecutor));
  // no new stage and an unchanged stage surface
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
  expect(new Set(moved)).toEqual(new Set([BINDER, OBSERVER, LEAF]));
  // both helpers own a stage-0 secondarySelector AND a sourceBinding
  // binder owns a stage-0 secondarySelector AND a sourceBinding (3 occurrences);
  // the observer owns 4 inherited occurrences; the leaf is a sourceBinding only.
  expect(moved.filter(p => p === BINDER)).toHaveLength(3);
  expect(moved.filter(p => p === OBSERVER)).toHaveLength(4);
  expect(moved.filter(p => p === LEAF)).toHaveLength(1);
  for (const row of all(next).filter((r: any) => r.path === BINDER || r.path === OBSERVER)) expect(row.sha256).toBe(sha(row.path));
  expect(next.sourceBindings.find(r => r.path === LEAF)!.sha256).toBe(sha(LEAF));
});

it('generic selector resolves SDK85/current/stale against the real bytes', () => {
  const inherited = SDK[84]!, next = SDK[85]!;
  const peers = SDK.slice(69, 86);
  const oldObservation = new Map<string, string>();
  for (const row of [...inherited.selectors, ...(inherited.secondarySelectors ?? []), ...(inherited.secondarySelectorStages ?? []).flat()])
    oldObservation.set(sourceBindingKey(row), row.sha256);
  expect(selectGitHubSourceBindingGroup(peers, oldObservation)).toBe(inherited);
  expect(selectGitHubSourceBindingGroup(peers, completeObserved(peers, next))).toBe(next);
  const stale = new Map(completeObserved(peers, next));
  stale.set('source:' + BINDER, 'f'.repeat(64));
  expect(() => selectGitHubSourceBindingGroup(peers, stale)).toThrow();
});

it('the canonical holds 504 unique rows matching the live tree', () => {
  const rows = JSON.parse(readFileSync(path.join(ROOT, 'scripts/lib/independent-admission/consumer-execution-current.json'), 'utf8')) as { path: string; sha256: string }[];
  expect(rows).toHaveLength(504);
  expect(new Set(rows.map(r => r.path)).size).toBe(504);
  for (const row of rows) expect(sha(row.path), row.path).toBe(row.sha256);
  expect(LINUX).toHaveLength(SDK.length + 1);
  expect(LINUX.some((g: any) => whole(g) === whole(SDK[SDK.length - 1]))).toBe(true);
});

it('every historical SDK whole group is byte-identical to the frozen prefix', () => {
  // Guards against the exact regression this slice once caused: a global
  // find/replace of a live leaf hash silently rewrote SDK81's historical group.
  expect(historicalWhole).toHaveLength(85);
  for (let i = 0; i < historicalWhole.length; i++) {
    expect(whole(SDK[i]), `SDK[${i}]`).toBe(historicalWhole[i]);
  }
  // SDK81 specifically: its leaf keeps the frozen pre-SDK86 value.
  const sdk81 = all(SDK[80]).find((r: any) => r.path === LEAF);
  expect(sdk81!.sha256).toBe('f1a165e7a2f2ad3a6f8f5443c0eb6c255cb84c6caf08eaf0bdb23bc916f895e9');
  // and the new value lives ONLY in the appended SDK86 group.
  const sdk86 = all(SDK[85]).filter((r: any) => r.path === LEAF);
  expect(sdk86).toHaveLength(1);
  expect(sdk86[0].sha256).toBe(sha(LEAF));
});
