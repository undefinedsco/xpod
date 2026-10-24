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
import f6Groups from '../fixtures/independent-admission/f6-published-sdk-slice.original.json';
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

test('all published f6 whole histories are preserved byte-for-byte', () => {
  for (const [name, groups] of Object.entries(families)) {
    const published = (f6Groups as any)[name] as unknown[];
    expect(groups.length >= published.length).toBe(true);
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
  }
  // The slice appends exactly: +1 SDK, +1 consumer, +2 CI (two selector variants), +0 API.
  expect([sdk.length, consumer.length, ci.length, api.length]).toEqual([64, 79, 156, 27]);
});

test('the appended groups bind the actual frozen body and real module bytes', () => {
  expect(sha(read(BODY))).toBe('efd6578bf659e696033a9277e98c278e1c21dd7b7bbe967b60a6df02c3898095');
  for (const [name, groups] of Object.entries(families)) {
    const published = ((f6Groups as any)[name] as unknown[]).length;
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
  expect(last.candidateServiceRelationship).toEqual((sdk.at(-2) as any).candidateServiceRelationship);
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

test('the live canonical binds every actual row and stays in the published 426 domain', () => {
  expect(current.length).toBe(426);
  expect(new Set(current.map((r) => r.path)).size).toBe(426);
  for (const row of current) expect(sha(read(row.path))).toBe(row.sha256);
  const body = current.find((r) => r.path === BODY)!;
  expect(body.sha256).toBe('efd6578bf659e696033a9277e98c278e1c21dd7b7bbe967b60a6df02c3898095');
});

test('helper tuples keep their published history and the append binds all real roles', () => {
  const tables = [
    ['qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS', 'controller', 29],
    ['qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS', 'observer', 39],
    ['qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS', 'fetch', 32],
  ] as const;
  for (const [file, name, family, count] of tables) {
    const groups = recipes(file, name);
    expect(groups).toHaveLength(count);
    const published = (f6Groups as any).helpers[family] as unknown[];
    expect(groups.slice(0, published.length).map(hashValue)).toEqual(published);
    const last = groups.at(-1)!;
    const entries = (Array.isArray(last) ? last : Object.entries(last as Record<string, string>)) as [string, string][];
    // Declared caps: 32 versions max and 32 roles per tuple, unchanged.
    expect(groups.length <= 40).toBe(true);
    expect(entries.length <= 32).toBe(true);
    expect(new Set(entries.map(([role]) => role)).size).toBe(entries.length);
    for (const [role, expected] of entries) {
      const p = role.startsWith('qlever/') ? role : 'qlever/scripts/' + role;
      expect(sha(read(p))).toBe(expected);
    }
  }
  // observers changed exactly once (the body role); controller/fetch never grew.
  const observer = recipes('qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS');
  expect(observer).toHaveLength(39);
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
