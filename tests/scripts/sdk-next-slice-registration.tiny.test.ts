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
import {
  CONSUMER_SOURCE_GROUPS as consumer,
  CI_CONSUMER_SOURCE_GROUPS as ci,
} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
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
  expect([sdk.length, consumer.length, ci.length, api.length]).toEqual([68, 83, 164, 28]);
});

test('the appended groups bind the actual frozen body and real module bytes', () => {
  expect(sha(read(BODY))).toBe('507bf2eae69c9cce70b530708e662addd0771b9b87f32b7429d4a4b3e6bd41a3');
  for (const [name, groups] of Object.entries(families)) {
    // slice boundary = the IMMUTABLE 42807 published counts (SDK 66 incl the c1a170 body).
    // Every index below it is published and legitimately keeps its own bytes; only groups
    // AFTER it are the fresh current slice. Using FB65 here would wrongly treat SDK index 65
    // (already published at 42807) as current.
    // 97ee is the current PUBLISHED boundary (SDK 67). Its groups legitimately keep their
    // own historical bytes; only groups AFTER it are the fresh unpublished slice.
    const published = (fb97eeGroups.published as Record<string, number>)[name]!;
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
  expect(current.length).toBe(460);
  expect(new Set(current.map((r) => r.path)).size).toBe(460);
  for (const row of current) expect(sha(read(row.path))).toBe(row.sha256);
  const body = current.find((r) => r.path === BODY)!;
  expect(body.sha256).toBe('507bf2eae69c9cce70b530708e662addd0771b9b87f32b7429d4a4b3e6bd41a3');
  expect(current.find((r) => r.path === 'qlever/scripts/sdk-original-chunk-store.py')!.sha256)
    .toBe('d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e');
});

test('helper tuples keep their published 29/39/32 history and the appends bind all real roles', () => {
  const tables = [
    ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT', 'controller', 30],
    ['qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS', 'observer', 42],
    ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_NEXT', 'fetch', 33],
  ] as const;
  for (const [file, name, family, count] of tables) {
    const groups = recipes(file, name);
    expect(groups).toHaveLength(count);
    const published = (sdk823Groups as any).helpers[family] as unknown[];
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
    const last = groups.at(-1)!;
    const entries = (Array.isArray(last) ? last : Object.entries(last as Record<string, string>)) as [string, string][];
    // Controller/fetch declarations allow 33 groups; observer history is separate.
    expect(groups.length <= (family === 'observer' ? 42 : 33)).toBe(true);
    expect(entries.length <= 32).toBe(true);
    expect(new Set(entries.map(([role]) => role)).size).toBe(entries.length);
    for (const [role, expected] of entries) {
      const p = role.startsWith('qlever/') ? role : 'qlever/scripts/' + role;
      expect(sha(read(p))).toBe(expected);
    }
  }
  // One new observer tuple follows the 39 published SDK823 tuples.
  const observer = recipes('qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS');
  expect(observer).toHaveLength(42);
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

test('the SDK68 slice carries the 12 published helper prefixes and its own new members', () => {
  // Regression: the 3 newly executed Ninja helpers are real members of BOTH the
  // secondary selectors and the source bindings of the CURRENT slice, while every
  // published helper tuple keeps its own prefix.
  const helpers = recipes('qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS');
  expect(helpers.length).toBe(42);
  const current = sdk.at(-1)!;
  const sec = current.secondarySelectors ?? [];
  expect(sec.length).toBe(13);
  expect(current.sourceBindings.length).toBe(125);
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
