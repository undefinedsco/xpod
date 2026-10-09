import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(path.join(root, 'dist'), { recursive: true });
const parsedConfig = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { throw new Error('AFS TypeScript configuration invalid'); } });
if (!parsedConfig) { throw new Error('AFS TypeScript configuration unavailable'); }
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const checker = program.getTypeChecker();
const publicValueExports: Record<string, string[]> = {};
function valueExports(source: string): string[] {
  const file = program.getSourceFile(path.join(root, 'src', source + '.ts')) ?? program.getSourceFile(path.join(root, 'src', source, 'index.ts'));
  const module = file && checker.getSymbolAtLocation(file);
  if (!module) { throw new Error('AFS public module missing'); }
  return checker.getExportsOfModule(module).filter(symbol => {
    const actual = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (!(actual.flags & ts.SymbolFlags.Value)) { return false; }
    for (const declaration of actual.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && !(declaration.parent.flags & ts.NodeFlags.Const)) {
        throw new Error('Mutable AFS public binding requires a live export implementation');
      }
    }
    if (!/^[$A-Z_a-z][$\w]*$/.test(symbol.name) && symbol.name !== 'default') { throw new Error('Unsupported AFS public export name'); }
    return true;
  }).map(symbol => symbol.name).sort();
}
const declarations: string[] = ["export * as entry from '../src/entry';", "export * as runtime from '../src/runtime';"];
for (const [subpath, target] of Object.entries(pkg.exports).filter(([, target]) => typeof target === 'object') as Array<[string, { default: string }]>) {
  const source = subpath === '.' ? 'index' : subpath.slice(2);
  const key = source.replaceAll('/', '_').replaceAll('-', '_');
  declarations.push(`export * as ${key} from '../src/${source}';`);
  const names = valueExports(source); publicValueExports[subpath] = names;
  const outfile = path.join(root, target.default);
  mkdirSync(path.dirname(outfile), { recursive: true });
  const relative = path.relative(path.dirname(outfile), path.join(root, 'dist/library.cjs')).split(path.sep).join('/');
  const rootRelative = path.relative(path.dirname(outfile), root).split(path.sep).join('/');
  writeFileSync(outfile, `const library = require(${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)});\nlibrary.runtime.bindModuleRoot(require('node:path').resolve(__dirname, ${JSON.stringify(rootRelative)}));\nmodule.exports = library.${key};\n`);
  const esmPath = outfile.replace(/\.cjs$/, '.mjs');
  const esmRoot = rootRelative.endsWith('/') ? rootRelative : rootRelative + '/';
  writeFileSync(esmPath, `import library from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\nimport { fileURLToPath } from 'node:url';\nlibrary.runtime.bindModuleRoot(fileURLToPath(new URL(${JSON.stringify(esmRoot)}, import.meta.url)));\n` + names.map(name => name === 'default' ? `export default library.${key}.default;` : `export const ${name} = library.${key}.${name};`).join('\n') + '\n');

}
writeFileSync(path.join(root, 'dist/public-value-exports.json'), JSON.stringify(publicValueExports, null, 2) + '\n');
writeFileSync(path.join(root, 'dist/library-source.ts'), declarations.join('\n') + '\n');
const main = spawnSync('bun', ['build', '--target=node', '--format=cjs', '--external=@undefineds.co/xpod-cli/client', '--external=drizzle-orm', '--external=bun:sqlite', '--metafile=' + path.join(root, 'dist/library-inputs.json'), '--outfile', path.join(root, 'dist/library.cjs'), path.join(root, 'dist/library-source.ts')], { cwd: root, stdio: 'inherit' });
if (main.status !== 0) { throw new Error('AFS entry build failed'); }
writeFileSync(path.join(root, 'dist/entry.mjs'), "import afs from './library.cjs';\nimport { fileURLToPath } from 'node:url';\nimport { handleCliError } from '@undefineds.co/xpod-cli/client';\nafs.runtime.bindModuleRoot(fileURLToPath(new URL('../', import.meta.url)));\ntry { await afs.entry.runAfs(process.argv.slice(2)); } catch (error) { handleCliError(error, process.argv.includes('--json'), 'module_failed'); }\n");

const types = spawnSync('bun', ['x', 'tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (types.status !== 0) { throw new Error('AFS declarations build failed'); }
// Emitted declarations follow the package's ESM contract. Resolve against
// actual output, so Node16 and classic Node see the same canonical graph.
function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? declarationFiles(file) : file.endsWith('.d.ts') ? [file] : [];
  });
}
for (const file of declarationFiles(path.join(root, 'dist/types'))) {
  const content = readFileSync(file, 'utf8');
  const syntax = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const edits: Array<{start: number; end: number; value: string}> = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.startsWith('.') &&
        ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) ||
         (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)))) {
      const original = node.text;
      const absolute = path.resolve(path.dirname(file), original);
      let specifier = original;
      let declaration: string;
      if (/\.(?:js|mjs|cjs)$/.test(original)) {
        declaration = absolute.replace(/\.(js|mjs|cjs)$/, (_, ext: string) => ext === 'js' ? '.d.ts' : ext === 'mjs' ? '.d.mts' : '.d.cts');
      } else if (existsSync(absolute + '.d.ts')) {
        declaration = absolute + '.d.ts'; specifier += '.js';
      } else if (existsSync(path.join(absolute, 'index.d.ts'))) {
        declaration = path.join(absolute, 'index.d.ts'); specifier += '/index.js';
      } else { throw new Error('Unresolved emitted AFS declaration import'); }
      if (!existsSync(declaration)) { throw new Error('Missing emitted AFS declaration target'); }
      edits.push({start: node.getStart(syntax) + 1, end: node.getEnd() - 1, value: specifier});
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  let output = content;
  for (const edit of edits.sort((a,b) => b.start-a.start)) { output = output.slice(0,edit.start) + edit.value + output.slice(edit.end); }
  writeFileSync(file, output);
}


const components = spawnSync('bun', [path.resolve(root, '../../node_modules/componentsjs-generator/bin/componentsjs-generator.js'), '-s', 'src', '-c', 'dist/components', '-i', 'config/components-ignore.json', 'packages/xpod-afs'], { cwd: path.resolve(root, '../..'), stdio: 'inherit' });
if (components.status !== 0) { throw new Error('AFS contract metadata build failed'); }
