import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

let registeredRoot: string | undefined;
/** Called only by unbundled public bridges/entry, using their own location. */
export function bindModuleRoot(root: string): void {
  const candidate = existsSync(root) ? realpathSync(root) : path.resolve(root);
  if (registeredRoot && registeredRoot !== candidate) { throw new Error('AFS library root already registered'); }
  registeredRoot = candidate;
}

function validateRoot(root: string): string {
  const physical = realpathSync(root);
  const pkg = JSON.parse(readFileSync(path.join(physical, 'package.json'), 'utf8')) as {
    name?: string; xpodModule?: { schemaVersion?: number; id?: string; cliApiVersion?: number; platform?: string; arch?: string };
  };
  if (pkg.name === '@undefineds.co/xpod-afs') { return physical; }
  const manifest = pkg.xpodModule;
  if (manifest?.schemaVersion !== 1 || manifest.id !== 'afs' || manifest.cliApiVersion !== 1 ||
      pkg.name !== `@undefineds.co/xpod-afs-${manifest.platform}-${manifest.arch}`) {
    throw new Error('AFS package root identity mismatch');
  }
  return physical;
}

/** Installed entry, never the parent xpod command (which owns the module lock). */
export function moduleLauncher(): string[] {
  if (registeredRoot) { return [process.execPath, path.join(moduleRoot(), 'dist', 'entry.mjs')]; }
  const entry = process.argv[1];
  if (!entry) { throw new Error('Cannot determine AFS entry'); }
  const root = moduleRoot();
  if (entry.startsWith('/$bunfs/')) { return [process.execPath, 'agent-fs']; }
  if (path.basename(entry) === 'xpodcli.mjs') { return [process.execPath, path.resolve(entry), 'agent-fs']; }
  const installed = path.join(root, 'dist', 'entry.mjs');
  return [process.execPath, existsSync(installed) ? installed : path.join(root, 'src', 'run.ts')];
}

export function moduleRoot(): string {
  // Bundled CommonJS library and workspace sources both live one level below
  // their package root. argv is intentionally not a helper discovery authority.
  const entry = process.argv[1];
  // Library registration takes precedence over a consumer's unrelated argv.
  // Validate on use so importing pure workcopy APIs does not require a mount
  // payload in a separately bundled server; it never falls back on failure.
  if (registeredRoot) { return validateRoot(registeredRoot); }
  // Explicit legacy preview profile, retained until build:preview is retired.
  // It is not a module installation or a development helper fallback.
  if (entry?.startsWith('/$bunfs/')) { return path.resolve(path.dirname(process.execPath), '..'); }
  if (entry && path.basename(entry) === 'xpodcli.mjs') { return path.resolve(path.dirname(entry), '..'); }
  if (entry && path.basename(entry) === 'entry.mjs') {
    const installed = path.resolve(path.dirname(entry), '..');
    const manifest = path.join(installed, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).xpodModule?.id === 'afs') { return validateRoot(installed); }
  }
  let directory = typeof __dirname === 'string' ? __dirname : entry ? path.dirname(path.resolve(entry)) : process.cwd();
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; xpodModule?: { id?: string } };
      if (pkg.name === '@undefineds.co/xpod-afs' || pkg.xpodModule?.id === 'afs') { return directory; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) { throw new Error('AFS package root unavailable'); }
    directory = parent;
  }
}
