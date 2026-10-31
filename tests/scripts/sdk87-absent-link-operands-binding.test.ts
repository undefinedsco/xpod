/** SDK87 absent link/unlink operand slice (APPEND-ONLY, UNPUBLISHED).
 *
 * SDK87 inherits SDK86's stage surface and re-pins only the explicitly
 * reviewed CURRENT roles. Both locked PCH patches append source bindings;
 * every published SDK1–86 tuple retains its exact historical value.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {it, expect} from 'vitest';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK, QLEVER_LINUX_EXECUTION_GROUPS as LINUX} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup, sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CSS_SOURCE_PARENT_VERSIONS} from '../../scripts/lib/independent-admission/module-source-phases';
/** Historical CSS diagnostics producer, pinned by published SDK0–86. */
const HISTORICAL_CSS_PRODUCER = '9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4';
import {CURRENT_CANONICAL_SOURCE_ROWS, completeObserved} from './source-binding-group.fixture';
import historicalWhole from '../fixtures/independent-admission/sdk86-historical-whole-hashes.json';

const ROOT = path.resolve(import.meta.dirname, '../..');
const whole = (g: unknown) => createHash('sha256').update(JSON.stringify(g)).digest('hex');
const sha = (p: string) => createHash('sha256').update(readFileSync(path.join(ROOT, p))).digest('hex');
const BINDER = 'qlever/scripts/sdk-generation-multiprocess-bindings.py';
const OBSERVER = 'qlever/scripts/sdk-ptrace-execution.py';
const LEAF = 'tests/scripts/candidate-producer-attempt-binding.test.ts';
const LOCK = 'qlever/qlever.lock.json';
const SERIES = 'qlever/patches/series';
const BUILDER = 'qlever/scripts/build-qlever-runtime-sdk.sh';
const PATCH = 'qlever/patches/qlever-antlr-scoped-pch-and-server-pch-reuse.patch';
const LEASES = 'qlever/scripts/sdk-tool-lifetime-leases.py';
const LEASE_EXT = 'qlever/scripts/native/lease_sweep_ext.c';
const LEASE_BINDING = 'qlever/scripts/native/lease_sweep_binding.py';
const EXECUTOR_BINDINGS = 'qlever/scripts/sdk-readonly-executor-bindings.py';
/** The readonly executor itself is a CURRENT SDK87 role re-pinned to the v3 bytes. */
const EXECUTOR = 'qlever/scripts/sdk-readonly-executor.py';
/** Its last reviewed historical (SDK86) digest; the CURRENT one must differ. */
const EXECUTOR_STALE = '70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86';
const KERNEL_PROBE = 'qlever/scripts/sdk-kernel-policy-probe.py';
const READONLY_NORMAL = '.github/workflows/qlever-readonly-normal-job.yml';
// SDK70 now uses the whole canonical limit profile, changing only its current
// digest. Its inherited role and SDK1–86 historical values remain unchanged.
const SDK70_E2E = 'qlever/tests/test_sdk70_mremap_e2e.py';
const SOURCE_ORIGINALS = 'qlever/scripts/sdk-generated-source-originals.py';
// SDK87 genuine CURRENT re-registrations appended by subsequent reviewed slices:
// the generated-VMA originals module, the readonly normal route, the readonly
// result context, and the generated-VMA fixtures test. Each is asserted by exact
// path below, so the whole set stays an exact equality (no subset assertion).
const VMA_ORIGINALS = 'qlever/scripts/sdk-generated-vma-originals.py';
const COORDINATED_WAIT = 'qlever/scripts/sdk-coordinated-wait.py';
const READONLY_ROUTE = 'qlever/scripts/sdk-readonly-normal-route.py';
const READONLY_CONTEXT = 'qlever/scripts/sdk-readonly-result-context.py';
const VMA_FIXTURE_TEST = 'qlever/tests/test_sdk_generated_vma_files.py';
/** CURRENT CSS diagnostics producer; its PRIMARY selector advanced in this slice. */
const CSS_PRODUCER = 'scripts/css-module-producer.py';
const all = (g: any) => [...g.selectors, ...(g.secondarySelectors ?? []), ...(g.secondarySelectorStages ?? []).flat(), ...g.sourceBindings];

/** SDK86's published bytes — HISTORICAL, never replaced with today's tree. */
const SDK86_FROZEN: Readonly<Record<string, string>> = Object.freeze({
  [BINDER]: 'c59c84466007a7641fa69147bfb5f3301a259085f064ceea0962b04d84f23233',
  [OBSERVER]: '1bb9533e6a499b35347c2bc5d66644360cf6eff733251c9fac15d2f704e0662d',
  [LEAF]: '6018218f537a88607be392cb081a53cbdc64cf0fd3f21a00df6f7f9eaf178b76',
});

it('SDK87 whole-inherits SDK86 and re-pins only the reviewed current roles', () => {
  const inherited = SDK[85]!, next = SDK[86]!;
  // CURRENT identity advances coherently on the PRIMARY selector axis too: the
  // reviewed overrides apply to selectors exactly as to the secondary/staged and
  // source-binding axes, so SDK87 cannot hold a historical selector beside a
  // current source binding. Only rows with a reviewed override move; every other
  // selector row keeps SDK86's exact bytes and position.
  const inheritedSelectors = inherited.selectors ?? [];
  const currentSelectors = next.selectors ?? [];
  expect(currentSelectors.length).toBe(inheritedSelectors.length);
  const movedSelectors: string[] = [];
  for (let i = 0; i < inheritedSelectors.length; i++) {
    expect(currentSelectors[i].path, `selector[${i}].path`).toBe(inheritedSelectors[i].path);
    if (inheritedSelectors[i].sha256 !== currentSelectors[i].sha256) movedSelectors.push(currentSelectors[i].path);
  }
  // The only reviewed current selector override at this slice is the CSS producer.
  expect(movedSelectors).toEqual(['scripts/css-module-producer.py']);
  expect(currentSelectors.find(r => r.path === 'scripts/css-module-producer.py')!.sha256)
    .toBe(sha('scripts/css-module-producer.py'));
  // The historical SDK86 selector for that path keeps its published bytes.
  expect((inheritedSelectors.find(r => r.path === 'scripts/css-module-producer.py') as any)?.sha256 ?? HISTORICAL_CSS_PRODUCER)
    .toBe(HISTORICAL_CSS_PRODUCER);
  expect(JSON.stringify(next.candidateServiceRelationship)).toBe(JSON.stringify(inherited.candidateServiceRelationship));
  // CURRENT outerExecutor: the ONLY field that advances is `collector`, and it must
  // equal the group's OWN current source binding for that exact file. Every other
  // whole field (workflow/additionalWorkflows/uploadDomain/steps/model) stays
  // identical to the inherited group, and the historical group keeps its own
  // collector — so a hybrid (current bindings + old collector) cannot arise.
  const nextOuter: any = next.outerExecutor;
  const inheritedOuter: any = inherited.outerExecutor;
  expect(nextOuter.collector.sha256).toBe(sha('qlever/scripts/sdk-readonly-executor.py'));
  expect(nextOuter.collector.sha256).not.toBe(inheritedOuter.collector.sha256);
  const ownBinding = (next.sourceBindings ?? []).find(r => r.path === nextOuter.collector.path);
  expect(ownBinding?.sha256).toBe(nextOuter.collector.sha256);
  expect(ownBinding?.reviewedSha256?.length ?? 0).toBe(0);
  for (const key of ['schemaVersion', 'model', 'workflowPath', 'workflowSha256',
    'uploadDomain', 'ownedSteps', 'allowedBeforeController'] as const) {
    expect(JSON.stringify(nextOuter[key])).toBe(JSON.stringify(inheritedOuter[key]));
  }
  expect(JSON.stringify(nextOuter.additionalWorkflows)).toBe(JSON.stringify(inheritedOuter.additionalWorkflows));
  // The historical group is untouched: it keeps its own collector value.
  expect(inheritedOuter.collector.sha256).not.toBe(nextOuter.collector.sha256);
  // this slice adds no stage and keeps the whole stage surface
  expect((next.secondarySelectorStages ?? []).length).toBe((inherited.secondarySelectorStages ?? []).length);
  const expectedStages = (inherited.secondarySelectorStages ?? []).map(stage => stage.map(row =>
    row.path === BUILDER ? {...row, sha256: sha(BUILDER)} : row));
  expect(JSON.stringify(next.secondarySelectorStages)).toBe(JSON.stringify(expectedStages));
  // Both locked PCH patches and the lossless generated-producer transport codec
  // append explicit CURRENT source roles. Every inherited row keeps its position;
  // the three new rows are asserted exactly, and the codec is the new canonical
  // role (the appended tail therefore grows by three, not two).
  expect(next.sourceBindings.length).toBe(inherited.sourceBindings.length + 3);
  const before = all(inherited), after = all(next);
  expect(after.length).toBe(before.length + 3);
  expect(after.at(-3)!.path).toBe('qlever/patches/qlever-s2-scoped-precompiled-headers.patch');
  expect(after.at(-2)!.path).toBe(PATCH);
  expect(after.at(-2)!.sha256).toBe(sha(PATCH));
  expect(after.at(-1)!.path).toBe('qlever/scripts/sdk-generated-producer-transport.py');
  expect(after.at(-1)!.sha256).toBe(sha('qlever/scripts/sdk-generated-producer-transport.py'));
  const moved: string[] = [];
  for (let i = 0; i < before.length; i++) {
    expect(after[i].path, `role[${i}].path`).toBe(before[i].path);
    if (before[i].sha256 !== after[i].sha256) moved.push(after[i].path);
  }
  // The observer (4 inherited occurrences) and the leaf (1) move, plus the QLever
  // lock/series, the current builder documentation whose bytes changed, the
  // generated-source originals module that now emits the transport projection, and
  // the SDK70 replay fixture that now uses the whole canonical limit profile.
  // SDK87 also re-pins the readonly executor ITSELF (2 inherited occurrences) to
  // the reviewed v3 bytes, so that CURRENT role belongs in this exact set.
  expect(new Set(moved)).toEqual(new Set([OBSERVER, LEAF, LOCK, SERIES, LEASES, LEASE_EXT, LEASE_BINDING, BUILDER, EXECUTOR_BINDINGS, EXECUTOR, READONLY_NORMAL, BINDER, KERNEL_PROBE, SOURCE_ORIGINALS, CSS_PRODUCER, SDK70_E2E, VMA_ORIGINALS, COORDINATED_WAIT, READONLY_ROUTE, READONLY_CONTEXT, VMA_FIXTURE_TEST]));
  // The four appended CURRENT re-registrations must carry the REAL bytes today.
  // VMA_ORIGINALS is bound in BOTH its selector and source row, so its real
  // occurrence count is two; the other three are single-role bindings.
  // The exact coordinated callback entry moved with the VMA callback; both
  // inherited bindings must carry its current bytes as well.
  for (const [role, occurrences] of [[VMA_ORIGINALS, 2], [COORDINATED_WAIT, 2], [READONLY_ROUTE, 1],
    [READONLY_CONTEXT, 1], [VMA_FIXTURE_TEST, 1]] as const) {
    expect(moved.filter(p => p === role)).toHaveLength(occurrences);
    expect(new Set(all(next).filter(r => r.path === role).map(r => r.sha256))).toEqual(new Set([sha(role)]));
  }
  expect(moved.filter(p => p === OBSERVER)).toHaveLength(4);
  expect(moved.filter(p => p === LEAF)).toHaveLength(1);
  // The filtered-lease lookup slice moves the lease implementation's CURRENT
  // binding only: both inherited occurrences (secondary + source rows).
  expect(moved.filter(p => p === LEASES)).toHaveLength(2);
  // The same slice moves the native plan source and its binding, twice each.
  expect(moved.filter(p => p === LEASE_EXT)).toHaveLength(2);
  expect(moved.filter(p => p === LEASE_BINDING)).toHaveLength(2);
  expect(moved.filter(p => p === BUILDER)).toHaveLength(3);
  // The readonly executor lane derives its parallelism from its own 4-CPU
  // allocation, so its CURRENT bytes move in both inherited occurrences.
  expect(moved.filter(p => p === EXECUTOR_BINDINGS)).toHaveLength(2);
  // SDK87 re-pins the readonly executor ITSELF to the reviewed v3 bytes. It moves
  // in both inherited occurrences, the CURRENT digest must equal the real working
  // tree, and it must genuinely DIFFER from the last reviewed historical digest
  // (a stale re-pin that copied the old value would otherwise pass unnoticed).
  expect(moved.filter(p => p === EXECUTOR)).toHaveLength(2);
  {
    const current = all(next).filter(r => r.path === EXECUTOR).map(r => r.sha256);
    const stale = all(inherited).filter(r => r.path === EXECUTOR).map(r => r.sha256);
    expect(current).toHaveLength(2);
    expect(new Set(current)).toEqual(new Set([sha(EXECUTOR)]));
    expect(new Set(stale)).toEqual(new Set([EXECUTOR_STALE]));
    expect(new Set(current)).not.toEqual(new Set(stale));
  }
  // Its pin list follows the executor lane, so this CURRENT workflow moves once.
  expect(moved.filter(p => p === READONLY_NORMAL)).toHaveLength(1);
  // PR124 strict absent-link contract: the gate consumes the matched failed
  // exits and the fixed probe uses one build-root authority, so both CURRENT
  // bodies move in the unpublished slice only.
  expect(moved.filter(p => p === BINDER)).toHaveLength(3);
  expect(moved.filter(p => p === KERNEL_PROBE)).toHaveLength(1);
  // SDK70 keeps its single inherited occurrence; its current digest moves once.
  expect(moved.filter(p => p === SDK70_E2E)).toHaveLength(1);
  expect(all(next).filter((r: any) => r.path === SDK70_E2E)).toHaveLength(1);
  for (const role of [LEASES, LEASE_EXT, LEASE_BINDING, BUILDER, EXECUTOR_BINDINGS, READONLY_NORMAL, BINDER, KERNEL_PROBE, SOURCE_ORIGINALS, SDK70_E2E]) {
    for (const row of all(next).filter((r: any) => r.path === role)) expect(row.sha256).toBe(sha(role));
  }
  for (const row of all(next).filter((r: any) => r.path === LEASES)) expect(row.sha256).toBe(sha(LEASES));
  // PR124 moves the binder: the gate now settles the matched failed link exits,
  // so its CURRENT bytes legitimately change in this unpublished slice.
  expect(moved).toContain(BINDER);
  for (const row of all(next).filter((r: any) => r.path === BINDER)) expect(row.sha256).toBe(sha(BINDER));
  // current-tree roles bind today's real bytes (OBSERVER/LEAF) ...
  for (const row of all(next).filter((r: any) => r.path === OBSERVER)) expect(row.sha256).toBe(sha(OBSERVER));
  expect(next.sourceBindings.find(r => r.path === LEAF)!.sha256).toBe(sha(LEAF));
  // ... while the binder still carries SDK86's frozen bytes, equal to disk today
  // SDK86's frozen bytes stay historical: they must NOT follow today's tree now
  // that PR124 legitimately moved the binder in the unpublished slice.
  expect(SDK86_FROZEN[BINDER]).not.toBe(sha(BINDER));
  for (const row of all(next).filter((r: any) => r.path === BINDER)) expect(row.sha256).toBe(sha(BINDER));
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
  for (const stale of [OBSERVER, LEAF, BINDER, BUILDER, PATCH, SDK70_E2E]) {
    const map = new Map(completeObserved(peers, next));
    map.set('source:' + stale, 'f'.repeat(64));
    expect(() => selectGitHubSourceBindingGroup(peers, map)).toThrow();
  }
});

it('the canonical holds the current canonical physical originals matching the live tree', () => {
  const rows = JSON.parse(readFileSync(path.join(ROOT, 'scripts/lib/independent-admission/consumer-execution-current.json'), 'utf8')) as { path: string; sha256: string }[];
  expect(rows).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);
  expect(new Set(rows.map(r => r.path)).size).toBe(CURRENT_CANONICAL_SOURCE_ROWS);
  for (const row of rows) expect(sha(row.path), row.path).toBe(row.sha256);
  expect(LINUX).toHaveLength(SDK.length + 1);
  expect(LINUX.some((g: any) => whole(g) === whole(SDK[SDK.length - 1]))).toBe(true);
});

it('SDK87 advances its PRIMARY selectors coherently to the current CSS producer, not a hybrid', () => {
  // CAUSAL REGRESSION for the main-CI Bun failure (40 files / 68 pairs): the CSS
  // diagnostics producer advanced to the CURRENT 1ba bytes, but SDK87 inherited
  // the historical 9bc selector from SDK86, so no real observation of the live
  // tree could satisfy any reviewed group. The CURRENT identity must move on
  // EVERY axis; historical SDK0..86 stay frozen and are not touched by this.
  const next = SDK[SDK.length - 1]!;
  const css = 'scripts/css-module-producer.py';
  const current = sha(css);
  const axes = [next.selectors ?? [], next.secondarySelectors ?? [],
    (next.secondarySelectorStages ?? []).flat(), next.sourceBindings ?? []];
  const cells = axes.flat().filter((row: any) => row.path === css);
  expect(cells.length).toBeGreaterThan(0);
  // Every current cell names the ACTUAL live bytes; none still names 9bc.
  for (const row of cells) expect(row.sha256).toBe(current);
  // The selector axis specifically moved (this is what was stale before the fix).
  const selector = (next.selectors ?? []).filter((row: any) => row.path === css);
  expect(selector.length).toBeGreaterThan(0);
  expect(selector[0].sha256).toBe(current);
  // Anti-hybrid: substituting the historical value into the current identity must
  // NOT select SDK87 — the group is refused rather than silently accepted.
  const observed = new Map(completeObserved(SDK, next));
  expect(selectGitHubSourceBindingGroup(SDK, observed)).toBe(next);
  const hybrid = new Map(observed);
  hybrid.set('source:' + css, HISTORICAL_CSS_PRODUCER);
  expect(() => selectGitHubSourceBindingGroup(SDK, hybrid)).toThrow();
});

it('the reviewed NORMAL CSS product workflow admits the current version and keeps the prior one', () => {
  // CAUSAL REGRESSION for gap 2: the normal css-module-product workflow advanced
  // 9f14303a -> 16f3781a (diagnostic-payload retention). The prior approval must
  // remain admitted; this must NOT be conflated with the CONTROLLED
  // css-native-products table, which is unchanged.
  const currentNormal = sha('.github/workflows/css-module-product.yml');
  const priorNormal = '9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257';
  expect(currentNormal).toBe('16f3781aa25d8a89167538babfcd6bd1eaa8556a54831a1ee78450d158ef2286');
  expect(currentNormal).not.toBe(priorNormal);
  // The controlled native-products path is a different workflow and stays as-is.
  const controlled = sha('.github/workflows/css-native-products.yml');
  expect(controlled).toBe('601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51');
  const parents = CSS_SOURCE_PARENT_VERSIONS.map((row: any) => row.producerSha256);
  // exactly the 4 reviewed rows; the historical 9bc and current 1ba both present.
  expect(parents).toHaveLength(4);
  expect(parents).toContain('9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4');
  expect(parents).toContain('1ba30f5eaba9070f55135936649c43b109bf7a4a83db43b512edaa6d31abc5cc');
  // No normal-workflow hash leaked into the CONTROLLED parent table.
  expect(CSS_SOURCE_PARENT_VERSIONS.every((row: any) => row.workflowSha256 !== currentNormal)).toBe(true);
});
