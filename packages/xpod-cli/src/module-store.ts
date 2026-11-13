import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { constants, homedir } from 'node:os';
import path from 'node:path';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { t as listTar, x as extractTar } from 'tar';
import { CliCommandError } from './lib/output';
import { MODULE_API_VERSION, moduleDefinition, modulePackageName, moduleTarget, type ModuleId } from './module-catalog';
import { createModuleInstallDiagnostics, type ModuleInstallDiagnosticObserver } from './module-install-diagnostics';
import { checkInventoryFiles } from './module-inventory-workers';
import { withModuleOwnedLock } from './module-owned-lock';

const REGISTRY = 'https://registry.npmjs.org';
/** Prefix for a seed import identity: the packaged package.json digest. */
const SEED_INTEGRITY_PREFIX = 'seed-package-sha256-';
/** Fixed global file-copy fanout for seed staging. Not user-configurable. */
const SEED_COPY_CONCURRENCY = 8;
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
  id: ModuleId; package: string; version: string;
  /**
   * Identity of where these bytes came from, never a claim we cannot support:
   * `sha512-…` = the producer archive integrity (registry install), or
   * `seed-package-sha256-…` = the sha256 of the packaged `package.json` whose
   * `xpodModule` inventory binds every file (seed import). Both are computed
   * from bytes we actually read.
   */
  integrity: string;
  platform: string; arch: string;
  /** sha256 of the installed `package.json`; always the authority for verify(). */
  manifestSha256: string;
}
export interface StoreOptions {
  root?: string; platform?: string; arch?: string; fetch?: typeof fetch;
  /** Read-only seed of packaged module artifacts shipped beside the runtime. */
  seed?: string;
  /** Packaged runtime: capabilities must already be present in `root`. */
  offline?: boolean;
}
export interface AdmittedModule {
  readonly installed: InstalledModule;
  readonly entry: string;
  readonly cwd: string;
}

/** Self-contained artifacts; installation never executes package lifecycle scripts. */
export class ModuleStore {
  public readonly root: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly request: typeof fetch;
  /** Read-only packaged seed; import source only, never written to. */
  private readonly seed?: string;
  /** Offline runtime: never fall back to a registry download. */
  private readonly offline: boolean;
  public constructor(options: StoreOptions = {}) {
    // A packaged desktop passes its OWNED mutable root plus the read-only seed it
    // shipped with; nothing is ever written under the real HOME.
    this.root = path.resolve(options.root ?? path.join(homedir(), '.xpod', 'modules'));
    this.seed = options.seed === undefined ? undefined : path.resolve(options.seed);
    this.offline = options.offline === true;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.request = options.fetch ?? fetch;
  }
  private definition(id: string) {
    const row = moduleDefinition(id);
    if (!row) throw error('module_unknown', `Unknown module: ${id}`);
    if (!moduleTarget(this.platform, this.arch)) {
      throw error('module_platform_unsupported', 'Capability modules currently support macOS/Linux on arm64/x64.');
    }
    return row;
  }
  private directory(row: InstalledModule): string {
    const definition = this.definition(row.id);
    if (!VERSION.test(row.version) || row.package !== modulePackageName(definition.id, this.platform, this.arch)
      || row.platform !== this.platform || row.arch !== this.arch) throw error('module_binding_invalid', 'Installed module identity is invalid.');
    const seeded = row.integrity.startsWith(SEED_INTEGRITY_PREFIX);
    if (seeded && (!/^[a-f0-9]{64}$/.test(row.manifestSha256)
      || row.integrity !== `${SEED_INTEGRITY_PREFIX}${row.manifestSha256}`)) {
      throw error('module_binding_invalid', 'Packaged module identity is invalid.');
    }
    // Two bundles can carry different bytes with the same package version. Keep
    // both immutable trees; only their current pointer changes after admission.
    const root = seeded ? path.join(this.root, 'packaged', row.manifestSha256) : this.root;
    return path.join(root, row.id, `${this.platform}-${this.arch}`, row.version);
  }
  private pointer(id: ModuleId) { return path.join(this.root, id, `${this.platform}-${this.arch}`, 'current.json'); }
  private async verify(directory: string, row: InstalledModule, diagnostics = createModuleInstallDiagnostics()): Promise<ModuleManifest> {
    const manifest = await diagnostics.run('verify-manifest', async () => {
      const source = await readFile(path.join(directory, 'package', 'package.json'));
      if (createHash('sha256').update(source).digest('hex') !== row.manifestSha256) throw error('module_manifest_changed', 'Installed module manifest changed.');
      const pkg = JSON.parse(source.toString()); const manifest: ModuleManifest = pkg.xpodModule;
      if (pkg.name !== row.package || pkg.version !== row.version || manifest?.schemaVersion !== 1
        || manifest.id !== row.id || manifest.cliApiVersion !== MODULE_API_VERSION || manifest.platform !== row.platform || manifest.arch !== row.arch
        || !safePath(manifest.entry) || !manifest.entry.endsWith('.mjs') || !Array.isArray(manifest.files) || !manifest.files.length) throw error('module_contract_invalid', 'Module is incompatible with this CLI or platform.');
      return manifest;
    });
    const names = new Set<string>();
    await diagnostics.run('verify-files', async () => {
      for (const file of manifest.files) {
        if (!file || !safePath(file.path) || file.path === 'package.json' || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
          || !Number.isSafeInteger(file.size) || file.size < 0 || ![0o644, 0o755].includes(file.mode)) throw error('module_inventory_invalid', 'Module file inventory is invalid.');
        names.add(file.path);
      }
      if (!names.has(manifest.entry)) throw error('module_entry_unbound', 'Module entry is missing from its inventory.');
      await checkInventoryFiles(manifest.files, async file => {
        const absolute = path.join(directory, 'package', file.path); const stat = await lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || (stat.mode & 0o777) !== file.mode
          || await fileDigest(absolute) !== file.sha256) throw error('module_file_changed', 'Installed module contents changed.');
      });
    });
    const visit = async (relative = ''): Promise<void> => {
      for (const entry of await readdir(path.join(directory, 'package', relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw error('module_link_rejected', 'Module artifacts cannot contain links.');
        if (entry.isDirectory()) await visit(name);
        else if (!entry.isFile() || (name !== 'package.json' && !names.has(name))) throw error('module_inventory_invalid', 'Module contains an unbound file.');
      }
    };
    await diagnostics.run('verify-walk', () => visit()); return manifest;
  }
  /**
   * The ONE strict pointer reader: JSON record, binding/id check, and the SAME
   * verifier as admission. Callers decide whether a lifecycle lock is held; the
   * returned manifest is scoped to that call and is never cached across unlock.
   */
  private async verifiedCurrent(id: string): Promise<{ row: InstalledModule; manifest: ModuleManifest } | undefined> {
    const definition = this.definition(id); let source;
    try { source = await readFile(this.pointer(definition.id), 'utf8'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
    const row: InstalledModule = JSON.parse(source);
    if (row.id !== definition.id) throw error('module_binding_invalid', 'Module selection is invalid.');
    const manifest = await this.verify(this.directory(row), row);
    return { row, manifest };
  }
  public async current(id: string): Promise<InstalledModule | undefined> {
    return (await this.verifiedCurrent(id))?.row;
  }
  private async withLock<T>(id: ModuleId, action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, `${id}-${this.platform}-${this.arch}.lock`);
    return withModuleOwnedLock(lock, action);
  }
  public async install(id: string, version = 'latest', onDiagnostic?: ModuleInstallDiagnosticObserver): Promise<InstalledModule> {
    const diagnostics = createModuleInstallDiagnostics(onDiagnostic);
    const definition = this.definition(id);
    if (version !== 'latest' && !VERSION.test(version)) throw error('module_version_invalid', 'Use an exact module version or latest.');
    const lockFinished = diagnostics.start('lock-acquire');
    try { return await this.withLock(definition.id, async () => {
      lockFinished('completed');
      const packageName = modulePackageName(definition.id, this.platform, this.arch)!;
      const metadata = await diagnostics.run('metadata', async () => {
        const response = await this.request(`${REGISTRY}/${encodeURIComponent(packageName)}/${version}`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
        if (!response.ok) throw error('module_unavailable', `Module ${definition.id} is unavailable (${response.status}).`);
        const metadata = await response.json() as { name: string; version: string; dist: { integrity: string; tarball: string } };
        if (metadata.name !== packageName || !VERSION.test(metadata.version) || (version !== 'latest' && metadata.version !== version)
          || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity || '')) throw error('module_metadata_invalid', 'Module registry identity or integrity is invalid.');
        const url = new URL(metadata.dist.tarball);
        if (url.origin !== REGISTRY || url.username || url.password) throw error('module_origin_invalid', 'Module download must come from the npm registry.');
        return metadata;
      });
      const url = new URL(metadata.dist.tarball);
      const parent = path.join(this.root, definition.id, `${this.platform}-${this.arch}`); await mkdir(parent, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(path.join(parent, '.install-'));
      let primaryError: unknown;
      let failed = false;
      try {
        const tarball = path.join(stage, 'module.tgz');
        await diagnostics.run('archive-download-hash', async () => {
          const archive = await this.request(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
          if (!archive.ok || !archive.body) throw error('module_download_failed', 'Module archive download failed.');
          const handle = await open(tarball, 'wx', 0o600);
          const hasher = createHash('sha512'); let size = 0;
          try {
            for await (const chunk of archive.body as unknown as AsyncIterable<Uint8Array>) {
              size += chunk.length; if (size > 512 * 1024 * 1024) throw error('module_archive_too_large', 'Module archive exceeds the supported size.');
              hasher.update(chunk); await handle.writeFile(chunk);
            }
          } finally { await handle.close(); }
          const digest = hasher.digest(); const expected = Buffer.from(metadata.dist.integrity.slice(7), 'base64');
          if (expected.length !== digest.length || !timingSafeEqual(digest, expected)) throw error('module_integrity_failed', 'Module archive integrity check failed.');
        });
        await diagnostics.run('archive-scan', async () => {
          let expanded = 0; let entries = 0; let invalidArchive = false;
          await listTar({ file: tarball, strict: true, onReadEntry: entry => {
            const name = entry.path.replace(/\/$/, '');
            if (!safePath(name) || name.split('/')[0] !== 'package' || !['File', 'Directory'].includes(entry.type)
              || ++entries > 50_000 || (expanded += entry.size) > 2 * 1024 * 1024 * 1024) invalidArchive = true;
          } });
          if (invalidArchive) throw error('module_archive_invalid', 'Module archive has unsafe or unsupported members.');
        });
        // Installation precedes service startup. The public synchronous extractor
        // uses bounded reads and closes every write before returning or throwing.
        await diagnostics.run('archive-extract', () => extractTar({ file: tarball, cwd: stage, strict: true, noChmod: false, noMtime: true, sync: true }));
        await rm(tarball);
        const row = await diagnostics.run('manifest-modes', async () => {
          const source = await readFile(path.join(stage, 'package/package.json'));
          const row: InstalledModule = { id: definition.id, package: packageName, version: metadata.version, integrity: metadata.dist.integrity,
            platform: this.platform, arch: this.arch, manifestSha256: createHash('sha256').update(source).digest('hex') };
          // Normalize only declared file modes; never execute an installation script.
          const manifest: ModuleManifest = JSON.parse(source.toString()).xpodModule;
          if (Array.isArray(manifest?.files)) for (const file of manifest.files) {
            if (!file || !safePath(file.path) || ![0o644, 0o755].includes(file.mode)) throw error('module_inventory_invalid', 'Module file permissions are invalid.');
            await chmod(path.join(stage, 'package', file.path), file.mode);
          }
          return row;
        });
        await this.verify(stage, row, diagnostics);
        const destination = this.directory(row);
        let destinationNeedsPublish = false;
        try { await lstat(destination); await this.verify(destination, row, diagnostics); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; destinationNeedsPublish = true; }
        await diagnostics.run('publish', async () => {
          if (destinationNeedsPublish) await rename(stage, destination);
          const pending = `${this.pointer(definition.id)}.tmp`; await writeFile(pending, JSON.stringify(row), { mode: 0o600 }); await rename(pending, this.pointer(definition.id));
        });
        return row;
      } catch (cause) {
        failed = true; primaryError = cause; throw cause;
      } finally {
        try { await diagnostics.run('cleanup', () => rm(stage, { recursive: true, force: true })); }
        catch (cleanupError) {
          if (failed) throw new AggregateError([primaryError, cleanupError],
            `Module installation failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); staging cleanup failed (${String(cleanupError)})`);
          throw cleanupError;
        }
      }
    }); } catch (cause) { lockFinished('failed'); throw cause; }
  }
  public async remove(id: string): Promise<void> {
    const definition = this.definition(id);
    await this.withLock(definition.id, async () => { await rm(path.dirname(this.pointer(definition.id)), { recursive: true, force: true }); });
  }
  /**
   * Resolve the ONE authoritative packaged artifact for a capability.
   *
   * The bundle must carry exactly one version directory per capability; more than
   * one is an ambiguous build (never "pick the newest"), and the version itself is
   * whatever the packaged manifest declares — we do not synthesise or compare it.
   */
  private async seedSource(id: ModuleId): Promise<{ from: string; version: string; manifestSha256: string } | undefined> {
    if (!this.seed) return undefined;
    const packageName = modulePackageName(id, this.platform, this.arch);
    if (!packageName) return undefined;
    const parent = path.join(this.seed, id, `${this.platform}-${this.arch}`);
    let versions: string[];
    try {
      versions = (await readdir(parent, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && VERSION.test(entry.name))
        .map(entry => entry.name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
    if (!versions.length) return undefined;
    if (versions.length !== 1) throw error('module_seed_ambiguous', 'Packaged seed carries more than one version of a capability.');
    const version = versions[0]!;
    const from = path.join(parent, version);
    let manifestSource: Buffer;
    try { manifestSource = await readFile(path.join(from, 'package', 'package.json')); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw error('module_seed_invalid', 'Packaged seed capability has no manifest.'); throw cause; }
    const pkg = JSON.parse(manifestSource.toString()) as { name?: unknown; version?: unknown; xpodModule?: ModuleManifest };
    const manifest = pkg.xpodModule;
    if (pkg.name !== packageName || pkg.version !== version || !manifest || manifest.id !== id
      || manifest.platform !== this.platform || manifest.arch !== this.arch) {
      throw error('module_seed_invalid', 'Packaged seed manifest does not describe this capability.');
    }
    // Identity derived from bytes we read, not from a guess about provenance.
    return { from, version, manifestSha256: createHash('sha256').update(manifestSource).digest('hex') };
  }

  /**
   * Import ONE packaged capability while its real lifecycle lock is ALREADY held.
   *
   * Returns the verified manifest together with the row. That manifest is valid
   * only inside this lock callback: it is either the verifier's result for the
   * exact staged tree just renamed into place, or a fresh verification of an
   * existing destination. Callers must not return it across unlock.
   */
  private async seedAdmitLocked(id: ModuleId): Promise<{ row: InstalledModule; manifest: ModuleManifest } | undefined> {
    const source = await this.seedSource(id);
    if (!source) return undefined;
    const packageName = modulePackageName(id, this.platform, this.arch)!;
    const row: InstalledModule = {
      id, package: packageName, version: source.version, platform: this.platform, arch: this.arch,
      // Honest identity: the digest of the packaged manifest that binds the tree.
      integrity: `${SEED_INTEGRITY_PREFIX}${source.manifestSha256}`,
      manifestSha256: source.manifestSha256,
    };
    const destination = this.directory(row);
    // Keep the old strict read + SAME verify before deciding to replace: a
    // corrupted warm tree is reported, never silently healed by a re-import.
    const existing = await this.verifiedCurrent(id);
    if (existing && existing.row.version === row.version && existing.row.manifestSha256 === row.manifestSha256) return existing;
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(path.join(parent, '.seed-'));
    let primaryError: unknown;
    let failed = false;
    try {
      const from = path.join(source.from, 'package');
      const staged = path.join(stage, 'package');
      await mkdir(staged, { recursive: true, mode: 0o700 });
      // Walk first, mutate second: the walk only validates member kinds and
      // records canonical work items, so directory creation always precedes the
      // files that live in them and no task can race a parent mkdir.
      const copied: { target: string; relative: string }[] = [];
      const directories: string[] = [];
      const files: { source: string; target: string; relative: string }[] = [];
      const walk = async (relative = ''): Promise<void> => {
        for (const entry of await readdir(path.join(from, relative), { withFileTypes: true })) {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          const target = path.join(staged, name);
          if (entry.isSymbolicLink()) throw error('module_link_rejected', 'Module artifacts cannot contain links.');
          if (entry.isDirectory()) { directories.push(target); await walk(name); }
          else if (entry.isFile()) files.push({ source: path.join(from, name), target, relative: name });
          else throw error('module_inventory_invalid', 'Module contains an unsupported member.');
        }
      };
      const copy = async (): Promise<void> => {
        await walk();
        for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
        // The SAME bounded fanout primitive that verifies inventory, at a higher
        // explicit bound. It is a single flat list, so the bound is global for the
        // module and cannot multiply with tree depth. A failure stops scheduling
        // and drains every started copy before the throw, so cleanup never races
        // one. The private mkdtemp stage is 0700, so a copy is only visible to its
        // owner. COPYFILE_FICLONE stays opportunistic (never FORCE) and EXCL keeps
        // the existing no-overwrite guarantee. No intermediate per-file chmod is
        // needed: the manifest's exact mode is applied once below and fully
        // verified against the same manifest.
        await checkInventoryFiles(files, async file => {
          await copyFile(file.source, file.target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
          copied.push({ target: file.target, relative: file.relative });
        }, SEED_COPY_CONCURRENCY);
      };
      await copy();
      // Apply the manifest's declared modes BEFORE verify(): verify compares the
      // on-disk mode against the manifest, so correcting afterwards is too late.
      const pkg = JSON.parse(await readFile(path.join(stage, 'package', 'package.json'), 'utf8')) as { xpodModule?: ModuleManifest };
      const declared = pkg.xpodModule;
      if (!declared || !Array.isArray(declared.files)) throw error('module_inventory_invalid', 'Module manifest inventory is missing.');
      const modes = new Map<string, number>();
      for (const file of declared.files) {
        if (!file || !safePath(file.path) || ![0o644, 0o755].includes(file.mode) || modes.has(file.path)) {
          throw error('module_inventory_invalid', 'Module file permissions are invalid.');
        }
        modes.set(file.path, file.mode);
      }
      for (const entry of copied) {
        const mode = entry.relative === 'package.json' ? 0o644 : modes.get(entry.relative);
        if (mode === undefined) throw error('module_inventory_invalid', 'Module contains an unbound file.');
        await chmod(entry.target, mode);
      }
      // The SAME verifier as a registry install; no second validator.
      const stagedManifest = await this.verify(stage, row);
      // A prior import may have published these exact bytes before its pointer
      // write failed. Verify and reuse them; never delete an admitted tree. Only
      // when the destination is absent may the staged manifest be reused, because
      // the rename below puts exactly those verified bytes in place. It stays
      // scoped to this lock callback and is never cached.
      let manifest = stagedManifest;
      let publish = true;
      try { await lstat(destination); manifest = await this.verify(destination, row); publish = false; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
      if (publish) await rename(stage, destination);
      await mkdir(path.dirname(this.pointer(id)), { recursive: true, mode: 0o700 });
      const pending = `${this.pointer(id)}.tmp`;
      await writeFile(pending, JSON.stringify(row), { mode: 0o600 });
      await rename(pending, this.pointer(id));
      return { row, manifest };
    } catch (cause) {
      failed = true; primaryError = cause; throw cause;
    } finally {
      // No private waiver: a cleanup failure is surfaced, and both errors are
      // retained exactly like a normal install.
      try { await rm(stage, { recursive: true, force: true }); }
      catch (cleanupError) {
        if (failed) throw new AggregateError([primaryError, cleanupError],
          `Module seed import failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); staging cleanup failed (${String(cleanupError)})`);
        throw cleanupError;
      }
    }
  }

  /** Build the callback view; the verified manifest is only used here. */
  private admittedView(row: InstalledModule, manifest: ModuleManifest): AdmittedModule {
    const directory = this.directory(row);
    return Object.freeze({ installed: Object.freeze({ ...row }),
      entry: path.join(directory, 'package', manifest.entry), cwd: path.join(directory, 'package') });
  }

  /**
   * The ONE admission entry for `run()` and `withAdmittedModules()`.
   *
   * Locks are acquired in canonical ModuleId order so concurrent callers cannot
   * deadlock. The callback receives modules in the caller's REQUESTED order.
   * Offline: seed resolution, strict old-current verification, import, publish and
   * the action all happen while every real lifecycle lock is held. Online: the
   * registry two-stage flow is unchanged (self-locking current/install first,
   * never inside another module lock), then canonical locks plus the second
   * verification still required across the first stage's unlock window.
   */
  private async withAdmission<T>(requested: readonly { id: ModuleId }[], action: (modules: readonly AdmittedModule[]) => Promise<T>): Promise<T> {
    if (new Set(requested.map(row => row.id)).size !== requested.length) {
      throw error('module_selection_invalid', 'Select each module only once.');
    }
    const ordered = [...requested].sort((a, b) => a.id.localeCompare(b.id));
    const rows = new Map<ModuleId, InstalledModule>();
    if (!this.offline) {
      // Registry resolution is self-locking and MUST happen before any admission
      // lock: never current/install/download while another module lock is held.
      for (const definition of requested) {
        rows.set(definition.id, await this.current(definition.id) ?? await this.install(definition.id));
      }
    }
    const admitted = new Map<ModuleId, AdmittedModule>();
    const acquire = async (index: number): Promise<T> => {
      if (index === ordered.length) return action(requested.map(row => admitted.get(row.id)!));
      const id = ordered[index]!.id;
      return this.withLock(id, async () => {
        if (this.offline) {
          const result = await this.seedAdmitLocked(id);
          if (!result) throw error('module_not_staged', `Module ${id} is not staged for this offline runtime.`);
          admitted.set(id, this.admittedView(result.row, result.manifest));
        } else {
          const row = rows.get(id)!;
          const manifest = await this.verify(this.directory(row), row);
          admitted.set(id, this.admittedView(row, manifest));
        }
        return acquire(index + 1);
      });
    };
    return acquire(0);
  }

  public async withAdmittedModules<T>(ids: readonly string[], action: (modules: readonly AdmittedModule[]) => Promise<T>): Promise<T> {
    return this.withAdmission(ids.map(id => this.definition(id)), action);
  }
  public async run(id: string, args: string[]): Promise<number> {
    // Same admission entry as withAdmittedModules: offline binds to the packaged
    // seed, online to the current pointer or a registry install.
    const definition = this.definition(id);
    return this.withAdmission([definition], async modules => {
      const module = modules[0]!;
      return new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [module.entry, ...args], { stdio: 'inherit', env: process.env });
        const interrupt = () => { child.kill('SIGINT'); };
        const terminate = () => { child.kill('SIGTERM'); };
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
        // A spawn error is followed by close too. Keep the operation and its lock
        // open until the direct child's handles have closed in either case.
        let spawnError: Error | undefined;
        child.once('error', cause => { spawnError = cause; });
        child.once('close', (code, signal) => {
          cleanup();
          if (spawnError) reject(spawnError);
          else resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
        });
      });
    });
  }
}
