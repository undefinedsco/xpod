import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { collectJavascriptNotices } from '@undefineds.co/xpod-cli/build-tools';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const args of [
  ['build', '--target=node', '--format=cjs', '--external=./peer.cjs', '--external=@inrupt/solid-client-authn-node', '--metafile=dist/inputs.json', '--outfile=dist/library.cjs', 'src/index.ts'],
  ['x', '--no-install', 'tsc', '-p', 'tsconfig.json'],
]) {
  const result = spawnSync('bun', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Runtime client build failed');
}
const program = ts.createProgram([path.join(root, 'src/index.ts')], { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, skipLibCheck: true });
const checker = program.getTypeChecker();
const symbol = checker.getSymbolAtLocation(program.getSourceFile(path.join(root, 'src/index.ts'))!);
if (!symbol) throw new Error('Runtime client public exports missing');
const values = checker.getExportsOfModule(symbol).filter(item => {
  const resolved = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
  if (resolved.declarations?.some(node => ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.Const))) throw new Error('Mutable public runtime exports cannot use constant bridges');
  return Boolean(resolved.flags & ts.SymbolFlags.Value);
}).map(item => item.name).sort();
if (values.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) throw new Error('Invalid runtime public export');
writeFileSync(path.join(root, 'dist/index.mjs'), "import client from './library.cjs';\n" + values.map(name => `export const ${name} = client.${name};`).join('\n') + '\n');

const toolsArg = process.argv.indexOf('--build-tools');
const tools = toolsArg >= 0 ? path.resolve(process.argv[toolsArg + 1]) : createRequire(path.join(root, 'package.json')).resolve('@undefineds.co/xpod-cli/build-tools');
const tooling = await import(pathToFileURL(tools).href) as { collectJavascriptNotices: typeof collectJavascriptNotices };
let dependencyRoot = root;
while (!existsSync(path.join(dependencyRoot, 'node_modules'))) {
  const parent = path.dirname(dependencyRoot);
  if (parent === dependencyRoot) throw new Error('Declared build dependencies missing');
  dependencyRoot = parent;
}
tooling.collectJavascriptNotices({ metafile: path.join(root, 'dist/inputs.json'), stageRoot: root, repoRoot: dependencyRoot,
  destination: path.join(root, 'dist/licenses'), target: `${process.platform}-${process.arch}`,
  cli: path.join(root, 'dist/library.cjs'), bunVersion: process.versions.bun ?? 'unknown',
  generated: path.join(root, 'licenses/javascript/generated', process.versions.bun ?? 'unknown'), generatedProfile: 'client' });

copyFileSync(path.join(root, 'src/peer.cjs'), path.join(root, 'dist/peer.cjs'));
writeFileSync(path.join(root, 'dist/session.mjs'), "import peer from './session.cjs';\nexport const Session = peer.Session;\n");
writeFileSync(path.join(root, 'dist/session.cjs'), "// SDK interface bridge; no SDK implementation embedded.\nmodule.exports = { Session: require('./peer.cjs').loadPeerSdk().Session };\n");
