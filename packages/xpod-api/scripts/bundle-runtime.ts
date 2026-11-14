import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const packageRootAdapterVersion = 'api-package-root-v1';
export const apiRuntimeArtifacts = {
  main: { source: 'src/api/main.ts', entry: 'entry.mjs', implementation: 'dist/runtime.mjs' },
  worker: { source: 'src/api/runs/PiAgentRuntimeWorker.ts', entry: 'dist/PiAgentRuntimeWorker.mjs', implementation: 'dist/pi-worker-runtime.mjs' },
} as const;

export const workerAdapterVersion = 'api-pi-worker-v1';
const printer = ts.createPrinter({ removeComments: true });
const shape = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file);

export function adaptPiWorkerDriver(source: string) {
  const file = ts.createSourceFile('driver.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = file.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === 'PiAgentRuntimeDriver');
  const methods = classes.flatMap(node => node.members.filter(ts.isMethodDeclaration)
    .filter(method => ts.isIdentifier(method.name) && method.name.text === 'resolveWorkerPath'));
  const expected = ts.createSourceFile('expected.ts', 'class Driver { resolveWorkerPath() { if (this.options.workerPath) { return this.options.workerPath; } return path.join(__dirname, `PiAgentRuntimeWorker${path.extname(__filename)}`); } }', ts.ScriptTarget.Latest, true);
  const expectedMethod = (expected.statements[0] as ts.ClassDeclaration).members[0] as ts.MethodDeclaration;
  if (methods.length !== 1 || !methods[0].body || shape(methods[0].body, file) !== shape(expectedMethod.body!, expected)) {
    throw new Error('API worker default path contract changed');
  }
  const statement = methods[0].body.statements[1];
  if (!ts.isReturnStatement(statement) || !statement.expression) throw new Error('API worker default return missing');
  const expression = statement.expression;
  return { contents: source.slice(0, expression.getStart(file))
    + `path.join(PACKAGE_ROOT, ${JSON.stringify(apiRuntimeArtifacts.worker.entry)})` + source.slice(expression.end),
  sourceSHA256: createHash('sha256').update(source).digest('hex'), adapterVersion: workerAdapterVersion };
}

export function adaptPiWorkerEntry(source: string) {
  const file = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expected = ts.createSourceFile('expected.ts', 'if (require.main === module) {}', ts.ScriptTarget.Latest, true);
  const condition = (expected.statements[0] as ts.IfStatement).expression;
  const guards = file.statements.filter(ts.isIfStatement).filter(node => shape(node.expression, file) === shape(condition, expected));
  if (guards.length !== 1 || guards[0].elseStatement || !ts.isBlock(guards[0].thenStatement)) throw new Error('API worker main guard contract changed');
  const statements = guards[0].thenStatement.statements;
  const call = statements.length === 1 && ts.isExpressionStatement(statements[0]) ? statements[0].expression : undefined;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)
    || call.expression.name.text !== 'catch' || !ts.isCallExpression(call.expression.expression)
    || !ts.isIdentifier(call.expression.expression.expression) || call.expression.expression.expression.text !== 'main'
    || call.expression.expression.arguments.length !== 0 || call.arguments.length !== 1) throw new Error('API worker error handler contract changed');
  for (const alias of ['__apiWorkerPath', '__apiWorkerRoot', '__apiWorkerFs']) if (source.includes(alias)) throw new Error('API worker alias collision');
  const guard = guards[0].expression;
  const imports = "import * as __apiWorkerPath from 'node:path';\nimport * as __apiWorkerFs from 'node:fs';\nimport { PACKAGE_ROOT as __apiWorkerRoot } from '../../runtime/package-root';\n";
  return { contents: imports + source.slice(0, guard.getStart(file))
    + `Boolean(process.argv[1]) && __apiWorkerFs.existsSync(process.argv[1]) && __apiWorkerFs.realpathSync(process.argv[1]) === __apiWorkerFs.realpathSync(__apiWorkerPath.join(__apiWorkerRoot, ${JSON.stringify(apiRuntimeArtifacts.worker.entry)}))`
    + source.slice(guard.end), sourceSHA256: createHash('sha256').update(source).digest('hex'), adapterVersion: workerAdapterVersion };
}

export function piWorkerBundlePlugin(repoRoot: string, record: (receipt: { source: string; sourceSHA256: string; adapterVersion: string }) => void) {
  const adapters = new Map([
    [realpathSync(path.join(repoRoot, 'src/api/runs/PiAgentRuntimeDriver.ts')), { source: 'src/api/runs/PiAgentRuntimeDriver.ts', adapt: adaptPiWorkerDriver }],
    [realpathSync(path.join(repoRoot, apiRuntimeArtifacts.worker.source)), { source: apiRuntimeArtifacts.worker.source, adapt: adaptPiWorkerEntry }],
  ]);
  return { name: workerAdapterVersion, setup(build: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void }) {
    build.onLoad({ filter: /[/\\]PiAgentRuntime(?:Driver|Worker)\.ts$/ }, args => {
      const adapter = adapters.get(realpathSync(args.path));
      if (!adapter) return undefined;
      const result = adapter.adapt(readFileSync(args.path, 'utf8'));
      record({ source: adapter.source, sourceSHA256: result.sourceSHA256, adapterVersion: result.adapterVersion });
      return { contents: result.contents, loader: 'ts' as const };
    });
  } };
}

export function esmRuntimeEntry(implementation: string, entry = implementation): string {
  return "import { createRequire } from 'node:module';\nglobalThis.require = createRequire(import.meta.url);\nawait import(" + JSON.stringify('./' + path.posix.relative(path.posix.dirname(entry), implementation)) + ');\n';
}

/** Adapt only the canonical initializer; the shared CommonJS source stays intact. */
export function adaptPackageRoot(source: string): { contents: string; sourceSHA256: string; adapterVersion: string } {
  const file = ts.createSourceFile('package-root.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = file.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'PACKAGE_ROOT') : []);
  if (declarations.length !== 1) throw new Error('API package-root adapter requires exactly one PACKAGE_ROOT declaration');
  const initializer = declarations[0].initializer;
  if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)
    || initializer.expression.text !== 'findPackageRoot' || initializer.arguments.length !== 1
    || !ts.isIdentifier(initializer.arguments[0]) || initializer.arguments[0].text !== '__dirname') {
    throw new Error('API package-root initializer contract changed');
  }
  for (const name of ['__apiBundleDirname', '__apiBundleFileURLToPath']) {
    if (source.includes(name)) throw new Error('API package-root adapter alias collision');
  }
  const imports = "import { dirname as __apiBundleDirname } from 'node:path';\nimport { fileURLToPath as __apiBundleFileURLToPath } from 'node:url';\n";
  return {
    contents: imports + source.slice(0, initializer.getStart(file))
      + 'findPackageRoot(__apiBundleDirname(__apiBundleFileURLToPath(import.meta.url)))' + source.slice(initializer.end),
    sourceSHA256: createHash('sha256').update(source).digest('hex'),
    adapterVersion: packageRootAdapterVersion,
  };
}

export function packageRootBundlePlugin(repoRoot: string, record: (receipt: { source: string; sourceSHA256: string; adapterVersion: string }) => void) {
  const canonical = realpathSync(path.join(repoRoot, 'src/runtime/package-root.ts'));
  return {
    name: packageRootAdapterVersion,
    setup(build: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void }) {
      build.onLoad({ filter: /[/\\]package-root\.ts$/ }, args => {
        if (realpathSync(args.path) !== canonical) return undefined;
        const adapted = adaptPackageRoot(readFileSync(canonical, 'utf8'));
        record({ source: 'src/runtime/package-root.ts', sourceSHA256: adapted.sourceSHA256, adapterVersion: adapted.adapterVersion });
        return { contents: adapted.contents, loader: 'ts' as const };
      });
    },
  };
}

export const observableStoreAdapterVersion = 'api-observable-store-v1';
export const observableStoreSource = 'src/storage/ObservableResourceStore.ts';

/** Keep Components.js declarations unchanged; narrow only the API bundle value import. */
export function adaptObservableStore(source: string) {
  const file = ts.createSourceFile('ObservableResourceStore.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values = file.statements.filter(ts.isImportDeclaration).filter(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@solid/community-server'
    && !node.importClause?.isTypeOnly);
  const clause = values[0]?.importClause;
  const bindings = clause?.namedBindings;
  if (values.length !== 1 || clause?.name || !bindings || !ts.isNamedImports(bindings)
    || bindings.elements.length !== 1 || bindings.elements[0].isTypeOnly
    || bindings.elements[0].propertyName || bindings.elements[0].name.text !== 'PassthroughStore') {
    throw new Error('API ObservableResourceStore value import contract changed');
  }
  const classes = file.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === 'ObservableResourceStore');
  const parents = classes.flatMap(node => node.heritageClauses?.filter(c => c.token === ts.SyntaxKind.ExtendsKeyword).flatMap(c => c.types) ?? []);
  if (classes.length !== 1 || parents.length !== 1 || !ts.isIdentifier(parents[0].expression)
    || parents[0].expression.text !== 'PassthroughStore') throw new Error('API ObservableResourceStore superclass contract changed');
  const specifier = values[0].moduleSpecifier;
  return { contents: source.slice(0, specifier.getStart(file))
    + JSON.stringify('@solid/community-server/dist/storage/PassthroughStore') + source.slice(specifier.end),
    sourceSHA256: createHash('sha256').update(source).digest('hex'), adapterVersion: observableStoreAdapterVersion };
}

export function observableStoreBundlePlugin(repoRoot: string, record: (receipt: { source: string; sourceSHA256: string; adapterVersion: string }) => void) {
  const canonical = realpathSync(path.join(repoRoot, observableStoreSource));
  return { name: observableStoreAdapterVersion, setup(build: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void }) {
    build.onLoad({ filter: /[/\\]ObservableResourceStore\.ts$/ }, args => {
      if (realpathSync(args.path) !== canonical) return undefined;
      const adapted = adaptObservableStore(readFileSync(canonical, 'utf8'));
      record({ source: observableStoreSource, sourceSHA256: adapted.sourceSHA256, adapterVersion: adapted.adapterVersion });
      return { contents: adapted.contents, loader: 'ts' as const };
    });
  } };
}
