import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Only the identified package and its explicitly declared workspace position own inputs. */
export function buildDependencyLayout(packageDirectory: string, identity: { name: string; workspacePath: string }): { repoRoot: string; dependencyRoots: string[] } {
  const packageRoot = realpathSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!/^packages\/[a-z0-9][a-z0-9-]*$/u.test(identity.workspacePath) || typeof identity.name !== 'string' || !identity.name || manifest.name !== identity.name) throw new Error('Unexpected build package identity');
  let repoRoot = packageRoot;
  const candidate = path.resolve(packageRoot, '../..');
  const candidateManifest = path.join(candidate, 'package.json');
  if (path.relative(candidate, packageRoot) === identity.workspacePath.split('/').join(path.sep) && existsSync(candidateManifest)) {
    const workspace = JSON.parse(readFileSync(candidateManifest, 'utf8'));
    const declarations = Array.isArray(workspace.workspaces) ? workspace.workspaces : workspace.workspaces?.packages;
    if (Array.isArray(declarations) && declarations.some((entry: unknown) => entry === 'packages/*' || entry === identity.workspacePath)) {
      if (realpathSync(candidate) !== candidate || packageRoot !== path.join(candidate, identity.workspacePath)) throw new Error('CLI workspace path alias');
      repoRoot = candidate;
    }
  }
  const dependencyRoots = [...new Set([path.join(repoRoot, 'node_modules'), path.join(packageRoot, 'node_modules')])]
    .filter(root => existsSync(root)).map(root => {
      if (realpathSync(root) !== root) throw new Error('CLI dependency root must be canonical');
      return root;
    });
  if (!dependencyRoots.length) throw new Error('CLI build dependencies missing');
  return { repoRoot, dependencyRoots };
}

/** Backwards-compatible CLI entry uses the same identified-package implementation. */
export function cliBuildDependencyLayout(packageDirectory: string) {
  return buildDependencyLayout(packageDirectory, { name: '@undefineds.co/xpod-cli', workspacePath: 'packages/xpod-cli' });
}
