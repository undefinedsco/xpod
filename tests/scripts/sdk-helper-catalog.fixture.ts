/** Bounded PURE decoder for the SDK helper/observer catalog declarations.
 *
 * These modules keep their catalogues in module-local consts, and the CURRENT
 * catalogues are thin wrappers such as
 *   REVIEWED_OBSERVER_GROUPS = Object.freeze([...PRE_NATIVE_SWEEP_REVIEWED_OBSERVER_GROUPS, ...])
 * so evaluating one name by itself is not enough: its initializer references other
 * declarations. This decoder collects the requested names PLUS their transitive
 * local-const dependencies, transpiles ONLY those statements, and evaluates them in
 * a bare VM context.
 *
 * It is deliberately data-only: no production module is imported, no capability or
 * authority is evaluated, and the output is plain arrays/objects. Decoding is
 * bounded both by the number of collected statements and by a short VM timeout, so a
 * pathological input cannot hang a test.
 */
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

/** Match the catalogue-shaped declarations the SDK history tests assert over. */
const CATALOG = /^(HELPERS|LOCAL_HELPERS|REVIEWED_.*|PRE_.*|LIFETIME_HELPER_GROUP)$/;

/** Identifiers referenced by an initializer that look like catalogue-ish locals. */
function referenced(init: ts.Node): readonly string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      names.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(init);
  return Object.freeze([...new Set(names)]);
}

/** Evaluate `name` (plus its local catalogue dependencies) from one module file. */
export function decodeCatalog(file: string, name: string, timeoutMs = 1000): unknown {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) {
    throw new Error('catalogue VM timeout outside bound');
  }
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const stmt of ast.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) declarations.set(d.name.text, d);
    }
  }
  if (!declarations.has(name)) throw new Error('catalogue declaration missing: ' + name);

  // transitive closure over local catalogue-shaped const references
  const keep = new Set<string>([name]);
  const queue = [name];
  while (queue.length) {
    const current = queue.pop()!;
    const declaration = declarations.get(current);
    if (!declaration?.initializer) continue;
    for (const reference of referenced(declaration.initializer)) {
      if (keep.has(reference) || !CATALOG.test(reference)) continue;
      if (!declarations.has(reference)) continue;
      keep.add(reference);
      queue.push(reference);
    }
    if (keep.size > 512) throw new Error('catalogue dependency bound exceeded');
  }

  const chunks: string[] = [];
  for (const stmt of ast.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && keep.has(d.name.text)) chunks.push('const ' + d.getText(ast) + ';');
    }
  }
  const transpiled = ts.transpileModule(`${chunks.join('\n')}\nresult=${name};`, {
    compilerOptions: {target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None},
  }).outputText;
  const scope: {result?: unknown} = {};
  runInNewContext(transpiled, scope, {timeout: timeoutMs});
  return scope.result;
}
