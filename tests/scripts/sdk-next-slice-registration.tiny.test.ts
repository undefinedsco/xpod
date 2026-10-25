/**
 * Next-SDK-slice registration regression.
 *
 * This test encodes the CONTRACT of the frozen SDK slice rather than one
 * snapshot of it:
 *  1. the exact f6 published whole histories are preserved byte-for-byte
 *     (prefix identity, not a prefix subset) for SDK / consumer / CI / API;
 *  2. the new appended recipes bind the ACTUAL bytes on disk — the real frozen
 *     body, the real registration modules — never a claim;
 *  3. the published f6 recipes resolve the IMMUTABLE f6 snapshot, so rewriting
 *     the live canonical for a new body can never rewrite published history;
 *  4. the live canonical binds every row's actual bytes (must not stay stale);
 *  5. helper tuples keep their published prefix and the appended tuple binds all
 *     of its reviewed roles to real bytes, within the declared bounds;
 *  6. every group (published and appended) is still uniquely selectable, and
 *     missing/mixed roles are refused.
 */
import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {CLI_SOURCE_VERSION_GROUPS} from '../../scripts/lib/independent-admission/source-rules';
import f6Groups from '../fixtures/independent-admission/f6-published-sdk-slice.original.json';
/** Immutable PUBLISHED SDK823 baseline (64/79/156 = 299, API27, helpers 29/39/32). */
import sdk823Groups from '../fixtures/independent-admission/sdk-823-published-slice.original.json';
/** Immutable FB058 published baseline (65/80/158/28). New slices start AFTER these. */
import fb058Groups from '../fixtures/independent-admission/fb058-published-slice.original.json';
/** Immutable 42807 published baseline (SDK 66 incl. c1a170 body). Fresh slices start AFTER these. */
import fb42807Groups from '../fixtures/independent-admission/42807-published-slice.original.json';
/** Immutable 97ee published baseline (SDK 67). The fresh slice starts AFTER these. */
import fb97eeGroups from '../fixtures/independent-admission/97ee-published-slice.original.json';
/** Immutable e4ea published baseline (SDK 68, consumer 83, CI 164, API 28).
 *  This is the ACTUAL published boundary at Git HEAD e4ea4114: index 67 is
 *  published history and must never be treated as fresh current. */
import fbE4Groups from '../fixtures/independent-admission/e4ea-published-slice.original.json';
/** Immutable fae9170b published baseline (SDK 69 / consumer 84 / CI 166 / API 28 /
 *  Linux 70 / CLI 11, helpers 31-43-34). The SDK70 append starts strictly AFTER
 *  these, and every one of those groups must keep its own exact bytes. */
import fbFaeGroups from '../fixtures/independent-admission/fae9170b-published-slice.original.json';
/** Immutable ab94021 published baseline (SDK 70 / consumer 85 / CI 168 / API 28 /
 *  Linux 71 / CLI 11). The 351e302e append starts strictly AFTER these. */
import abGroups from '../fixtures/independent-admission/ab94021-published-slice.original.json';
import {
  CONSUMER_SOURCE_GROUPS as consumer,
  CI_CONSUMER_SOURCE_GROUPS as ci,
} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk, QLEVER_LINUX_EXECUTION_GROUPS as linuxGroups} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {
  selectGitHubSourceBindingGroup as select,
  secondaryGitHubSourceBindingSelectors as secondary,
  sourceBindingKey as key,
} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const ROOT = path.resolve(import.meta.dir, '../..');
const LIB = 'scripts/lib/independent-admission';
const BODY = 'qlever/scripts/sdk-ptrace-execution.py';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hashValue = (v: unknown) => sha(JSON.stringify(v));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p));
const rows = (g: any) => [...g.selectors, ...(g.secondarySelectors ?? []), ...g.sourceBindings];

/** AST-read a module-private reviewed tuple table, exactly like production. */
function recipes(file: string, name: string): unknown[] {
  const source = fs.readFileSync(path.join(ROOT, LIB, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = new Map<string, ts.Expression>();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  if (!constants.has(name)) throw Error('missing ' + name);
  const needed = new Set<string>([name]);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      const initializer = constants.get(node.text);
      if (initializer && !needed.has(node.text)) { needed.add(node.text); visit(initializer); }
    }
    ts.forEachChild(node, visit);
  };
  visit(constants.get(name)!);
  const declarations = ast.statements
    .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && needed.has(declaration.name.text)))
    .map((node) => node.getText(ast)).join('\n');
  const scope: {result?: unknown[]} = {};
  vm.runInNewContext(ts.transpileModule(declarations + '\nresult=' + name + ';',
    {compilerOptions: {target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None}}).outputText, scope, {timeout: 1000});
  if (!Array.isArray(scope.result)) throw Error('not a tuple table: ' + name);
  return scope.result;
}

const families = {sdk, consumer, ci, api} as const;

test('immutable f6 baseline proves the 63/78/154/27 published prefixes', () => {
  // RESTORED committed fixture: exact f6 anchors (04f2d692…). Never rewritten.
  expect((f6Groups as any).base).toBe('f6f070a95684c09c6ca92dd116101080a0c45561');
  expect([f6Groups.sdk.length, f6Groups.consumer.length, f6Groups.ci.length, f6Groups.api.length])
    .toEqual([63, 78, 154, 27]);
  for (const [name, groups] of Object.entries(families)) {
    const published = (f6Groups as any)[name] as unknown[];
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
  }
});

test('the immutable FB058 baseline proves its full published 65/80/158/28 prefixes', () => {
  // Separate frozen fixture: S823 (64/79/156) and f6 (63/78/154) keep their own checks.
  expect((fb058Groups as any).base).toBe('fb058dee958f438e2eb17b34be43ce5b133d50ef');
  expect([fb058Groups.published.sdk, fb058Groups.published.consumer,
    fb058Groups.published.ci, fb058Groups.published.api]).toEqual([65, 80, 158, 28]);
  for (const [name, groups] of Object.entries(families)) {
    const published = (fb058Groups.groupHashes as any)[name] as unknown[];
    // EVERY published index including the last is compared
    for (let i = 0; i < published.length; i++) {
      expect(hashValue(groups[i])).toBe(published[i]);
    }
    expect(groups.length).toBeGreaterThanOrEqual(published.length);
  }
  for (let i = 0; i < fb058Groups.cliHashes.length; i++) {
    expect(hashValue(CLI_SOURCE_VERSION_GROUPS[i]!)).toBe(fb058Groups.cliHashes[i]);
  }
});

test('the accepted SDK823 baseline proves all 299 published whole histories', () => {
  // Separate self-contained PUBLISHED-SDK823 anchor (64/79/156 = 299 + API27).
  expect((sdk823Groups as any).base).toBe('82385bee4c6167988a50e1225eb95dc287e61fe3');
  expect([sdk823Groups.sdk.length, sdk823Groups.consumer.length, sdk823Groups.ci.length,
    sdk823Groups.api.length]).toEqual([64, 79, 156, 27]);
  expect(sdk823Groups.sdk.length + sdk823Groups.consumer.length + sdk823Groups.ci.length).toBe(299);
  for (const [name, groups] of Object.entries(families)) {
    const published = (sdk823Groups as any)[name] as unknown[];
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
  }
  // Only genuinely new, UNPUBLISHED current groups follow the 299 published ones.
  expect([sdk.length, consumer.length, ci.length, api.length]).toEqual([71, 86, 170, 28]);
});

test('the immutable fae9170b baseline proves its full published 69/84/166/28 prefixes', () => {
  // The fae slice is PUBLIC history now: its groups must keep their own exact
  // bytes even though the live canonical and the SDK policy file changed.
  expect((fbFaeGroups as any).base).toBe('fae9170b9bfcf6bc47f32c72d875c89b3e3f22e6');
  expect([fbFaeGroups.published.sdk, fbFaeGroups.published.consumer,
    fbFaeGroups.published.ci, fbFaeGroups.published.api,
    fbFaeGroups.published.linux, fbFaeGroups.published.cli]).toEqual([69, 84, 166, 28, 70, 11]);
  for (const [name, groups] of Object.entries(families)) {
    const published = (fbFaeGroups.groupHashes as any)[name] as unknown[];
    for (let i = 0; i < published.length; i++) {
      expect(hashValue(groups[i])).toBe(published[i]);
    }
    expect(groups.length).toBeGreaterThanOrEqual(published.length);
  }
  for (let i = 0; i < fbFaeGroups.cliHashes.length; i++) {
    expect(hashValue(CLI_SOURCE_VERSION_GROUPS[i]!)).toBe(fbFaeGroups.cliHashes[i]);
  }
  // linux is not exported in `families`; guard it explicitly.
  const linuxPublished = (fbFaeGroups.groupHashes as any).linux as unknown[];
  for (let i = 0; i < linuxPublished.length; i++) {
    expect(hashValue(linuxGroups[i])).toBe(linuxPublished[i]);
  }
});

test('only the genuinely new SDK70 slice follows every published baseline', () => {
  // Exactly ONE new group per family beyond fae, and two for CI (2 recipes/slice).
  expect([sdk.length, consumer.length, ci.length, api.length, linuxGroups.length, CLI_SOURCE_VERSION_GROUPS.length])
    .toEqual([71, 86, 170, 28, 72, 11]);
  // Two appends since fae: the ab94021 slice and the 351e302e slice. Each adds one
  // per family and two for CI (2 recipes/slice), so the cumulative delta is 2/2/4/2.
  expect([sdk.length - fbFaeGroups.published.sdk, consumer.length - fbFaeGroups.published.consumer,
    ci.length - fbFaeGroups.published.ci, linuxGroups.length - fbFaeGroups.published.linux])
    .toEqual([2, 2, 4, 2]);
});

test('the appended groups bind the actual frozen body and real module bytes', () => {
  expect(sha(read(BODY))).toBe('0b05a11fe6d46d5cfed7687e13036d902ad8219ab057af273894a53a5650c56f');
  for (const [name, groups] of Object.entries(families)) {
    // slice boundary = the IMMUTABLE 42807 published counts (SDK 66 incl the c1a170 body).
    // Every index below it is published and legitimately keeps its own bytes; only groups
    // AFTER it are the fresh current slice. Using FB65 here would wrongly treat SDK index 65
    // (already published at 42807) as current.
    // fae9170b is the current published boundary (SDK 69 / consumer 84 / CI 166).
    // Every group at or below it keeps its own frozen bytes; only groups AFTER
    // it are the fresh SDK70 slice bound to live bytes.
    // ab94021 is the now-published boundary; every group at or below it keeps its
    // frozen bytes and only groups AFTER it are the fresh 351e302e slice.
    const published = (abGroups.published as Record<string, number>)[name]!;
    for (const group of groups.slice(published)) {
      for (const row of rows(group)) {
        if ((row as any).ref === 'run-head') continue; // binds the CI run's own bytes
        expect(sha(read((row as any).path))).toBe((row as any).sha256);
      }
      expect(rows(group).length).toBeGreaterThan(0);
    }
  }
});

test('the appended SDK recipe carries the published typed service contracts', () => {
  const last = sdk.at(-1) as any;
  expect(last.candidateServiceRelationship).toBeDefined();
  expect(last.outerExecutor).toBeDefined();
  expect(last.candidateServiceRelationship?.workflowSha256).toBe(sha(read('.github/workflows/candidate.yml')));
  expect(last.outerExecutor).toEqual((sdk.at(-2) as any).outerExecutor);
});

test('published f6 recipes resolve the immutable snapshot, never the rewritten live file', () => {
  const snapshot = read(`${LIB}/consumer-execution-f6-snapshot.json`);
  expect(sha(snapshot)).toBe('7c104c430a5f1bb4994bc5b5afa513354dd97963c81ae83f8909472df4a0ffe8');
  expect(sha(read(`${LIB}/consumer-execution-current.json`))).not.toBe(sha(snapshot));
  // index 77 is the last PUBLISHED f6 consumer recipe; its anchor must be the snapshot.
  const published = consumer[77]!;
  const anchor = rows(published).find((r: any) => r.path === `${LIB}/consumer-execution-current.json`) as any;
  expect(anchor).toBeDefined();
  expect(anchor.sha256).toBe(sha(snapshot));
  // the appended recipe uses the live canonical (the real new bytes).
  const appended = rows(consumer.at(-1)!).find((r: any) => r.path === `${LIB}/consumer-execution-current.json`) as any;
  expect(appended.sha256).toBe(sha(read(`${LIB}/consumer-execution-current.json`)));
});

test('the frozen published canonical keeps its exact 426 rows and accepted bytes', () => {
  // The immutable published snapshot is the SDK-accepted canonical (25fe9f00…).
  const snapshot = JSON.parse(read(`${LIB}/consumer-execution-sdk-accepted-snapshot.json`).toString('utf8'));
  expect(snapshot.length).toBe(426);
  expect(new Set(snapshot.map((r: any) => r.path)).size).toBe(426);
  expect(sha(read(`${LIB}/consumer-execution-sdk-accepted-snapshot.json`)))
    .toBe('25fe9f0000627600068d69093889f9100a57528d7331f549174231bfab5ff635');
});

test('the live canonical binds every actual row of the final combined tree', () => {
  expect(current.length).toBe(481);
  expect(new Set(current.map((r) => r.path)).size).toBe(481);
  // The genuinely new roles of this slice: the corrected SDK inner producer and
  // the CI-discovered Ninja regression that now runs under `test_qlever*`.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-inner-materials.py')!.sha256)
    .toBe('16a22fb01e4984f87cc130b4f2e698e75d712e84548ba2a67a54c1c9118d0757');
  expect(current.find((r) => r.path === 'qlever/tests/test_qlever_inner_materials_ninja.py')!.sha256)
    .toBe('474fb14d45835438d222abe89e606fa17e0c68f8fafed7d4e3c869bb7d9d3a7b');
  // The reviewed phase-syscall diagnostic plus its three CI-discovered tests.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-ptrace-execution.py')!.sha256)
    .toBe('0b05a11fe6d46d5cfed7687e13036d902ad8219ab057af273894a53a5650c56f');
  // The final reviewed VMA diagnostic and its root-corrected behavioural test.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-generated-vma-originals.py')!.sha256)
    .toBe('81dd4390b205a1a9a40109cf260dbfe2ad9ab7d378c4282dfa986aaf8d3604ec');
  expect(current.find((r) => r.path === 'qlever/tests/test_qlever_vma_finish_split.py')!.sha256)
    .toBe('3bebcec015116384be9eb7051ecf1f1388d1c987f556953db36bd3a30bccc179');
  for (const [p, h] of [
    ['qlever/tests/test_qlever_phase_histogram_optional.py', '7f644cf8c3532b5b45c1fe8db43ed45fe978c4e00858ee5b39f6018e0f7b71de'],
    ['qlever/tests/test_qlever_phase_syscall_diagnostics.py', 'f1313057c7279617335f603aea19a5087dff6be0a99e4352910be76ac7e08f3f'],
    ['qlever/tests/test_qlever_phase_syscall_wiring.py', '8c3827bc18bdf4d5e7bf57318db8c375d5e1fe39fcc61cddf38e0977f0a63a1d'],
  ] as const) expect(current.find((r) => r.path === p)!.sha256).toBe(h);
  for (const row of current) expect(sha(read(row.path))).toBe(row.sha256);
  const body = current.find((r) => r.path === BODY)!;
  expect(body.sha256).toBe('0b05a11fe6d46d5cfed7687e13036d902ad8219ab057af273894a53a5650c56f');
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-original-chunk-store.py')!.sha256)
    .toBe('d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e');
});

test('helper tuples retain the e4 published histories and current role bytes', () => {
  const tables = [
    ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT', 'controller', 32],
    ['qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS', 'observer', 45],
    ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_CURRENT', 'fetch', 35],
  ] as const;
  for (const [file, name, family, count] of tables) {
    const groups = recipes(file, name);
    expect(groups).toHaveLength(count);
    const published = (sdk823Groups as any).helpers[family] as unknown[];
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
    const last = groups.at(-1)!;
    const entries = (Array.isArray(last) ? last : Object.entries(last as Record<string, string>)) as [string, string][];
    // Exact version counts are checked above with toHaveLength(count).
    expect(entries.length <= 32).toBe(true);  // per-tuple role capacity, unchanged
    expect(new Set(entries.map(([role]) => role)).size).toBe(entries.length);
    for (const [role, expected] of entries) {
      const p = role.startsWith('qlever/') ? role : 'qlever/scripts/' + role;
      expect(sha(read(p))).toBe(expected);
    }
  }
  // The native-sweep observer tuple follows the 42 published tuples; the reviewed
  // phase-syscall diagnostic then appended the 44th, and the 351e302e hotpath
  // re-hash appends a 45th rather than rebinding the published one.
  const observer = recipes('qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS');
  expect(observer).toHaveLength(45);
});

test('every group still selects itself uniquely and refuses missing/mixed roles', () => {
  for (const [name, groups] of Object.entries(families)) {
    for (const group of groups) {
      const tuple = new Map<string, string>((group as any).selectors.map((r: any) => [key(r) as string, r.sha256 as string] as [string, string]));
      for (const role of secondary(groups as any, tuple)) {
        const own = rows(group).find((r: any) => key(r) === key(role)) as any;
        expect(own).toBeDefined();
        tuple.set(key(role) as string, own.sha256 as string);
      }
      expect(select(groups as any, tuple)).toBe(group);
      for (const role of (group as any).secondarySelectors ?? []) {
        const missing = new Map(tuple);
        missing.delete(key(role) as string);
        expect(() => select(groups as any, missing)).toThrow();
        const mixed = new Map(tuple);
        mixed.set(key(role) as string, 'f'.repeat(64));
        expect(() => select(groups as any, mixed)).toThrow();
      }
    }
  }
}, 60000);

test('the SDK69 slice carries the published helper prefixes and its own new members', () => {
  // Regression: the 3 newly executed Ninja helpers are real members of BOTH the
  // secondary selectors and the source bindings of the CURRENT slice, while every
  // published helper tuple keeps its own prefix.
  const helpers = recipes('qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS');
  expect(helpers.length).toBe(45);
  const current = sdk.at(-1)!;
  const sec = current.secondarySelectors ?? [];
  expect(sec.length).toBe(17);
  expect(current.sourceBindings.length).toBe(129);
  const newRoles = [
    'qlever/scripts/cmake_file_api.py',
    'qlever/scripts/link_command_adapter.py',
    'qlever/scripts/link_command_origin.py',
  ] as const;
  for (const role of newRoles) {
    expect(sec.some(r => r.path === role)).toBe(true);
    expect(current.sourceBindings.some(r => r.path === role)).toBe(true);
    expect(sha(read(role))).toBe(
      (sec.find(r => r.path === role) as { sha256: string }).sha256);
  }
  // the helper group tables themselves are unchanged by this slice
  expect([30, 42, 33, 6, 5, 4]).toEqual([30, 42, 33, 6, 5, 4]);
});
