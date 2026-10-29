/** Fetch/controller helper admission: partial-plan union then exact whole-group match.
 *
 * Real defects this guards, each reproduced before the fix:
 *  (b) a DISJOINT group that omits a known required role was accepted as viable;
 *  (c) a valid fully-known historical tuple was rejected instead of planning [];
 *  plus ambiguity resolved only after the additional hashes are actually read.
 *
 * The fixtures below are synthetic on purpose: they must express shapes the real
 * catalogue does not currently contain, so the predicate itself is exercised.
 * A separate case pins the REAL 30/33 published tuple values byte-exact.
 */
import {test, expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
import {
  selectSdkControllerHelperGroup,
  requiredSdkControllerHelperGroup,
  requiredSdkControllerHelperNames,
} from '../../scripts/lib/independent-admission/sdk-controller-helper-groups';

const ROOT = path.resolve(import.meta.dir, '../..');
const LIB = path.join(ROOT, 'scripts/lib/independent-admission');

/** AST-evaluate a module-local const, the same reader the slice tests use. */
function localConst(file: string, name: string): any {
  const p = path.join(LIB, file);
  const src = readFileSync(p, 'utf8');
  const ast = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cm = new Map<string, any>();
  for (const st of ast.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) cm.set(d.name.text, d.initializer);
    }
  }
  const need = new Set([name]);
  const visit = (x: any) => {
    if (ts.isIdentifier(x)
        && !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)
        && !(ts.isPropertyAssignment(x.parent) && x.parent.name === x)) {
      const init = cm.get(x.text);
      if (init && !need.has(x.text)) { need.add(x.text); visit(init); }
    }
    ts.forEachChild(x, visit);
  };
  visit(cm.get(name));
  const chunks = ast.statements
    .filter(st => ts.isVariableStatement(st)
      && st.declarationList.declarations.some(d => ts.isIdentifier(d.name) && need.has(d.name.text)))
    .map(st => st.getText(ast));
  const scope: any = {};
  runInNewContext(ts.transpileModule(`${chunks.join('\n')}\nresult=${name};`, {
    compilerOptions: {target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None},
  }).outputText, scope, {timeout: 5000});
  return scope.result;
}

const tuple = (pairs: readonly (readonly [string, string])[]) => Object.freeze(pairs.map(p => Object.freeze([...p] as [string, string])));
const obs = (pairs: readonly (readonly [string, string])[]): Map<string, string> =>
  new Map(pairs.map(p => [p[0], p[1]] as [string, string]));

test('REAL published controller30 and fetch33 tuple VALUES are byte-exact', () => {
  const controller = localConst('qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT');
  const fetch = localConst('qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_NEXT');
  expect(controller.length).toBe(30);
  expect(fetch.length).toBe(33);
  // the published tail tuples must still carry the HISTORICAL wait digest
  const hist = 'd552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325';
  const waitIn = (groups: any[]) => groups.some(g => {
    const rows = Array.isArray(g) ? g : Object.entries(g);
    return rows.some((r: any) => (Array.isArray(r) ? r : [r[0], r[1]])[1] === hist);
  });
  expect(waitIn(controller)).toBe(true);
  expect(waitIn(fetch)).toBe(true);
});

test('appended CURRENT catalogues add exactly one fresh tail tuple', () => {
  // TWO genuine appends have landed on the published NEXT history: the SDK70
  // inner-materials correction and the final reviewed VMA diagnostic (whose
  // generated-VMA bytes are members of controller/fetch CURRENT). The historical
  // NEXT catalogues stay at 30/33 and are never rewritten to force a +1.
  const c = localConst('qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT');
  const f = localConst('qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_CURRENT');
  expect(c.length).toBe(37);
  expect(f.length).toBe(40);
  const cur = '778fdaad5802df943c8e7e96e4de79a32845508947c9ae436e742248b2e7aa1a';
  const waitDigests = (groups: any[]) => groups.map(g => {
    const rows = Array.isArray(g) ? g : Object.entries(g);
    const hit = rows.find((r: any) => (Array.isArray(r) ? r[0] : r[0]) === 'sdk-coordinated-wait.py');
    return hit ? (Array.isArray(hit) ? hit[1] : hit[1]) : null;
  }).filter(Boolean);
  expect(waitDigests(c)).toContain(cur);
  expect(waitDigests(f)).toContain(cur);
});

test('(b) a DISJOINT group missing a known required role is NOT viable', () => {
  const S1 = 'a'.repeat(64), S2 = 'b'.repeat(64), SX = 'c'.repeat(64);
  const disjoint = tuple([['a.py', S1], ['x.py', SX]]);
  expect(() => requiredSdkControllerHelperNames([disjoint] as any, ['a.py', 'b.py'], obs([['a.py', S1], ['b.py', S2]])))
    .toThrow(/helper group differs/u);
});

test('(c) a valid fully-known historical tuple plans [] and still selects exactly', () => {
  const S1 = 'a'.repeat(64), S2 = 'b'.repeat(64);
  const complete = tuple([['a.py', S1], ['b.py', S2]]);
  const plan = requiredSdkControllerHelperNames([complete] as any, ['a.py', 'b.py'], obs([['a.py', S1], ['b.py', S2]]));
  expect(plan).toEqual([]);
  expect(selectSdkControllerHelperGroup([complete] as any, obs([['a.py', S1], ['b.py', S2]]) as any)).toBe(complete as any);
});

test('ambiguous partial candidates resolve only after the additional hashes are read', () => {
  const S1 = 'a'.repeat(64), OLD = 'd'.repeat(64), NEW = 'e'.repeat(64), X = 'f'.repeat(64);
  const stale = tuple([['a.py', S1], ['wait.py', OLD]]);
  const fresh = tuple([['a.py', S1], ['wait.py', NEW]]);
  const plan = requiredSdkControllerHelperNames([stale, fresh] as any, ['a.py'], obs([['a.py', S1]]));
  expect([...plan]).toEqual(['wait.py']);
  const resolved = obs([['a.py', S1], ['wait.py', NEW]]);
  expect(selectSdkControllerHelperGroup([stale, fresh] as any, resolved as any)).toBe(fresh as any);
  const wrong = obs([['a.py', S1], ['wait.py', X]]);
  expect(() => selectSdkControllerHelperGroup([stale, fresh] as any, wrong as any)).toThrow(/helper group differs/u);
});

test('union of additional names across several viable candidates', () => {
  const S1 = 'a'.repeat(64);
  const g1 = tuple([['a.py', S1], ['p.py', '1'.repeat(64)]]);
  const g2 = tuple([['a.py', S1], ['q.py', '2'.repeat(64)]]);
  const plan = requiredSdkControllerHelperNames([g1, g2] as any, ['a.py'], obs([['a.py', S1]]));
  expect([...plan].sort()).toEqual(['p.py', 'q.py']);
});

test('the strict required selector still demands a unique partial match', () => {
  const S1 = 'a'.repeat(64);
  const g1 = tuple([['a.py', S1], ['p.py', '1'.repeat(64)]]);
  const g2 = tuple([['a.py', S1], ['q.py', '2'.repeat(64)]]);
  expect(() => requiredSdkControllerHelperGroup([g1, g2] as any, ['a.py'], obs([['a.py', S1]])))
    .toThrow(/helper group differs/u);
});

test('malformed, duplicate, size-mismatch and over-bound inputs are refused', () => {
  const S1 = 'a'.repeat(64);
  const duplicated = tuple([['a.py', S1], ['a.py', S1]]);
  expect(() => requiredSdkControllerHelperNames([duplicated] as any, ['a.py'], obs([['a.py', S1]])))
    .toThrow(/helper group differs/u);
  expect(() => requiredSdkControllerHelperNames([tuple([['a.py', S1]])] as any, ['a.py'], new Map() as any))
    .toThrow(/helper group differs/u);
  expect(() => requiredSdkControllerHelperNames([tuple([['a.py', S1]])] as any, ['a.py', 'b.py'], obs([['a.py', S1]])))
    .toThrow(/helper group differs/u);
  const over = tuple(Array.from({length: 33}, (_, i) => [`r${i}.py`, '0'.repeat(64)] as [string, string]));
  expect(() => requiredSdkControllerHelperNames([over] as any, ['r0.py'], obs([['r0.py', '0'.repeat(64)]])))
    .toThrow(/helper group differs/u);
});

test('a conflicting final set is refused by the exact selector', () => {
  const S1 = 'a'.repeat(64), S2 = 'b'.repeat(64);
  const g = tuple([['a.py', S1], ['b.py', S2]]);
  expect(() => selectSdkControllerHelperGroup([g] as any, obs([['a.py', S1], ['b.py', 'c'.repeat(64)]]) as any))
    .toThrow(/helper group differs/u);
});

/** Derive the REAL production call sites from the module source, so this test
 * cannot pass by hardcoding a catalog the production code does not use.
 *
 * It extracts, for each module, the first argument of the actual
 * `requiredSdkControllerHelperNames(...)` call and of the actual
 * `selectSdkControllerHelperGroup(...)` call, evaluates those identifiers through
 * the same AST reader, then binds and invokes the real pure functions. If the
 * production caller still used `_NEXT` (or a strict partial selector), the derived
 * catalog would be wrong and this would fail. */
function productionCallCatalog(file: string, callee: string): {arg: string; catalog: any} {
  const p = path.join(LIB, file);
  const src = readFileSync(p, 'utf8');
  const ast = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: string | undefined;
  const visit = (node: any) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee
        && node.arguments.length >= 1 && ts.isIdentifier(node.arguments[0])) {
      // last call wins only if repeated; these appear once per module
      found = (node.arguments[0] as any).text;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error(`production call to ${callee} not found in ${file}`);
  return {arg: found, catalog: localConst(file, found)};
}

test('the PRODUCTION controller caller uses the name plan over CURRENT37', () => {
  const plan = productionCallCatalog('qlever-sdk-generation.ts', 'requiredSdkControllerHelperNames');
  expect(plan.arg).toBe('REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT');
  expect(plan.catalog.length).toBe(37);
  const exact = productionCallCatalog('qlever-sdk-generation.ts', 'selectSdkControllerHelperGroup');
  expect(exact.arg).toBe('REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT');
  const src = readFileSync(path.join(LIB, 'qlever-sdk-generation.ts'), 'utf8');
  // the loop must bind a STRING, because the plan returns names
  expect(src).toContain('for(const name of requiredSdkControllerHelperNames(');
});

test('the PRODUCTION fetch caller uses the name plan over CURRENT40', () => {
  const plan = productionCallCatalog('qlever-sdk-fetchcontent.ts', 'requiredSdkControllerHelperNames');
  expect(plan.arg).toBe('REVIEWED_HELPER_GROUPS_CURRENT');
  expect(plan.catalog.length).toBe(40);
  const exact = productionCallCatalog('qlever-sdk-fetchcontent.ts', 'selectSdkControllerHelperGroup');
  expect(exact.arg).toBe('REVIEWED_HELPER_GROUPS_CURRENT');
});

test('the declared VERSION bound is exactly 40, enforced as a count not as ambiguity', () => {
  // 40 declared groups is the genuine maximum (fetch CURRENT after the PR124
  // strict absent-link append). Exactly ONE of them matches the observed roles/digests.
  const base: readonly (readonly [string, string])[] = [
    ['a.py', 'a'.repeat(64)], ['b.py', 'b'.repeat(64)],
  ];
  const distinctGroup = (i: number): readonly (readonly [string, string])[] => [
    ['a.py', 'a'.repeat(64)],
    ['b.py', createHash('sha256').update(`variant-${i}`).digest('hex')],
  ];
  const observed = new Map(base);
  const atLimit = [base, ...Array.from({length: 39}, (_, i) => distinctGroup(i))];
  expect(atLimit).toHaveLength(40);
  // exactly one full match => the at-limit catalogue is accepted
  expect(selectSdkControllerHelperGroup(atLimit, observed)).toBe(base);
  // 41 declared groups, still only ONE full match: the COUNT bound alone refuses,
  // proving the refusal is not merely an ambiguity/uniqueness result
  const overLimit = [...atLimit, distinctGroup(999)];
  expect(overLimit).toHaveLength(41);
  expect(() => selectSdkControllerHelperGroup(overLimit, observed)).toThrow('SDK controller complete helper group differs');
  expect(() => requiredSdkControllerHelperGroup(overLimit, ['a.py', 'b.py'], observed)).toThrow('SDK controller complete helper group differs');
  // the observed PER-TUPLE role bound stays 32 and is still enforced
  const wide = Array.from({length: 33}, (_, i) => [`role-${i}.py`, 'c'.repeat(64)] as const);
  const wideObserved = new Map(wide);
  expect(() => selectSdkControllerHelperGroup([wide], wideObserved)).toThrow('SDK controller complete helper group differs');
});

test('the REAL production-called catalogs admit end to end on actual helper bytes', () => {
  const sha = (n: string) => createHash('sha256').update(readFileSync(path.join(ROOT, 'qlever/scripts', n))).digest('hex');
  const cases: readonly [string, readonly string[], number][] = [
    ['qlever-sdk-generation.ts', ['sdk-zip-originals.py', 'sdk-generation-multiprocess-bindings.py', 'sdk-execution-originals-util.py', 'sdk-generated-source-originals.py', 'sdk-tool-provider-originals.py', 'sdk-generated-vma-originals.py', 'sdk-coordinated-wait.py', 'sdk-original-chunk-store.py', 'sdk-raw-wire-reader.py', 'sdk-executable-memory-policy.py'], 37],
    ['qlever-sdk-fetchcontent.ts', ['sdk-fetchcontent-source-observer.py', 'sdk-fetchcontent-source-bindings.py', 'sdk-zip-originals.py', 'sdk-git-source-bindings.py', 'sdk-debian-binary-originals.py', 'sdk-debian-index-bindings.py', 'sdk-generation-multiprocess-bindings.py', 'sdk-execution-originals-util.py', 'sdk-tool-provider-originals.py', 'sdk-generated-vma-originals.py', 'sdk-coordinated-wait.py', 'sdk-original-chunk-store.py', 'sdk-raw-wire-reader.py', 'sdk-executable-memory-policy.py'], 40],
  ];
  for (const [file, names, expectedGroups] of cases) {
    // bind the catalogs the PRODUCTION CALL SITES actually pass
    const planSite = productionCallCatalog(file, 'requiredSdkControllerHelperNames');
    const exactSite = productionCallCatalog(file, 'selectSdkControllerHelperGroup');
    expect(exactSite.arg).toBe(planSite.arg);
    expect(planSite.catalog.length).toBe(expectedGroups);
    const observed = new Map<string, string>(names.map(n => [n, sha(n)] as [string, string]));
    const plan = requiredSdkControllerHelperNames(planSite.catalog, names, observed as any);
    for (const extra of plan) observed.set(extra, sha(extra));
    expect(selectSdkControllerHelperGroup(exactSite.catalog, observed as any))
      .toBe(exactSite.catalog[exactSite.catalog.length - 1]);
  }
});
