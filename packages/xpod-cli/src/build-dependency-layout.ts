import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';

/** Only the identified package and its explicitly declared workspace position own inputs. */
export function buildDependencyLayout(packageDirectory: string, identity: { name: string; workspacePath: string }, declaredDependencyRoot?: string): { repoRoot: string; dependencyRoots: string[] } {
  const packageRoot = realpathSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!/^packages\/[a-z0-9][a-z0-9-]*$/u.test(identity.workspacePath) || typeof identity.name !== 'string' || !identity.name || manifest.name !== identity.name) throw new Error('Unexpected build package identity');
  let repoRoot = packageRoot;
  const candidate = path.resolve(packageRoot, '../..');
  const candidateManifest = path.join(candidate, 'package.json');
  if (declaredDependencyRoot !== undefined) {
    if (!path.isAbsolute(declaredDependencyRoot) || realpathSync(declaredDependencyRoot) !== declaredDependencyRoot
      || declaredDependencyRoot !== packageRoot && (declaredDependencyRoot !== candidate || path.relative(candidate, packageRoot) !== identity.workspacePath.split('/').join(path.sep))) throw new Error('Declared dependency root is outside the identified package layout');
    const declaredManifest = path.join(declaredDependencyRoot, 'package.json');
    if (!lstatSync(declaredManifest).isFile() || lstatSync(declaredManifest).isSymbolicLink() || realpathSync(declaredManifest) !== declaredManifest) throw new Error('Declared dependency root manifest must be canonical');
    const declaration = JSON.parse(readFileSync(declaredManifest, 'utf8'));
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) || typeof declaration.name !== 'string' || !declaration.name) throw new Error('Declared dependency root manifest identity missing');
    repoRoot = declaredDependencyRoot;
  }
  if (declaredDependencyRoot === undefined && path.relative(candidate, packageRoot) === identity.workspacePath.split('/').join(path.sep) && existsSync(candidateManifest)) {
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
export function cliBuildDependencyLayout(packageDirectory: string, declaredDependencyRoot?: string) {
  return buildDependencyLayout(packageDirectory, { name: '@undefineds.co/xpod-cli', workspacePath: 'packages/xpod-cli' }, declaredDependencyRoot);
}

/** One explicit owned-root argument, never an ambient environment search. */
export function buildDependencyRootArgument(args: readonly string[]): string | undefined {
  const indexes = args.flatMap((value, index) => value === '--dependency-root' ? [index] : []);
  if (!indexes.length) return undefined;
  if (indexes.length !== 1 || !args[indexes[0]! + 1] || args[indexes[0]! + 1]!.startsWith('--')) throw new Error('Exactly one explicit dependency root required');
  return args[indexes[0]! + 1];
}
