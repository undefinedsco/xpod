import { buildWithBun } from './bun-build-api';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { resolvePhysicalRuntimeImport, type PhysicalRuntimeImport } from '../../../scripts/lib/physical-module-stage';
import { nodeBuiltinAuthority, verifyNodeBuiltinAuthority, type NodeBuiltinAuthority } from './node-builtins';
import { observableStoreAdapterVersion, observableStoreSource, observableStoreBundlePlugin, apiRuntimeArtifacts, esmRuntimeEntry, packageRootAdapterVersion, workerAdapterVersion, packageRootBundlePlugin, piWorkerBundlePlugin } from './bundle-runtime';

export interface BundleFile { path: string; sha256: string; bytes: number }
export interface AdapterReceipt { source: string; sourceSHA256: string; adapterVersion: string }
export interface ApiBundleProduct {
  role: keyof typeof apiRuntimeArtifacts;
  implementation: BundleFile;
  entry: BundleFile;
  metadata: BundleFile;
  rawMetadata: BundleFile;
  buildCwdRelativeToRepo: string;
  metadataNormalizationVersion: 'api-metafile-repo-v1';
  inputs: BundleFile[];
  adapters: AdapterReceipt[];
  externals: string[];
  runtimeImports: PhysicalRuntimeImport[];
  dynamicLoads: string[];
}
export interface ApiBundleReceipt { schemaVersion: 1; products: ApiBundleProduct[]; nodeBuiltins: NodeBuiltinAuthority; runtimePackageManifest: BundleFile }
export interface ApiMetafile {
  inputs: Record<string, { bytes?: number; imports?: Array<{ path: string; external?: boolean }> }>;
  outputs: Record<string, { inputs?: Record<string, unknown>; entryPoint?: string; imports?: Array<{ path: string; external?: boolean }> }>;
}
export function normalizeApiMetafile(repoRoot: string, buildCwd: string, metadata: ApiMetafile): ApiMetafile {
  const canonical = new Map<string, string>();
  for (const filename of Object.keys(metadata.inputs)) {
    const absolute = path.resolve(buildCwd, filename);
    const relative = path.relative(realpathSync(repoRoot), realpathSync(absolute)).replaceAll('\\', '/');
    if (!safeBundlePath(relative) || [...canonical.values()].includes(relative)) throw new Error('API metafile input escaped or duplicated source authority');
    canonical.set(filename, relative);
  }
  const imports = (edges: Array<{ path: string; external?: boolean }> | undefined) => edges?.map(edge => ({ ...edge, path: !edge.external && canonical.has(edge.path) ? canonical.get(edge.path)! : edge.path }));
  return { ...metadata,
    inputs: Object.fromEntries(Object.entries(metadata.inputs).map(([filename, node]) => [canonical.get(filename)!, { ...node, imports: imports(node.imports) }])),
    outputs: Object.fromEntries(Object.entries(metadata.outputs).map(([filename, node]) => [filename, { ...node,
      ...(node.inputs ? { inputs: Object.fromEntries(Object.entries(node.inputs).map(([input, fact]) => {
        if (!canonical.has(input)) throw new Error('API output references an unknown source input');
        return [canonical.get(input)!, fact];
      })) } : {}), ...(node.entryPoint ? { entryPoint: canonical.get(node.entryPoint) ?? (() => { throw new Error('API output entry is not an actual input'); })() } : {}), imports: imports(node.imports) }])) };
}
// Program dependency declarations, resolved through each real importing owner.
export const apiRuntimeImportDeclarations: ReadonlyArray<{ specifier: string; from?: string; externalize: boolean }> = [
  { from: 'node_modules/inngest/helpers/env.js', specifier: 'cross-fetch', externalize: false },
  { specifier: '@electric-sql/pglite', externalize: true },
  { specifier: '@comunica/query-sparql-solid', externalize: true },
  // These prototype patches must target the very same modules used by the external engine.
  { specifier: '@comunica/actor-query-result-serialize-sparql-json', externalize: true },
  { specifier: '@comunica/actor-query-result-serialize-stats', externalize: true },
  { specifier: 'awilix', externalize: true },
  { specifier: '@ai-sdk/provider-utils', externalize: true },
];

export function runtimeImportBindings(repoRoot: string, metadata: ApiMetafile, externals: string[]): PhysicalRuntimeImport[] {
  const matches = (specifier: string, packageName: string) => specifier === packageName || specifier.startsWith(packageName + '/');
  return apiRuntimeImportDeclarations.flatMap(item => {
    const emitted = new Set(externals.filter(specifier => matches(specifier, item.specifier)));
    if (!emitted.size) return [];
    const candidates = item.from ? [item.from] : Object.keys(metadata.inputs).filter(file => metadata.inputs[file].imports?.some(edge => edge.external && emitted.has(edge.path)));
    const observed = candidates.filter(file => {
      if (!metadata.inputs[file]) throw new Error('API runtime external owner missing from actual metadata');
      return apiModuleLoads(readFileSync(path.join(repoRoot, file), 'utf8')).externals.some(specifier => emitted.has(specifier));
    });
    if (!observed.length) throw new Error('API runtime external source load contract changed');
    return observed.map(file => resolvePhysicalRuntimeImport(repoRoot, file, item.specifier).binding);
  });
}
function apiModuleLoads(emitted: string): { externals: string[]; dynamic: string[] } {
  const syntax = ts.createSourceFile('runtime.mjs', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const creators = new Set(['createRequire']), loaders = new Set(['require']);
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && ['module', 'node:module'].includes(node.moduleSpecifier.text)
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) if ((item.propertyName ?? item.name).text === 'createRequire') creators.add(item.name.text);
    }
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) && key.text === 'createRequire' && ts.isIdentifier(element.name)) creators.add(element.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(syntax);
  const creator = (node: ts.Expression): boolean => ts.isIdentifier(node) && creators.has(node.text)
    || ts.isPropertyAccessExpression(node) && node.name.text === 'createRequire'
    || ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'createRequire';
  const loader = (node: ts.Expression): boolean => ts.isIdentifier(node) && (loaders.has(node.text) || /^(?:require|__require\d*)$/u.test(node.text))
    || ts.isCallExpression(node) && creator(node.expression);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of declarations) {
      if (!ts.isIdentifier(node.name) || !node.initializer) continue;
      const value = node.initializer;
      if (creator(value) && !creators.has(node.name.text)) { creators.add(node.name.text); changed = true; }
      if ((loader(value) || ts.isCallExpression(value) && creator(value.expression)) && !loaders.has(node.name.text)) { loaders.add(node.name.text); changed = true; }
    }
  }
  const externals = new Set<string>(), dynamic = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly || (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)) : node.isTypeOnly;
      if (!typeOnly) externals.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || loader(node.expression)
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' && loader(node.expression.expression))) {
      if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) externals.add(node.arguments[0].text);
      else dynamic.add(node.getText(syntax));
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return { externals: [...externals].sort(), dynamic: [...dynamic].sort() };
}

export function apiBundleExternals(metadata: ApiMetafile, emitted: string): string[] {
  // Input edges include erased types; emitted loads and real output edges grant authority.
  return [...new Set([...apiModuleLoads(emitted).externals, ...Object.values(metadata.outputs)
    .flatMap(node => (node.imports ?? []).filter(edge => edge.external).map(edge => edge.path))])].sort();
}
export function unqualifiedApiDynamicLoads(emitted: string): string[] {
  return apiModuleLoads(emitted).dynamic;
}

export async function buildApiBundleProducts(repoRoot: string, out: string, declaredRuntimePackages: string[]): Promise<ApiBundleReceipt> {
  mkdirSync(out, { recursive: true });
  const products: ApiBundleProduct[] = [];
  const combinedInputs: Record<string, unknown> = {};
  for (const role of Object.keys(apiRuntimeArtifacts) as Array<keyof typeof apiRuntimeArtifacts>) {
    const artifact = apiRuntimeArtifacts[role];
    const adapters: AdapterReceipt[] = [];
    const config = { entrypoints: [path.join(repoRoot, artifact.source)], target: 'node' as const, format: 'esm' as const,
      external: apiRuntimeImportDeclarations.filter(item => item.externalize).map(item => item.specifier),
      metafile: true, plugins: [observableStoreBundlePlugin(repoRoot, row => adapters.push(row)), packageRootBundlePlugin(repoRoot, row => adapters.push(row)), piWorkerBundlePlugin(repoRoot, row => adapters.push(row))] };
    const buildCwd = process.cwd();
    const result = await buildWithBun(config);
    if (!result.success) throw new AggregateError(result.logs, 'API ' + role + ' bundle failed');
    const rawMetadata = (result as typeof result & { metafile: ApiMetafile }).metafile;
    if (!rawMetadata?.inputs || !Object.keys(rawMetadata.inputs).length || result.outputs.length !== 1) throw new Error('API physical bundle metadata/output missing');
    const metadata = normalizeApiMetafile(repoRoot, buildCwd, rawMetadata);
    const implementation = path.basename(artifact.implementation), entry = path.basename(artifact.entry), metadataPath = role + '.inputs.json', rawMetadataPath = role + '.raw.inputs.json';
    writeFileSync(path.join(out, implementation), Buffer.from(await result.outputs[0].arrayBuffer()));
    writeFileSync(path.join(out, entry), esmRuntimeEntry(artifact.implementation, artifact.entry));
    writeFileSync(path.join(out, metadataPath), JSON.stringify(metadata, null, 2) + '\n');
    writeFileSync(path.join(out, rawMetadataPath), JSON.stringify(rawMetadata, null, 2) + '\n');
    const externals = apiBundleExternals(metadata, readFileSync(path.join(out, implementation), 'utf8'));
    products.push({ role, implementation: bundleFile(out, implementation), entry: bundleFile(out, entry), metadata: bundleFile(out, metadataPath), rawMetadata: bundleFile(out, rawMetadataPath),
      buildCwdRelativeToRepo: path.relative(repoRoot, buildCwd), metadataNormalizationVersion: 'api-metafile-repo-v1',
      inputs: Object.keys(metadata.inputs).sort().map(file => bundleFile(repoRoot, file)), adapters, externals, runtimeImports: runtimeImportBindings(repoRoot, metadata, externals),
      dynamicLoads: unqualifiedApiDynamicLoads(readFileSync(path.join(out, implementation), 'utf8')) });
    Object.assign(combinedInputs, metadata.inputs);
  }
  const supportedRange = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines?.node;
  if (typeof supportedRange !== 'string') throw new Error('Canonical Node support range missing');
  const receipt = { schemaVersion: 1 as const, products, nodeBuiltins: nodeBuiltinAuthority(products.flatMap(product => product.externals), supportedRange),
    runtimePackageManifest: bundleFile(repoRoot, 'packages/xpod-api/package.json') };
  // Building material is distinct from granting runtime installation authority.
  verifyApiBundleProducts(repoRoot, out, receipt, declaredRuntimePackages, { requireClosedDynamicLoads: false });
  writeFileSync(path.join(out, 'bundle-products.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(path.join(out, 'inputs.json'), JSON.stringify({ inputs: combinedInputs }, null, 2) + '\n');
  return receipt;
}

export const bundleSHA256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function safeBundlePath(value: string): boolean {
  return typeof value === 'string' && !!value && !path.isAbsolute(value) && !value.includes('\\')
    && !/[\x00-\x1f\x7f]/u.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
export function bundleFile(root: string, relative: string): BundleFile {
  if (!safeBundlePath(relative)) throw new Error('Unsafe API bundle material path');
  const candidate = path.join(root, relative);
  const boundary = realpathSync(root);
  const resolved = realpathSync(candidate);
  const distance = path.relative(boundary, resolved);
  if (distance.startsWith('..' + path.sep) || distance === '..' || path.isAbsolute(distance)
    || !lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink()) throw new Error('API bundle material escaped authority');
  const bytes = readFileSync(candidate);
  return { path: relative, sha256: bundleSHA256(bytes), bytes: bytes.length };
}

/** Verify actual source, metadata and emitted bytes before any stage writes. */
export function verifyApiBundleProducts(repoRoot: string, buildRoot: string, receipt: ApiBundleReceipt, declaredRuntimePackages: string[], options: { requireClosedDynamicLoads: boolean } = { requireClosedDynamicLoads: true }): void {
  if (receipt.schemaVersion !== 1 || !Array.isArray(receipt.products) || receipt.products.length !== Object.keys(apiRuntimeArtifacts).length) throw new Error('API bundle receipt incomplete');
  if (receipt.runtimePackageManifest?.path !== 'packages/xpod-api/package.json'
    || JSON.stringify(bundleFile(repoRoot, receipt.runtimePackageManifest.path)) !== JSON.stringify(receipt.runtimePackageManifest)) throw new Error('API capability runtime manifest drift');
  const runtimeManifest = JSON.parse(readFileSync(path.join(repoRoot, receipt.runtimePackageManifest.path), 'utf8'));
  if (JSON.stringify(Object.keys(runtimeManifest.dependencies ?? {}).sort()) !== JSON.stringify([...new Set(declaredRuntimePackages)].sort())) throw new Error('API declared runtime package set drift');
  const supportedRange = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines?.node;
  if (typeof supportedRange !== 'string') throw new Error('Canonical Node support range missing');
  verifyNodeBuiltinAuthority(receipt.nodeBuiltins, receipt.products.flatMap(product => product.externals), supportedRange);
  if (options.requireClosedDynamicLoads) {
    const actual = nodeBuiltinAuthority(receipt.products.flatMap(product => product.externals), supportedRange);
    if (JSON.stringify(actual) !== JSON.stringify(receipt.nodeBuiltins)) throw new Error('Node builtin result replay drift');
  }
  const nodeBuiltins = new Map(receipt.nodeBuiltins.results.map(row => [row.specifier, row.builtin]));
  const roles = new Set<string>();
  const adapterIdentities = new Map<string, string>();
  const verify = (root: string, row: BundleFile) => {
    if (!row || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Invalid API bundle file receipt');
    const actual = bundleFile(root, row.path);
    if (actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) throw new Error('API bundle material drift: ' + row.path);
  };
  for (const product of receipt.products) {
    const artifact = apiRuntimeArtifacts[product.role];
    if (!artifact || roles.has(product.role)) throw new Error('Unknown or duplicate API bundle role');
    roles.add(product.role);
    if (product.implementation.path !== path.posix.basename(artifact.implementation)
      || product.entry.path !== path.posix.basename(artifact.entry) || product.metadata.path !== product.role + '.inputs.json' || product.rawMetadata.path !== product.role + '.raw.inputs.json'
      || product.metadataNormalizationVersion !== 'api-metafile-repo-v1' || typeof product.buildCwdRelativeToRepo !== 'string') throw new Error('API artifact layout drift');
    for (const row of [product.implementation, product.entry, product.metadata, product.rawMetadata]) verify(buildRoot, row);
    if (readFileSync(path.join(buildRoot, product.entry.path), 'utf8') !== esmRuntimeEntry(artifact.implementation, artifact.entry)) throw new Error('API entry shim drift');
    const metadata = JSON.parse(readFileSync(path.join(buildRoot, product.metadata.path), 'utf8')) as ApiMetafile;
    const rawMetadata = JSON.parse(readFileSync(path.join(buildRoot, product.rawMetadata.path), 'utf8')) as ApiMetafile;
    if (JSON.stringify(normalizeApiMetafile(repoRoot, path.resolve(repoRoot, product.buildCwdRelativeToRepo), rawMetadata)) !== JSON.stringify(metadata)) throw new Error('API metafile normalization binding drift');
    const inputs = new Map(product.inputs.map(row => [row.path, row]));
    if (!metadata.inputs || inputs.size !== product.inputs.length || JSON.stringify(Object.keys(metadata.inputs).sort()) !== JSON.stringify([...inputs.keys()].sort()) || !inputs.has(artifact.source)) throw new Error('API metadata/source inventory mismatch');
    for (const row of product.inputs) verify(repoRoot, row);
    const externals = apiBundleExternals(metadata, readFileSync(path.join(buildRoot, product.implementation.path), 'utf8'));
    const unknownLoads = unqualifiedApiDynamicLoads(readFileSync(path.join(buildRoot, product.implementation.path), 'utf8'));
    if (options.requireClosedDynamicLoads && unknownLoads.length) throw new Error('Unqualified API dynamic module loads: ' + unknownLoads.join(', '));
    if (JSON.stringify(product.dynamicLoads) !== JSON.stringify(unknownLoads)) throw new Error('API dynamic load inventory drift');
    if (JSON.stringify(externals) !== JSON.stringify([...new Set(product.externals)].sort())) throw new Error('API metadata/external inventory mismatch');
    if (JSON.stringify(product.runtimeImports) !== JSON.stringify(runtimeImportBindings(repoRoot, metadata, externals))) throw new Error('API runtime external owner binding drift');
    for (const external of externals) {
      const packageName = external.startsWith('@') ? external.split('/').slice(0, 2).join('/') : external.split('/')[0];
      if (!nodeBuiltins.get(external) && external !== 'bun:sqlite' && !declaredRuntimePackages.includes(packageName)
        && !product.runtimeImports.some(item => item.specifier === packageName)) throw new Error('Undeclared API bundle external: ' + external);
    }
    const localAdapters = new Set<string>();
    for (const adapter of product.adapters) {
      const source = inputs.get(adapter.source);
      const expectedVersion = adapter.source === 'src/runtime/package-root.ts' ? packageRootAdapterVersion
        : adapter.source === observableStoreSource ? observableStoreAdapterVersion
        : ['src/api/runs/PiAgentRuntimeDriver.ts', apiRuntimeArtifacts.worker.source].includes(adapter.source) ? workerAdapterVersion : undefined;
      if (!source || source.sha256 !== adapter.sourceSHA256 || !expectedVersion || adapter.adapterVersion !== expectedVersion || localAdapters.has(adapter.source)) throw new Error('API adapter source binding mismatch');
      localAdapters.add(adapter.source);
      const identity = JSON.stringify([adapter.sourceSHA256, adapter.adapterVersion]);
      const previous = adapterIdentities.get(adapter.source);
      if (previous && previous !== identity) throw new Error('API source has conflicting adapter variants');
      adapterIdentities.set(adapter.source, identity);
    }
    for (const source of [...(inputs.has(observableStoreSource) ? [observableStoreSource] : []), 'src/runtime/package-root.ts', 'src/api/runs/PiAgentRuntimeDriver.ts', ...(product.role === 'worker' ? [artifact.source] : [])]) {
      if (!localAdapters.has(source)) throw new Error('Required API build adapter missing: ' + source);
    }
  }
}
