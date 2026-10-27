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
import {completeObserved} from './source-binding-group.fixture';
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
/** Immutable ce9a85a published baseline (SDK 71 / consumer 86 / CI 170 / API 28 /
 *  Linux 72 / CLI 11). The B794 owned-window append starts strictly AFTER these. */
import ce9Groups from '../fixtures/independent-admission/ce9a85a-published-slice.original.json';
import n9d02Groups from '../fixtures/independent-admission/9d02b2d-published-slice.original.json';
/** Immutable 2406eac published baseline (73/88/174/28, Linux 74, CLI 11). The
 * immutable-input-plan append starts strictly AFTER these groups. */
import n2406Groups from '../fixtures/independent-admission/2406eac-published-slice.original.json';
/** Immutable f803 published baseline (74/89/176/75/28/11). Index 73 is PUBLISHED
 * history now, so it must be proved against the actual f803 bytes and must NOT be
 * compared to current disk (its manifest rows predate the ORM 0.3.26 bump). */
import f803Groups from '../fixtures/independent-admission/f803e9c2-published-slice.original.json';
/** Immutable PUBLISHED 0d baseline (76/77/91/180/29/12).
 * Its tuples are history and bind their own 0d Git bytes, never today's disk. */
import n0dGroups from '../fixtures/independent-admission/0d-published-slice.original.json';
/** Immutable PUBLISHED 6b baseline (77/78/93/184). Its tuples are history and
 * bind their own 6b Git bytes, never today's disk. */
import n6bGroups from '../fixtures/independent-admission/6b-published-slice.original.json';
/** Immutable PUBLISHED 71f9 baseline (78/79/94/186 at capture: 77/78/93/184).
 * Its tuples are history and bind their own 71f9 bytes, never today's disk. */
import n71f9Groups from '../fixtures/independent-admission/71f9-published-slice.original.json';
/** Immutable PUBLISHED cbb baseline (79/80/95/188). Its tuples are history. */
import ncbbGroups from '../fixtures/independent-admission/cbb-published-slice.original.json';
/** Immutable PUBLISHED DCA baseline (79/80/95/188): its tuples are history. */
import ndcaGroups from '../fixtures/independent-admission/dca-published-slice.original.json';
/** Immutable PUBLISHED 19fe baseline (75/90/178/29/76/12). Index 74 (SDK) and
 * 89 (consumer) are published history now, so they must be proved against the
 * ACTUAL 19fe bytes and never against today's disk. */
import n19feGroups from '../fixtures/independent-admission/19fe-published-slice.original.json';
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
const rows = (g: any) => [...g.selectors, ...(g.secondarySelectors ?? []), ...((g.secondarySelectorStages ?? []).flat()), ...g.sourceBindings];

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
  // Only genuinely new, UNPUBLISHED current groups follow the 299 published ones:
  // the immutable-input-plan slice, the ORM 0.3.26 joint API/CLI/consumer/CI tail
  // and the ORM 0.3.26 joint SDK tuple.
  expect([sdk.length, consumer.length, ci.length, api.length]).toEqual([84, 99, 196, 29]);
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

test('only the genuinely new immutable-input-plan slice follows published2406', () => {
  // Appends beyond published2406: the immutable-input-plan slice, the ORM 0.3.26
  // joint tail, and the candidate-producer-attempt SDK81/new current tails.
  expect([sdk.length, consumer.length, ci.length, api.length, linuxGroups.length, CLI_SOURCE_VERSION_GROUPS.length])
    .toEqual([84, 99, 196, 29, 85, 12]);
  expect([(n2406Groups as any).published.sdk, (n2406Groups as any).published.consumer,
    (n2406Groups as any).published.ci, (n2406Groups as any).published.linux]).toEqual([73, 88, 174, 74]);
  expect([sdk.length - n2406Groups.published.sdk, consumer.length - n2406Groups.published.consumer,
    ci.length - n2406Groups.published.ci, linuxGroups.length - n2406Groups.published.linux])
    .toEqual([11, 11, 22, 11]);
  // Every published2406 group keeps its own exact bytes, including its last.
  for (const [name, groups] of Object.entries({sdk, consumer, ci, api, linux: linuxGroups})) {
    const published = (n2406Groups as any).groupHashes[name] as unknown[];
    for (let i = 0; i < published.length; i++) expect(hashValue((groups as readonly unknown[])[i])).toBe(published[i]);
    expect((groups as readonly unknown[]).length).toBeGreaterThanOrEqual(published.length);
  }
  for (let i = 0; i < (n2406Groups as any).cliHashes.length; i++) {
    expect(hashValue(CLI_SOURCE_VERSION_GROUPS[i]!)).toBe((n2406Groups as any).cliHashes[i]);
  }
});

test('the appended groups bind the actual frozen body and real module bytes', () => {
  expect(sha(read(BODY))).toBe('e85c370cf26b45d911d90d8fbe99de67242d57620ec5cff6990d3e22f3e76999');
  for (const [name, groups] of Object.entries(families)) {
    // PUBLISHED f803 history ends at the f803 counts (SDK 74, i.e. indices 0..73).
    // Those tuples — including index 73 — are immutable published history: they are
    // proved against the ACTUAL f803 read bytes recorded in the fixture, never
    // against the current working tree, whose manifest rows moved with ORM 0.3.26.
    // PROVE the published 19fe prefix byte-for-byte (whole values, not disk).
    const published = (n19feGroups.published as Record<string, number>)[name]!;
    const publishedHashes = (n19feGroups.groupHashes as Record<string, string[]>)[name]!;
    expect(publishedHashes).toHaveLength(published);
    for (let index = 0; index < published; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(publishedHashes[index]);
    }
    // The 0d commit is ALSO published now. Those tuples legitimately bind their
    // own historical Git bytes (e.g. github-origin 1181832c…), which differ from
    // today's file, so they must keep being verified as immutable HISTORY and must
    // never be re-bound, skipped or replaced by value equality.
    const published0d = (n0dGroups.published as Record<string, number>)[name]!;
    const hashes0d = (n0dGroups.groupHashes as Record<string, string[]>)[name]!;
    expect(hashes0d).toHaveLength(published0d);
    for (let index = 0; index < published0d; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(hashes0d[index]);
    }
    // 6b is published too: those tuples are immutable history as well.
    const published6b = (n6bGroups.published as Record<string, number>)[name]!;
    const hashes6b = (n6bGroups.groupHashes as Record<string, string[]>)[name]!;
    expect(hashes6b).toHaveLength(published6b);
    for (let index = 0; index < published6b; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(hashes6b[index]);
    }
    // 71f9 is the CURRENT published baseline: also immutable history.
    const published71 = (n71f9Groups.published as Record<string, number>)[name]!;
    const hashes71 = (n71f9Groups.groupHashes as Record<string, string[]>)[name]!;
    expect(hashes71).toHaveLength(published71);
    for (let index = 0; index < published71; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(hashes71[index]);
    }
    // cbb is the CURRENT published baseline: also immutable history.
    const publishedCbb = (ncbbGroups.published as Record<string, number>)[name]!;
    const hashesCbb = (ncbbGroups.groupHashes as Record<string, string[]>)[name]!;
    expect(hashesCbb).toHaveLength(publishedCbb);
    for (let index = 0; index < publishedCbb; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(hashesCbb[index]);
    }
    // Only groups appended AFTER the published 0d catalogue are claimed to bind
    // CURRENT disk bytes (consumer 92 / CI 181-182; SDK stays 76, so it has none).
    const publishedDca = (ndcaGroups.published as Record<string, number>)[name]!;
    const hashesDca = (ndcaGroups.groupHashes as Record<string, string[]>)[name]!;
    expect(hashesDca).toHaveLength(publishedDca);
    for (let index = 0; index < publishedDca; index++) {
      expect(hashValue((groups as readonly unknown[])[index])).toBe(hashesDca[index]);
    }
    // DCA is the CURRENT published baseline, so only later groups bind live bytes.
    const appended = groups.slice(Math.max(published0d, published6b, published71, publishedCbb, publishedDca));
    // A family with no new appended tuple (e.g. API/CLI here) proves its entire
    // published catalogue above instead of inventing an append.
    if (!appended.length) continue;
    // Older appended tails are history now; only the CURRENT tail(s) of each
    // family bind today's disk bytes. CI has TWO existing current variants that
    // differ only in the run-head workflow selector, so both current SOURCE
    // closures are tested; the run-head rows themselves stay skipped.
    const current = name === 'ci' ? appended.slice(-2) : appended.slice(-1);
    for (const group of current) {
      for (const row of rows(group)) {
        if ((row as any).ref === 'run-head') continue; // binds the CI run's own bytes
        expect(sha(read((row as any).path))).toBe((row as any).sha256);
      }
      expect(rows(group).length).toBeGreaterThan(0);
    }
  }
});

test('the appended SDK recipe carries the published typed service contracts', () => {
  // This historical case is anchored to the EXPLICIT SDK80/SDK81 indices it was
  // written against: appending the SDK82 failed-transport tail must not silently
  // retarget it. The new SDK82 tail is covered by the source-only SDK82 test.
  const last = sdk[80] as any;
  expect(sdk[79]!.candidateServiceRelationship?.workflowSha256).toBe('76373a179ec6ac63d24c79fc0b759e09f1045087bd66ce46c26214963d12dc5d');
  expect(last.candidateServiceRelationship).toBeDefined();
  expect(last.outerExecutor).toBeDefined();
  // SDK78/SDK79 keep their reviewed published relationship literals; SDK80 moved
  // the candidate workflow and SDK81 binds the final candidate workflow bytes.
  expect((sdk[78] as any).candidateServiceRelationship.workflowSha256).toBe('999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962');
  expect(last.candidateServiceRelationship?.workflowSha256).toBe(sha(read('.github/workflows/candidate.yml')));
  expect(last.candidateServiceRelationship?.workflowPath).toBe('.github/workflows/candidate.yml');
  // The B794 tail deliberately carries CURRENT outer-executor callers, so it must
  // NOT equal the published index-70 literal: primary publish = CURRENT, and the
  // two additional workflows bind their exact on-disk bytes.
  expect(last.outerExecutor.workflowSha256).toBe(sha(read('.github/workflows/publish-qlever-runtime-sdk.yml')));
  for (const caller of last.outerExecutor.additionalWorkflows) expect(caller.sha256).toBe(sha(read(caller.path)));
  // SDK80 differs from the published SDK79 tail ONLY in the reviewed candidate
  // workflow caller: every other outer-executor field is inherited unchanged.
  const previous=(sdk[79] as any).outerExecutor;
  expect({...last.outerExecutor,additionalWorkflows:undefined})
    .toEqual({...previous,additionalWorkflows:undefined});
  expect(last.outerExecutor.additionalWorkflows.map((row:any)=>row.path))
    .toEqual(previous.additionalWorkflows.map((row:any)=>row.path));
  const changed=last.outerExecutor.additionalWorkflows.filter((row:any)=>row.sha256!==previous.additionalWorkflows.find((p:any)=>p.path===row.path).sha256);
  expect(changed.map((row:any)=>row.path)).toEqual(['.github/workflows/candidate.yml']);
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
  expect(current.length).toBe(504);
  expect(new Set(current.map((r) => r.path)).size).toBe(504);
  // The genuinely new roles of this slice: the corrected SDK inner producer and
  // the CI-discovered Ninja regression that now runs under `test_qlever*`.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-inner-materials.py')!.sha256)
    .toBe('16a22fb01e4984f87cc130b4f2e698e75d712e84548ba2a67a54c1c9118d0757');
  expect(current.find((r) => r.path === 'qlever/tests/test_qlever_inner_materials_ninja.py')!.sha256)
    .toBe('474fb14d45835438d222abe89e606fa17e0c68f8fafed7d4e3c869bb7d9d3a7b');
  // The reviewed phase-syscall diagnostic plus its three CI-discovered tests.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-ptrace-execution.py')!.sha256)
    .toBe('e85c370cf26b45d911d90d8fbe99de67242d57620ec5cff6990d3e22f3e76999');
  // The final reviewed VMA diagnostic and its root-corrected behavioural test.
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-generated-vma-originals.py')!.sha256)
    .toBe('b5e1d095d60952005bb7820811234e33e1d03f4b29c595faa4ef3c8eb0d8a22c');
  expect(current.find((r) => r.path === 'qlever/tests/test_qlever_vma_finish_split.py')!.sha256)
    .toBe('d5a9b1c0ab5d0281dcf1d8905561ebb09d2da6487d57ff85d19899a26e804990');
  for (const [p, h] of [
    ['qlever/tests/test_qlever_phase_histogram_optional.py', 'adfeebe0c560b460c27b2e8e732ace9445885ae4d6a6657635ac72c813191792'],
    ['qlever/tests/test_qlever_phase_syscall_diagnostics.py', 'f1313057c7279617335f603aea19a5087dff6be0a99e4352910be76ac7e08f3f'],
    ['qlever/tests/test_qlever_phase_syscall_wiring.py', '8c3827bc18bdf4d5e7bf57318db8c375d5e1fe39fcc61cddf38e0977f0a63a1d'],
  ] as const) expect(current.find((r) => r.path === p)!.sha256).toBe(h);
  for (const row of current) expect(sha(read(row.path))).toBe(row.sha256);
  const body = current.find((r) => r.path === BODY)!;
  expect(body.sha256).toBe('e85c370cf26b45d911d90d8fbe99de67242d57620ec5cff6990d3e22f3e76999');
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-original-chunk-store.py')!.sha256)
    .toBe('67ea1a610f15f74288d623694b1a4886a82b0f29a186c40e69bdd232b39f96db');
});

test('helper tuples retain the e4 published histories and current role bytes', () => {
  const tables = [
    ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT', 'controller', 34],
    ['qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS', 'observer', 52],
    ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_CURRENT', 'fetch', 37],
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
  expect(observer).toHaveLength(52);
});

test('every group still selects itself uniquely and refuses missing/mixed roles', () => {
  for (const [name, groups] of Object.entries(families)) {
    for (const group of groups) {
      // The shared fixture iterates the SAME production planner, so staged
      // recipes receive every role they request while legacy recipes still fill
      // only their own historical mandatory SHA.
      const tuple = completeObserved(groups as any, group as any);
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
  expect(helpers.length).toBe(52);
  const current = sdk.at(-1)!;
  const sec = current.secondarySelectors ?? [];
  expect(sec.length).toBeGreaterThanOrEqual(17);
  // 132 published/earlier rows (incl. the owned-window and refused-caller
  // diagnostics) + the three ORM 0.3.26 SDK build-input rows in this tail
  // (patch series, production-only subdirectory patch, bun.lock).
  expect(current.sourceBindings.length).toBe(154);
  expect(current.sourceBindings.some(r => r.path === 'qlever/tests/test_qlever_owned_window_diagnostic.py')).toBe(true);
  expect(current.sourceBindings.some(r => r.path === 'qlever/tests/test_sdk_refused_caller_diagnostic.py')).toBe(true);
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
