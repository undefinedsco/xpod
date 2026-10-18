import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { cliBuildDependencyLayout } from '../src/build-dependency-layout';
import { collectJavascriptNotices } from '../src/javascript-notices';
import { bunBundleEnvironment } from '../src/native-target';

/** One producer implementation for bootstrap tooling and the full CLI artifact. */
export function buildPublicTools(packageRoot: string, repoRoot: string, sharedObjectRoot?: string): void {
const layout = cliBuildDependencyLayout(packageRoot);
if (layout.repoRoot !== repoRoot) throw new Error('CLI build workspace root mismatch');
const output = path.join(packageRoot, 'dist');
mkdirSync(path.join(packageRoot, '.test-data/build'), { recursive: true });
mkdirSync(output, { recursive: true });
// Producer tooling bundles its declared parser; consumers install no build dependencies.
for (const [format, extension] of [['esm', 'mjs'], ['cjs', 'cjs']] as const) {
  const toolingMetadata = path.join(packageRoot, '.test-data/build', `build-tools-${format}-inputs.json`);
  const result = spawnSync('bun', ['build', '--target=node', `--format=${format}`, `--metafile=${toolingMetadata}`, '--outfile',
    path.join(output, `build-tools.${extension}`), path.join(packageRoot, 'src/build-tools.ts')],
    { cwd: packageRoot, stdio: 'inherit', env: bunBundleEnvironment(process.env) });
  if (result.status !== 0) throw new Error('Public build tooling bundle failed');
  collectJavascriptNotices({ dependencyRoots: layout.dependencyRoots, metafile: toolingMetadata, stageRoot: packageRoot, repoRoot,
    destination: path.join(output, 'licenses/build-tools', format), sharedObjectRoot, target: `${process.platform}-${process.arch}`,
    cli: path.join(output, `build-tools.${extension}`), bunVersion: process.versions.bun ?? 'unknown',
    supplements: path.join(packageRoot, 'licenses/javascript'),
    generated: path.join(packageRoot, 'licenses/javascript/generated', process.versions.bun ?? 'unknown'),
    generatedProfile: `build-tools-${format}` });
}
const toolingDeclarations = spawnSync('bun', ['x', '--no-install', 'tsc', '-p', 'tsconfig.build-tools.json'],
  { cwd: packageRoot, stdio: 'inherit' });
if (toolingDeclarations.status !== 0) throw new Error('Public build tooling declarations failed');

}
