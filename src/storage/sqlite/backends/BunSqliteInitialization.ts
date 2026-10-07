import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveLocalQleverRuntimeCommand } from '../../rdf/LocalQleverNativeSparqlClient';

const SQLITE_ROLE = 'sqlite-runtime';
interface Artifact { path: string; sha256: string; size: number; role?: string }
let initialized: { identity: string; error?: Error } | undefined;

function artifactRoot(): string | undefined {
  const command = resolve(resolveLocalQleverRuntimeCommand());
  const root = dirname(dirname(command));
  const manifest = resolve(root, 'manifest.json');
  const canonical = basename(dirname(command)) === 'bin' && basename(root) === 'qlever';
  // The unconfigured, absent default /opt tree is a source checkout, not a selected payload.
  if (existsSync(manifest) || (canonical && (Boolean(process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND?.trim()) || existsSync(root)))) {
    return existsSync(root) ? realpathSync(root) : root;
  }
  return undefined;
}

function contained(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function validateLibrary(root: string): { path: string; identity: string } {
  const manifestPath = resolve(root, 'manifest.json');
  const actualRoot = realpathSync(root);
  if (!contained(actualRoot, realpathSync(manifestPath))) throw new Error('manifest escapes artifact');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion: number; adapterAbiVersion: number; physicalBackendAbiVersion: number;
    qlever: { repository: string; commit: string; patchSeriesSha256: string }; artifacts: Artifact[];
  };
  if (manifest.schemaVersion !== 1 || manifest.adapterAbiVersion !== 7 || manifest.physicalBackendAbiVersion !== 7 ||
      !manifest.qlever?.repository || !/^[a-f\d]{40}$/iu.test(manifest.qlever.commit) ||
      !/^[a-f\d]{64}$/iu.test(manifest.qlever.patchSeriesSha256) || !Array.isArray(manifest.artifacts)) {
    throw new Error('unsupported manifest contract');
  }
  const library = manifest.artifacts.filter((file) => file.role === SQLITE_ROLE);
  if (library.length !== 1) throw new Error('expected exactly one sqlite-runtime artifact');
  const seen = new Set<string>();
  const actualPaths = new Set<string>();
  let libraryPath = '';
  for (const file of manifest.artifacts) {
    if (typeof file.path !== 'string' || !file.path || isAbsolute(file.path) ||
        file.path.split(/[\\/]/u).some((part) => part === '..') || seen.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f\d]{64}$/iu.test(file.sha256)) {
      throw new Error('invalid or duplicate artifact record');
    }
    seen.add(file.path);
    const candidate = resolve(root, file.path);
    const actual = realpathSync(candidate);
    if (actualPaths.has(actual)) throw new Error('ambiguous artifact aliases');
    actualPaths.add(actual);
    if (!contained(actualRoot, actual) || !statSync(actual).isFile() || statSync(actual).size !== file.size ||
        createHash('sha256').update(readFileSync(actual)).digest('hex') !== file.sha256.toLowerCase()) {
      throw new Error(`invalid artifact: ${file.path}`);
    }
    if (file === library[0]) libraryPath = actual;
  }
  const runtimePath = realpathSync(resolveLocalQleverRuntimeCommand());
  if (!contained(actualRoot, runtimePath) || !manifest.artifacts.some((file) => realpathSync(resolve(root, file.path)) === runtimePath)) {
    throw new Error('selected runtime is not a manifest artifact');
  }
  return { path: libraryPath, identity: `${actualRoot}:${createHash('sha256').update(manifestBytes).digest('hex')}:${libraryPath}:${library[0].sha256.toLowerCase()}` };
}

/** One process choice, checked at both factory and database boundaries. */
export function initializeBunSqlite(Database?: { setCustomSQLite(path: string): boolean }): void {
  if (process.platform !== 'darwin' || typeof (globalThis as any).Bun === 'undefined') return;
  if (initialized?.error) throw initialized.error;
  const root = artifactRoot();
  // Identify a changed release selection before validating/opening its missing assets.
  const selection = root ? `release:${resolve(root)}` : 'builtin';
  if (initialized && (initialized.identity === 'builtin' ? selection !== 'builtin' : !initialized.identity.startsWith(`${selection}:`))) {
    throw new Error('Bun SQLite initialization conflict: use a fresh process for a different SQLite choice');
  }
  try {
    const library = root ? validateLibrary(root) : undefined;
    const identity = library ? `${selection}:${library.identity}` : 'builtin';
    if (initialized) {
      if (initialized.identity !== identity) throw new Error('Bun SQLite initialization conflict: selected artifact changed');
      return;
    }
    if (library) {
      const constructor = Database ?? require('bun:sqlite').Database;
      if (constructor.setCustomSQLite(library.path) !== true) throw new Error('setCustomSQLite returned false');
    }
    initialized = { identity };
  } catch (cause) {
    const error = new Error(`Bun SQLite artifact initialization failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    initialized = { identity: selection, error };
    throw error;
  }
}
