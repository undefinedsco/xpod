import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { bunBundleEnvironment } from '../src/native-target';
import { externalRuntimeLauncher } from '../src/launcher';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = existsSync(path.join(packageRoot, 'node_modules')) ? packageRoot : path.resolve(packageRoot, '../..');
const output = path.join(packageRoot, 'dist');
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const configured = readFileSync(path.join(packageRoot, 'src/manifest.ts'), 'utf8').match(/XPOD_CLI_VERSION = '([^']+)'/)?.[1];
if (version !== configured) throw new Error('CLI manifest/package version mismatch');
rmSync(output, { recursive: true, force: true }); mkdirSync(path.join(output, 'bin'), { recursive: true });
for (const [entryName, filename, format, profile] of [['npm-entry', 'xpod.mjs', 'esm', 'core'], ['client', 'client.cjs', 'cjs', 'client']] as const) {
  const entry = path.join(packageRoot, `src/${entryName}.ts`); const payload = path.join(output, filename);
  const evidence = path.join(packageRoot, '.test-data/build'); mkdirSync(evidence, { recursive: true });
  const metadata = path.join(evidence, `${entryName}-inputs.json`);
  const build = spawnSync('bun', ['build', '--target=node', `--format=${format}`, `--metafile=${metadata}`, '--outfile', payload, entry],
    { cwd: packageRoot, stdio: 'inherit', env: bunBundleEnvironment(process.env) });
  if (build.status !== 0) throw new Error('CLI build failed');
  const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs);
  if (inputs.some(file => {
    const absolute = path.resolve(packageRoot, file);
    const relative = path.relative(packageRoot, absolute).replaceAll(path.sep, '/');
    return !relative.includes('node_modules/') && relative !== 'src/module-catalog.json' && !/^(?:src\/(?:npm-entry|client|core|module-[^/]+|manifest)\.ts|src\/(?:lib|commands)\/[^/]+\.ts)$/.test(relative);
  }) || inputs.some(file => /node_modules\/(?:@solid\/community-server|inngest(?:-cli)?\/|@undefineds.co\/xpod)/.test(file))) {
    throw new Error('Public CLI unexpectedly depends on server, UI or native module sources');
  }
  collectJavascriptNotices({ metafile: metadata, stageRoot: packageRoot, repoRoot,
    destination: path.join(output, 'licenses', profile), target: `${process.platform}-${process.arch}`, cli: payload,
    bunVersion: process.versions.bun ?? 'unknown', supplements: path.join(packageRoot, 'licenses/javascript'),
    generated: path.join(packageRoot, 'licenses/javascript/generated', process.versions.bun ?? 'unknown'), generatedProfile: profile });
  console.log(`CLI ${version} ${profile}: ${inputs.length} inputs, no CSS/API/AFS runtime payload`);
}
const declarations = spawnSync('bun', ['x', '--no-install', 'tsc', '-p', 'tsconfig.client.json'], { cwd: packageRoot, stdio: 'inherit' });
if (declarations.status !== 0) throw new Error('Client declarations failed');
const program = ts.createProgram([path.join(packageRoot, 'src/client.ts')], { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, skipLibCheck: true });
const checker = program.getTypeChecker();
const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(path.join(packageRoot, 'src/client.ts'))!);
const exports = checker.getExportsOfModule(moduleSymbol!).filter(symbol => {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return Boolean(resolved.flags & ts.SymbolFlags.Value);
}).map(symbol => symbol.name).sort();
if (exports.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) throw new Error('Invalid client export');
writeFileSync(path.join(output, 'client.mjs'), `import client from './client.cjs';\n${exports.map(name => `export const ${name} = client.${name};`).join('\n')}\n`);
// Portable external-runtime launcher. No native engine or service runtime is shipped.
writeFileSync(path.join(output, 'bin/xpod'), externalRuntimeLauncher({ payload: 'xpod.mjs' }));
chmodSync(path.join(output, 'bin/xpod'), 0o755);
if (!existsSync(path.join(packageRoot, 'LICENSE'))) copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(packageRoot, 'LICENSE'));
