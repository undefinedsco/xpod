import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { constants, homedir } from 'node:os';
import path from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { t as listTar, x as extractTar } from 'tar';
import { CliCommandError } from './lib/output';
import { MODULE_API_VERSION, moduleDefinition, type ModuleId } from './module-catalog';

const REGISTRY = 'https://registry.npmjs.org';
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const safePath = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !path.isAbsolute(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..');
const error = (code: string, message: string) => new CliCommandError(code, message);
async function fileDigest(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export interface ModuleManifest {
  schemaVersion: 1; id: ModuleId; cliApiVersion: number; platform: string; arch: string; entry: string;
  files: { path: string; sha256: string; size: number; mode: number }[];
}
export interface InstalledModule {
  id: ModuleId; package: string; version: string; integrity: string; platform: string; arch: string;
  manifestSha256: string;
}
export interface StoreOptions {
  root?: string; platform?: string; arch?: string; fetch?: typeof fetch;
}

/** Self-contained artifacts; installation never executes package lifecycle scripts. */
export class ModuleStore {
  public readonly root: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly request: typeof fetch;
  public constructor(options: StoreOptions = {}) {
    this.root = path.resolve(options.root ?? path.join(homedir(), '.xpod', 'modules'));
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.request = options.fetch ?? fetch;
  }
  private definition(id: string) {
    const row = moduleDefinition(id);
    if (!row) throw error('module_unknown', `Unknown module: ${id}`);
    if (!['darwin', 'linux'].includes(this.platform) || !['arm64', 'x64'].includes(this.arch)) {
      throw error('module_platform_unsupported', 'Capability modules currently support macOS/Linux on arm64/x64.');
    }
    return row;
  }
  private directory(row: InstalledModule): string {
    const definition = this.definition(row.id);
    if (!VERSION.test(row.version) || row.package !== `${definition.packagePrefix}-${this.platform}-${this.arch}`
      || row.platform !== this.platform || row.arch !== this.arch) throw error('module_binding_invalid', 'Installed module identity is invalid.');
    return path.join(this.root, row.id, `${this.platform}-${this.arch}`, row.version);
  }
  private pointer(id: ModuleId) { return path.join(this.root, id, `${this.platform}-${this.arch}`, 'current.json'); }
  private async verify(directory: string, row: InstalledModule): Promise<ModuleManifest> {
    const source = await readFile(path.join(directory, 'package', 'package.json'));
    if (createHash('sha256').update(source).digest('hex') !== row.manifestSha256) throw error('module_manifest_changed', 'Installed module manifest changed.');
    const pkg = JSON.parse(source.toString()); const manifest: ModuleManifest = pkg.xpodModule;
    if (pkg.name !== row.package || pkg.version !== row.version || manifest?.schemaVersion !== 1
      || manifest.id !== row.id || manifest.cliApiVersion !== MODULE_API_VERSION || manifest.platform !== row.platform || manifest.arch !== row.arch
      || !safePath(manifest.entry) || !manifest.entry.endsWith('.mjs') || !Array.isArray(manifest.files) || !manifest.files.length) throw error('module_contract_invalid', 'Module is incompatible with this CLI or platform.');
    const names = new Set<string>();
    for (const file of manifest.files) {
      if (!file || !safePath(file.path) || file.path === 'package.json' || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size < 0 || ![0o644, 0o755].includes(file.mode)) throw error('module_inventory_invalid', 'Module file inventory is invalid.');
      names.add(file.path);
      const absolute = path.join(directory, 'package', file.path); const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || (stat.mode & 0o777) !== file.mode
        || await fileDigest(absolute) !== file.sha256) throw error('module_file_changed', 'Installed module contents changed.');
    }
    if (!names.has(manifest.entry)) throw error('module_entry_unbound', 'Module entry is missing from its inventory.');
    const visit = async (relative = ''): Promise<void> => {
      for (const entry of await readdir(path.join(directory, 'package', relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw error('module_link_rejected', 'Module artifacts cannot contain links.');
        if (entry.isDirectory()) await visit(name);
        else if (!entry.isFile() || (name !== 'package.json' && !names.has(name))) throw error('module_inventory_invalid', 'Module contains an unbound file.');
      }
    };
    await visit(); return manifest;
  }
  public async current(id: string): Promise<InstalledModule | undefined> {
    const definition = this.definition(id); let source;
    try { source = await readFile(this.pointer(definition.id), 'utf8'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
    const row: InstalledModule = JSON.parse(source);
    if (row.id !== definition.id) throw error('module_binding_invalid', 'Module selection is invalid.');
    await this.verify(this.directory(row), row); return row;
  }
  private async withLock<T>(id: ModuleId, action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, `${id}-${this.platform}-${this.arch}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw error('module_busy', 'Another module operation is active; retry after it finishes.'); throw cause; }
    try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  public async install(id: string, version = 'latest'): Promise<InstalledModule> {
    const definition = this.definition(id);
    if (version !== 'latest' && !VERSION.test(version)) throw error('module_version_invalid', 'Use an exact module version or latest.');
    return this.withLock(definition.id, async () => {
      const packageName = `${definition.packagePrefix}-${this.platform}-${this.arch}`;
      const response = await this.request(`${REGISTRY}/${encodeURIComponent(packageName)}/${version}`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) throw error('module_unavailable', `Module ${definition.id} is unavailable (${response.status}).`);
      const metadata = await response.json() as { name: string; version: string; dist: { integrity: string; tarball: string } };
      if (metadata.name !== packageName || !VERSION.test(metadata.version) || (version !== 'latest' && metadata.version !== version)
        || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity || '')) throw error('module_metadata_invalid', 'Module registry identity or integrity is invalid.');
      const url = new URL(metadata.dist.tarball);
      if (url.origin !== REGISTRY || url.username || url.password) throw error('module_origin_invalid', 'Module download must come from the npm registry.');
      const parent = path.join(this.root, definition.id, `${this.platform}-${this.arch}`); await mkdir(parent, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(path.join(parent, '.install-'));
      try {
        const archive = await this.request(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
        if (!archive.ok || !archive.body) throw error('module_download_failed', 'Module archive download failed.');
        const tarball = path.join(stage, 'module.tgz'); const handle = await open(tarball, 'wx', 0o600);
        const hasher = createHash('sha512'); let size = 0;
        try {
          for await (const chunk of archive.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length; if (size > 512 * 1024 * 1024) throw error('module_archive_too_large', 'Module archive exceeds the supported size.');
            hasher.update(chunk); await handle.writeFile(chunk);
          }
        } finally { await handle.close(); }
        const digest = hasher.digest(); const expected = Buffer.from(metadata.dist.integrity.slice(7), 'base64');
        if (expected.length !== digest.length || !timingSafeEqual(digest, expected)) throw error('module_integrity_failed', 'Module archive integrity check failed.');
        let expanded = 0; let entries = 0; let invalidArchive = false;
        await listTar({ file: tarball, strict: true, onReadEntry: entry => {
          const name = entry.path.replace(/\/$/, '');
          if (!safePath(name) || name.split('/')[0] !== 'package' || !['File', 'Directory'].includes(entry.type)
            || ++entries > 50_000 || (expanded += entry.size) > 2 * 1024 * 1024 * 1024) invalidArchive = true;
        } });
        if (invalidArchive) throw error('module_archive_invalid', 'Module archive has unsafe or unsupported members.');
        await extractTar({ file: tarball, cwd: stage, strict: true, noChmod: false });
        await rm(tarball);
        const source = await readFile(path.join(stage, 'package/package.json'));
        const row: InstalledModule = { id: definition.id, package: packageName, version: metadata.version, integrity: metadata.dist.integrity,
          platform: this.platform, arch: this.arch, manifestSha256: createHash('sha256').update(source).digest('hex') };
        // Normalize only declared file modes; never execute an installation script.
        const manifest: ModuleManifest = JSON.parse(source.toString()).xpodModule;
        if (Array.isArray(manifest?.files)) for (const file of manifest.files) {
          if (!file || !safePath(file.path) || ![0o644, 0o755].includes(file.mode)) throw error('module_inventory_invalid', 'Module file permissions are invalid.');
          await chmod(path.join(stage, 'package', file.path), file.mode);
        }
        await this.verify(stage, row);
        const destination = this.directory(row);
        try { await lstat(destination); await this.verify(destination, row); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; await rename(stage, destination); }
        const pending = `${this.pointer(definition.id)}.tmp`; await writeFile(pending, JSON.stringify(row), { mode: 0o600 }); await rename(pending, this.pointer(definition.id));
        return row;
      } finally { await rm(stage, { recursive: true, force: true }); }
    });
  }
  public async remove(id: string): Promise<void> {
    const definition = this.definition(id);
    await this.withLock(definition.id, async () => { await rm(path.dirname(this.pointer(definition.id)), { recursive: true, force: true }); });
  }
  public async run(id: string, args: string[]): Promise<number> {
    const row = await this.current(id) ?? await this.install(id);
    return this.withLock(row.id, async () => {
      const directory = this.directory(row); const manifest = await this.verify(directory, row);
      return new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(directory, 'package', manifest.entry), ...args], { stdio: 'inherit', env: process.env });
        const interrupt = () => { child.kill('SIGINT'); };
        const terminate = () => { child.kill('SIGTERM'); };
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
        child.once('error', cause => { cleanup(); reject(cause); });
        child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)); });
      });
    });
  }
}
