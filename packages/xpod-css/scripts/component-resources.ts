import { readFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

interface Component { '@id': string; '@type'?: string; requireElement?: string; [key: string]: unknown }
export interface CssResourcePlan {
  files: Array<{ path: string; sha256: string }>;
  componentExports: Array<{ name: string; source: string }>;
  metadataFiles: string[];
}
function files(root: string, relative: string): string[] {
  const directory = path.join(root, relative);
  return readdirSync(directory).sort().flatMap(name => {
    // These routes are owned and built by the API producer. Their presence
    // must not change CSS inputs or make CSS depend on an API UI build.
    if (relative === 'static' && (name === 'dashboard' || name === 'settings')) return [];
    const child = path.posix.join(relative, name); const stat = lstatSync(path.join(root, child));
    if (stat.isSymbolicLink()) throw new Error('CSS resource contains a symlink');
    if (stat.isDirectory()) return files(root, child);
    if (!stat.isFile()) throw new Error('CSS resource contains a nonregular file');
    return [child];
  });
}
export function cssConfigStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(cssConfigStrings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(cssConfigStrings) : [];
}
export function cssResourceFiles(root: string): string[] {
  return ['config', 'templates', 'static'].flatMap(directory => files(root, directory));
}
export function cssSourceExports(root: string): Map<string, { source: string; localName: string; isComponent: boolean; isValue: boolean }> {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('CSS source config invalid'); } });
  if (!parsed) throw new Error('CSS source config missing');
  const program = ts.createProgram([path.join(root, 'src/index.ts')], parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path.join(root, 'src/index.ts')); const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error('Canonical CSS source exports missing');
  const exports = new Map<string, { source: string; localName: string; isComponent: boolean; isValue: boolean }>();
  for (const symbol of checker.getExportsOfModule(module)) {
    const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = actual.valueDeclaration ?? actual.declarations?.[0];
    if (!declaration) continue;
    const relative = path.relative(root, declaration.getSourceFile().fileName).split(path.sep).join('/');
    if (relative.startsWith('src/') && !relative.includes('/../')) exports.set(symbol.name, { source: relative, localName: actual.name,
      isComponent: Boolean(actual.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)), isValue: Boolean(actual.flags & ts.SymbolFlags.Value) });
  }
  return exports;
}
/** Configuration and Components declarations select canonical runtime exports.
 * Original component IRIs are protocol identifiers, not distribution names. */
export function planCssResources(root: string, metadataRoot = root): CssResourcePlan {
  const metadata = files(metadataRoot, 'dist').filter(file => file.endsWith('.jsonld'));
  const definitions = new Map<string, { component: Component; file: string }>();
  const byName = new Map<string, Set<string>>();
  for (const file of metadata) {
    const document = JSON.parse(readFileSync(path.join(metadataRoot, file), 'utf8'));
    for (const component of (document.components ?? []) as Component[]) {
      if (!component['@id']) throw new Error('CSS component identifier missing');
      const previous = definitions.get(component['@id']);
      if (previous && JSON.stringify(previous.component) !== JSON.stringify(component)) throw new Error('Conflicting CSS component definition');
      definitions.set(component['@id'], { component, file });
      if (component.requireElement) {
        const ids = byName.get(component.requireElement) ?? new Set(); ids.add(component['@id']); byName.set(component.requireElement, ids);
      }
    }
  }
  const resourceFiles = cssResourceFiles(root);
  const selected = new Set<string>(); const pending: string[] = [];
  const select = (value: string): void => {
    if (definitions.has(value) && !selected.has(value)) { selected.add(value); pending.push(value); }
    const name = value.split(':')[0];
    for (const id of byName.get(name) ?? []) if (!selected.has(id)) { selected.add(id); pending.push(id); }
  };
  for (const file of resourceFiles.filter(file => file.startsWith('config/') && file.endsWith('.json'))) {
    for (const value of cssConfigStrings(JSON.parse(readFileSync(path.join(root, file), 'utf8')))) select(value);
  }
  while (pending.length) {
    const definition = definitions.get(pending.pop()!)!;
    // Components.js imports whole metadata documents. Every runtime component
    // in a selected document must have its export and dependency closure.
    for (const [id, sibling] of definitions) if (sibling.file === definition.file) select(id);
    for (const value of cssConfigStrings(definition.component)) select(value);
  }
  const exports = cssSourceExports(root);
  const componentExports: CssResourcePlan['componentExports'] = [];
  for (const name of [...new Set([...selected].map(id => definitions.get(id)!.component.requireElement).filter((name): name is string => Boolean(name)))].sort()) {
    const symbol = exports.get(name);
    if (!symbol) throw new Error('Canonical CSS component export missing: ' + name);
    if (!symbol.isValue) continue;
    componentExports.push({ name, source: symbol.source });
  }
  if (!componentExports.length) throw new Error('CSS component closure is empty');
  const metadataFiles = [...new Set([...selected].map(id => definitions.get(id)!.file))].sort();
  const boundFiles = [...new Set([...resourceFiles, ...metadataFiles, 'dist/components/context.jsonld', 'dist/components/components.jsonld'])].sort();
  return { componentExports, metadataFiles,
    files: boundFiles.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(file.startsWith('dist/') ? metadataRoot : root, file))).digest('hex') })) };
}

/** Copy only the selected resource/metadata authority; compiled code is staged
 * by the shared physical dependency producer, never by copying root index. */
export function materializeCssResources(root: string, destination: string, packageName: string, plan: CssResourcePlan, metadataRoot = root): string[] {
  if (!/^@undefineds\.co\/xpod-css-(darwin|linux)-(arm64|x64)$/.test(packageName)) throw new Error('Invalid CSS distribution identity');
  const copied = plan.files.map(file => file.path);
  for (const relative of copied) {
    const output = path.join(destination, relative); mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(relative.startsWith('dist/') ? metadataRoot : root, relative), output);
    // Retain original resources before the Components module adapter changes
    // requireName/imports; rebuilding must not rely on an absent root package.
    const original = path.join(destination, 'source', relative);
    mkdirSync(path.dirname(original), { recursive: true });
    copyFileSync(output, original);
    const fact = plan.files.find(file => file.path === relative);
    if (fact && createHash('sha256').update(readFileSync(output)).digest('hex') !== fact.sha256) throw new Error('CSS resource changed during stage');
  }
  const module = JSON.parse(readFileSync(path.join(destination, 'dist/components/components.jsonld'), 'utf8'));
  if (module.requireName !== '@undefineds.co/xpod') throw new Error('Unexpected canonical CSS Components module');
  module.requireName = packageName;
  module.import = plan.metadataFiles.map(file => 'undefineds:' + file);
  mkdirSync(path.join(destination, 'dist/components'), { recursive: true });
  writeFileSync(path.join(destination, 'dist/components/components.jsonld'), JSON.stringify(module, null, 2) + '\n');
  const entry = plan.componentExports.map(item => {
    const compiled = '../' + item.source.replace(/\.ts$/, '.js');
    return 'exports[' + JSON.stringify(item.name) + '] = require(' + JSON.stringify(compiled) + ')[' + JSON.stringify(item.name) + '];';
  }).join('\n') + '\n';
  writeFileSync(path.join(destination, 'dist/css-components.cjs'), entry);
  return plan.componentExports.map(item => item.source.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
}
