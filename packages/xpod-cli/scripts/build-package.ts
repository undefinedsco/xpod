import canonicalHostSources from './canonical-host-sources.json';
import { cliBuildDependencyLayout, buildDependencyRootArgument } from '../src/build-dependency-layout';
import { buildPublicTools } from './public-build-tools';
import { exportProducerMaterials } from './producer-materials';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { bunBundleEnvironment } from '../src/native-target';
import { externalRuntimeLauncher } from '../src/launcher';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { repoRoot, dependencyRoots } = cliBuildDependencyLayout(packageRoot, buildDependencyRootArgument(process.argv.slice(2)));
const output = path.join(packageRoot, 'dist');
// Canonical host source closure. Capability implementations never enter this allowlist.
const hostSources = new Set(canonicalHostSources.map(file => path.resolve(packageRoot, '../../src', file)));
const hostBindings = { root: path.resolve(packageRoot, '../../src'), files: [...hostSources].map(file => ({
  path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
})) };
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const configured = readFileSync(path.join(packageRoot, 'src/manifest.ts'), 'utf8').match(/XPOD_CLI_VERSION = '([^']+)'/)?.[1];
if (version !== configured) throw new Error('CLI manifest/package version mismatch');
rmSync(output, { recursive: true, force: true }); mkdirSync(path.join(output, 'bin'), { recursive: true });
for (const [entryName, filename, format, profile] of [['npm-entry', 'xpod.mjs', 'esm', 'core'], ['client', 'client.cjs', 'cjs', 'client']] as const) {
  const entry = path.join(packageRoot, `src/${entryName}.ts`); const payload = path.join(output, filename);
  const evidence = path.join(packageRoot, '.test-data/build'); mkdirSync(evidence, { recursive: true });
  const metadata = path.join(evidence, `${entryName}-inputs.json`);
  const build = spawnSync('bun', ['build', '--target=node', '--external=@undefineds.co/xpod-client', `--format=${format}`, `--metafile=${metadata}`, '--outfile', payload, entry],
    { cwd: packageRoot, stdio: 'inherit', env: bunBundleEnvironment(process.env) });
  if (build.status !== 0) throw new Error('CLI build failed');
  const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs);
  if (inputs.some(file => {
    const absolute = path.resolve(packageRoot, file);
    const relative = path.relative(packageRoot, absolute).replaceAll(path.sep, '/');
    return !relative.includes('node_modules/') && !hostSources.has(absolute)
      && !/^(?:src\/(?:npm-entry|client|core|module-[^/]+|manifest)\.ts|src\/(?:lib|commands)\/[^/]+\.ts)$/.test(relative);
  }) || inputs.some(file => /node_modules\/(?:@solid\/community-server|inngest(?:-cli)?\/|@undefineds.co\/xpod)/.test(file))) {
    throw new Error('Public CLI unexpectedly depends on server, UI or native module sources');
  }
  collectJavascriptNotices({ dependencyRoots, metafile: metadata, stageRoot: packageRoot, repoRoot,
    canonicalSources: hostBindings,
    destination: path.join(output, 'licenses', profile), target: `${process.platform}-${process.arch}`, cli: payload,
    bunVersion: process.versions.bun ?? 'unknown', supplements: path.join(packageRoot, 'licenses/javascript'),
    generated: path.join(packageRoot, 'licenses/javascript/generated', process.versions.bun ?? 'unknown'), generatedProfile: profile });
  console.log(`CLI ${version} ${profile}: ${inputs.length} inputs, no CSS/API/AFS runtime payload`);
}
// Public presentation adapter: one CLI-owned implementation, no command or launcher graph.
const outputMetadata = path.join(packageRoot, '.test-data/build/output-inputs.json');
const outputBuild = spawnSync('bun', ['build', '--target=node', '--format=esm', '--external=@undefineds.co/xpod-client',
  `--metafile=${outputMetadata}`, '--outfile', path.join(output, 'output.mjs'), path.join(packageRoot, 'src/lib/output.ts')],
  { cwd: packageRoot, stdio: 'inherit', env: bunBundleEnvironment(process.env) });
if (outputBuild.error || outputBuild.status !== 0) throw new Error('Public output build failed');
collectJavascriptNotices({ dependencyRoots, metafile: outputMetadata, stageRoot: packageRoot, repoRoot,
  destination: path.join(output, 'licenses/output'), sharedObjectRoot: path.join(output, 'licenses/core/objects'),
  target: `${process.platform}-${process.arch}`, cli: path.join(output, 'output.mjs'), bunVersion: process.versions.bun ?? 'unknown',
  generated: path.join(packageRoot, 'licenses/javascript/generated', process.versions.bun ?? 'unknown'), generatedProfile: 'output-esm' });
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

buildPublicTools(packageRoot, repoRoot, path.join(output, 'licenses/core/objects'));

await exportProducerMaterials(packageRoot, [...hostSources]);
