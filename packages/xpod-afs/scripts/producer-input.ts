import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type ProducerBuildTools = Pick<typeof import('@undefineds.co/xpod-cli/build-tools'),
  'verifyProducerSourceArchive' | 'collectJavascriptNotices'>;
const loadedTools = new Map<string, { sha256: string; tools: ProducerBuildTools }>();
const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function requiredPackageDirectory(args: readonly string[], flag: string): string {
  const positions = args.flatMap((value, index) => value === flag ? [index] : []);
  if (positions.length !== 1) throw new Error('Required exactly one ' + flag + ' build artifact');
  const value = args[positions[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('Required ' + flag + ' build artifact path');
  return realpathSync(path.resolve(value));
}

/** Only a normal distribution SDK directory is admitted; the material verifier binds its bytes. */
export function resolveRuntimeClientInput(args: readonly string[]): string {
  const root = requiredPackageDirectory(args, '--client-package');
  const file = path.join(root, 'package.json');
  if (lstatSync(file).isSymbolicLink()) throw new Error('Runtime client manifest must not be a symlink');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.name !== '@undefineds.co/xpod-client' || typeof manifest.version !== 'string') throw new Error('Explicit runtime client package identity is invalid');
  return root;
}

/** The CLI package is a declared build artifact, never an AFS runtime dependency. */
export function resolveProducerInput(args: readonly string[]) {
  const root = requiredPackageDirectory(args, '--cli-package');
  const manifestPath = path.join(root, 'package.json');
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('Producer manifest must not be a symlink');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== '@undefineds.co/xpod-cli' || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(manifest.version)) {
    throw new Error('Explicit producer package identity is invalid');
  }
  const hashes = new Map<string, string>([[manifestPath, digest(manifestPath)]]);
  const assertCurrent = (): void => {
    for (const [file, expected] of hashes) {
      if (digest(file) !== expected) throw new Error('Explicit producer artifact hash changed: ' + file);
    }
  };
  const resolve = (subpath: string, condition: 'require' | 'import' = 'require'): string => {
    const declaration = manifest.exports?.['./' + subpath];
    const target = typeof declaration === 'string' ? declaration : declaration?.[condition] ?? declaration?.default;
    if (typeof target !== 'string' || !target.startsWith('./')) throw new Error('Producer public export is missing: ' + subpath);
    const file = path.resolve(root, target);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Producer export escapes declared artifact: ' + subpath);
    }
    let entry = root;
    for (const part of relative.split(path.sep)) {
      entry = path.join(entry, part);
      if (lstatSync(entry).isSymbolicLink()) throw new Error('Producer export must not contain a symlink: ' + subpath);
    }
    if (!statSync(file).isFile()) throw new Error('Producer export must be a file: ' + subpath);
    const real = realpathSync(file);
    const expected = hashes.get(real);
    if (expected && expected !== digest(real)) throw new Error('Explicit producer artifact hash changed: ' + real);
    hashes.set(real, digest(real));
    return real;
  };
  const indexPath = resolve('producer-materials');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (index.schemaVersion !== 1 || index.status !== 'producer-materials-only'
    || index.producer?.name !== manifest.name || index.producer?.version !== manifest.version) {
    throw new Error('Producer index/package identity or material ABI mismatch');
  }
  const toolsPath = resolve('build-tools');
  const toolsSHA256 = digest(toolsPath);
  const previous = loadedTools.get(toolsPath);
  if (previous && previous.sha256 !== toolsSHA256) throw new Error('Cached producer tools artifact hash changed');
  const tools = previous?.tools ?? createRequire(manifestPath)(toolsPath) as ProducerBuildTools;
  if (typeof tools.verifyProducerSourceArchive !== 'function' || typeof tools.collectJavascriptNotices !== 'function') {
    throw new Error('Explicit producer build tools do not implement the public contract');
  }
  loadedTools.set(toolsPath, { sha256: toolsSHA256, tools });
  assertCurrent();
  return Object.freeze({ root, indexPath, toolsPath, tools, assertCurrent,
    resolveImport: (subpath: string) => resolve(subpath, 'import') });
}
