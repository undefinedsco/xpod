import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MaterializedWorkspace,
  SolidFS,
  SolidFsChange,
  SolidFsConflict,
  SolidFsConflictError,
  SolidFsEntrySource,
  SolidFsHydrator,
  SolidFsManifest,
  SolidFsManifestEntry,
  SolidFsPrepareInput,
  SolidFsPruneOptions,
  SolidFsProjection,
  SolidFsSyncer,
} from './types';
import {
  isLineAddressableRdfPath as isRdfPath,
} from '../storage/rdf/RdfContentTypes';
import {
  contentTypeForPath,
  fileVersion,
  maybeFileVersion,
  resolveWorkspaceResource,
  safeRelativePath,
  snapshotDirectory,
  SolidFsFileSnapshot,
  sourceForProjection,
} from './SolidFsPathUtils';

export interface LocalSolidFSOptions {
  workRoot?: string;
  syncer?: SolidFsSyncer;
  hydrator?: SolidFsHydrator;
}

export class LocalSolidFS implements SolidFS {
  private readonly workRoot: string;
  private readonly syncer?: SolidFsSyncer;
  private readonly hydrator?: SolidFsHydrator;

  public constructor(options: LocalSolidFSOptions = {}) {
    this.workRoot = options.workRoot ?? path.join(os.tmpdir(), 'xpod-solidfs');
    this.syncer = options.syncer;
    this.hydrator = options.hydrator;
  }

  public async prepare(input: SolidFsPrepareInput): Promise<MaterializedWorkspace> {
    const sourceRoot = input.sourcePath
      ? path.resolve(input.sourcePath)
      : this.resolveWorkspacePath(input.workspace);
    const projection = input.projection ?? 'direct';

    await this.assertSourceDirectory(sourceRoot);

    if (projection === 'direct') {
      const trackChanges = this.syncer?.shouldTrack?.(input) ?? Boolean(this.syncer);
      const syncer = this.syncer;
      const changeFilter = trackChanges
        ? syncer?.shouldTrackPath
          ? (relativePath: string): boolean => syncer.shouldTrackPath!(relativePath)
          : isLineAddressableRdfPath
        : undefined;
      const entries = changeFilter ? await snapshotDirectory(sourceRoot, changeFilter) : [];
      const manifest = this.createManifest(input.workspace, sourceRoot, projection, entries);
      if (trackChanges && syncer?.initializeWorkspace) {
        await syncer.initializeWorkspace(manifest, input.context);
      }
      return new LocalMaterializedWorkspace({
        sourceRoot,
        cwd: sourceRoot,
        projection,
        cleanupOnRollback: false,
        manifest,
        changeFilter,
        context: input.context,
        syncer: this.syncer,
        hydrator: this.hydrator,
      });
    }

    if (projection === 'hydrated-object') {
      const cwd = await this.createHydratedWorkdir(sourceRoot, input.run?.id);
      return new LocalMaterializedWorkspace({
        sourceRoot,
        cwd,
        projection,
        cleanupOnRollback: true,
        manifest: this.createManifest(input.workspace, cwd, projection, []),
        context: input.context,
        hydrator: this.hydrator,
      });
    }

    if (projection !== 'copy') {
      throw new Error(`LocalSolidFS does not support projection '${projection}' yet.`);
    }

    const cwd = await this.createCopyWorkdir(sourceRoot, input.run?.id);
    const entries = await snapshotDirectory(sourceRoot);
    await cp(sourceRoot, cwd, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });

    return new LocalMaterializedWorkspace({
      sourceRoot,
      cwd,
      projection,
      cleanupOnRollback: true,
      manifest: this.createManifest(input.workspace, cwd, projection, entries),
      context: input.context,
      syncer: this.syncer,
      hydrator: this.hydrator,
    });
  }

  private resolveWorkspacePath(workspace: string): string {
    if (workspace.startsWith('file://')) {
      const url = new URL(workspace);
      const pathname = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
        return pathname.slice(1);
      }
      return pathname;
    }

    if (path.isAbsolute(workspace)) {
      return workspace;
    }

    throw new Error(`Unsupported workspace '${workspace}'. LocalSolidFS expects file:// or absolute paths.`);
  }

  private async createCopyWorkdir(sourceRoot: string, runId?: string): Promise<string> {
    const safeRun = (runId ?? 'run').replace(/[^a-zA-Z0-9._-]+/gu, '_');
    const prefix = path.join(this.workRoot, `${safeRun}-`);
    await mkdir(this.workRoot, { recursive: true });
    const cwd = await mkdtemp(prefix);

    const sourceName = path.basename(sourceRoot.replace(/[\\/]+$/u, '')) || 'workspace';
    return path.join(cwd, sourceName);
  }

  private async createHydratedWorkdir(sourceRoot: string, runId?: string): Promise<string> {
    const safeRun = (runId ?? 'run').replace(/[^a-zA-Z0-9._-]+/gu, '_');
    await mkdir(this.workRoot, { recursive: true });
    const cwd = await mkdtemp(path.join(this.workRoot, `${safeRun}-hydrated-`));
    const workspaceDir = path.join(cwd, path.basename(sourceRoot.replace(/[\\/]+$/u, '')) || 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private createManifest(
    workspace: string,
    cwd: string,
    projection: SolidFsProjection,
    snapshots: SolidFsFileSnapshot[],
  ): SolidFsManifest {
    const source = sourceForProjection(projection, workspace);
    return {
      workspace,
      cwd,
      projection,
      entries: snapshots.map((snapshot): SolidFsManifestEntry => ({
        path: snapshot.relativePath,
        resource: resolveWorkspaceResource(workspace, snapshot.relativePath),
        source,
        sourcePath: snapshot.absolutePath,
        projection,
        sourceVersion: snapshot.version,
        workingVersion: snapshot.version,
        state: 'clean',
      })),
    };
  }

  private async assertSourceDirectory(sourceRoot: string): Promise<void> {
    let sourceStat;
    try {
      sourceStat = await stat(sourceRoot);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw new Error(`SolidFS workspace does not exist: ${sourceRoot}`);
      }
      throw error;
    }

    if (!sourceStat.isDirectory()) {
      throw new Error(`SolidFS workspace is not a directory: ${sourceRoot}`);
    }
  }

}

interface LocalMaterializedWorkspaceOptions {
  sourceRoot: string;
  cwd: string;
  projection: SolidFsProjection;
  cleanupOnRollback: boolean;
  manifest: SolidFsManifest;
  changeFilter?: (relativePath: string) => boolean;
  context?: unknown;
  syncer?: SolidFsSyncer;
  hydrator?: SolidFsHydrator;
}

class LocalMaterializedWorkspace implements MaterializedWorkspace {
  public readonly cwd: string;
  public readonly manifest: SolidFsManifest;

  private readonly sourceRoot: string;
  private readonly projection: SolidFsProjection;
  private readonly cleanupOnRollback: boolean;
  private readonly changeFilter?: (relativePath: string) => boolean;
  private readonly context?: unknown;
  private readonly syncer?: SolidFsSyncer;
  private readonly hydrator?: SolidFsHydrator;
  private readonly entrySource: SolidFsEntrySource;

  public constructor(options: LocalMaterializedWorkspaceOptions) {
    this.sourceRoot = options.sourceRoot;
    this.cwd = options.cwd;
    this.projection = options.projection;
    this.cleanupOnRollback = options.cleanupOnRollback;
    this.manifest = options.manifest;
    this.changeFilter = options.changeFilter;
    this.context = options.context;
    this.syncer = options.syncer;
    this.hydrator = options.hydrator;
    this.entrySource = sourceForProjection(this.projection, this.manifest.workspace);
  }

  public async commit(): Promise<SolidFsManifest> {
    if (this.projection === 'hydrated-object') {
      return this.commitHydratedObjects();
    }

    const changes = await this.detectChanges();
    this.manifest.changes = changes;

    if (this.projection === 'direct') {
      await this.syncChanges(changes);
      this.markCommitted();
      return this.manifest;
    }

    if (this.projection !== 'copy') {
      throw new Error(`Commit is not implemented for projection '${this.projection}'.`);
    }

    const conflicts = await this.findConflicts();
    if (conflicts.length > 0) {
      for (const entry of this.manifest.entries) {
        if (conflicts.some((conflict) => conflict.path === entry.path)) {
          entry.state = 'conflict';
        }
      }
      throw new SolidFsConflictError(conflicts);
    }

    await rm(this.sourceRoot, { recursive: true, force: true });
    await cp(this.cwd, this.sourceRoot, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
    await this.syncChanges(changes);
    this.markCommitted();
    return this.manifest;
  }

  public async rollback(): Promise<void> {
    if (this.cleanupOnRollback) {
      await rm(path.dirname(this.cwd), { recursive: true, force: true });
    }
  }

  public async hydrate(relativePath: string): Promise<SolidFsManifestEntry> {
    if (this.projection !== 'hydrated-object') {
      throw new Error(`hydrate() is only supported for hydrated-object projection, not '${this.projection}'`);
    }
    if (!this.hydrator) {
      throw new Error('SolidFS hydrated-object projection requires a hydrator');
    }

    const normalized = safeRelativePath(relativePath);
    const targetPath = path.join(this.cwd, normalized);
    await mkdir(path.dirname(targetPath), { recursive: true });

    const result = await this.hydrator.hydrate({
      path: normalized,
      targetPath,
      workspace: this.manifest,
      context: this.context,
    });

    const workingVersion = await fileVersion(targetPath);
    let entry = this.manifest.entries.find((candidate) => candidate.path === normalized);
    if (!entry) {
      entry = {
        path: normalized,
        resource: resolveWorkspaceResource(this.manifest.workspace, normalized),
        source: this.entrySource,
        sourcePath: targetPath,
        contentType: result?.contentType ?? contentTypeForPath(normalized),
        projection: this.projection,
        sourceVersion: result?.sourceVersion,
        workingVersion,
        lastAccessedAt: Date.now(),
        state: 'clean',
      };
      this.manifest.entries.push(entry);
      this.manifest.entries.sort((left, right) => left.path.localeCompare(right.path));
      return entry;
    }

    entry.sourcePath = targetPath;
    entry.contentType = result?.contentType ?? entry.contentType ?? contentTypeForPath(normalized);
    entry.sourceVersion = result?.sourceVersion ?? entry.sourceVersion;
    entry.workingVersion = workingVersion;
    entry.lastAccessedAt = Date.now();
    entry.state = 'clean';
    return entry;
  }

  public async prune(options: SolidFsPruneOptions = {}): Promise<SolidFsManifest> {
    if (this.projection !== 'hydrated-object') {
      return this.manifest;
    }

    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? 0;
    const retained: SolidFsManifestEntry[] = [];

    for (const entry of this.manifest.entries) {
      const currentVersion = await maybeFileVersion(entry.sourcePath);
      const dirty = currentVersion !== undefined && currentVersion !== entry.workingVersion;
      if (dirty) {
        entry.state = 'dirty';
        retained.push(entry);
        continue;
      }

      const age = now - (entry.lastAccessedAt ?? now);
      if (age >= olderThanMs) {
        await rm(entry.sourcePath, { force: true });
        continue;
      }
      retained.push(entry);
    }

    this.manifest.entries = retained;
    return this.manifest;
  }

  private async commitHydratedObjects(): Promise<SolidFsManifest> {
    if (!this.hydrator) {
      throw new Error('SolidFS hydrated-object projection requires a hydrator');
    }

    const changes = await this.detectHydratedChanges();
    this.manifest.changes = changes;

    for (const change of changes) {
      if (change.type === 'deleted' && this.hydrator.delete) {
        await this.hydrator.delete({
          change,
          workspace: this.manifest,
          context: this.context,
        });
        this.manifest.entries = this.manifest.entries.filter((entry) => entry.path !== change.path);
        continue;
      }
      if (change.type !== 'deleted') {
        const result = await this.hydrator.commit({
          change,
          workspace: this.manifest,
          context: this.context,
        });
        const entry = this.manifest.entries.find((candidate) => candidate.path === change.path);
        if (entry) {
          entry.sourceVersion = result?.sourceVersion ?? entry.sourceVersion;
          entry.workingVersion = await fileVersion(entry.sourcePath);
          entry.lastAccessedAt = Date.now();
        }
      }
    }

    this.markCommitted();
    return this.manifest;
  }

  private async detectHydratedChanges(): Promise<SolidFsChange[]> {
    const changes: SolidFsChange[] = [];
    const tracked = new Set(this.manifest.entries.map((entry) => entry.path));
    for (const entry of this.manifest.entries) {
      const currentVersion = await maybeFileVersion(entry.sourcePath);
      if (currentVersion === undefined) {
        changes.push({
          path: entry.path,
          resource: entry.resource ?? resolveWorkspaceResource(this.manifest.workspace, entry.path),
          source: entry.source,
          sourcePath: entry.sourcePath,
          contentType: entry.contentType,
          projection: this.projection,
          type: 'deleted',
          sourceVersion: entry.sourceVersion,
        });
        entry.state = 'dirty';
        continue;
      }
      if (currentVersion !== entry.workingVersion) {
        changes.push({
          path: entry.path,
          resource: entry.resource ?? resolveWorkspaceResource(this.manifest.workspace, entry.path),
          source: entry.source,
          sourcePath: entry.sourcePath,
          contentType: entry.contentType,
          projection: this.projection,
          type: 'updated',
          sourceVersion: entry.sourceVersion,
        });
        entry.state = 'dirty';
      }
    }

    for (const snapshot of await snapshotDirectory(this.cwd)) {
      if (tracked.has(snapshot.relativePath)) {
        continue;
      }
      this.manifest.entries.push({
        path: snapshot.relativePath,
        resource: resolveWorkspaceResource(this.manifest.workspace, snapshot.relativePath),
        source: this.entrySource,
        sourcePath: snapshot.absolutePath,
        contentType: contentTypeForPath(snapshot.relativePath),
        projection: this.projection,
        workingVersion: snapshot.version,
        lastAccessedAt: Date.now(),
        state: 'dirty',
      });
      changes.push({
        path: snapshot.relativePath,
        resource: resolveWorkspaceResource(this.manifest.workspace, snapshot.relativePath),
        source: this.entrySource,
        sourcePath: snapshot.absolutePath,
        contentType: contentTypeForPath(snapshot.relativePath),
        projection: this.projection,
        type: 'created',
      });
    }
    this.manifest.entries.sort((left, right) => left.path.localeCompare(right.path));
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async findConflicts(): Promise<SolidFsConflict[]> {
    const conflicts: SolidFsConflict[] = [];
    const initialPaths = new Set(this.manifest.entries.map((entry) => entry.path));

    for (const entry of this.manifest.entries) {
      if (!entry.sourceVersion) {
        continue;
      }
      const currentVersion = await maybeFileVersion(entry.sourcePath);
      if (currentVersion !== entry.sourceVersion) {
        conflicts.push({
          path: entry.path,
          sourcePath: entry.sourcePath,
          expectedVersion: entry.sourceVersion,
          actualVersion: currentVersion,
          message: 'Source file changed after workspace prepare.',
        });
      }
    }

    const currentSourceFiles = await snapshotDirectory(this.sourceRoot);
    for (const current of currentSourceFiles) {
      if (!initialPaths.has(current.relativePath)) {
        conflicts.push({
          path: current.relativePath,
          sourcePath: current.absolutePath,
          actualVersion: current.version,
          message: 'Source file was created after workspace prepare.',
        });
      }
    }
    return conflicts;
  }

  private async detectChanges(): Promise<SolidFsChange[]> {
    const before = new Map(this.manifest.entries.map((entry) => [entry.path, entry]));
    if (before.size === 0 && this.projection === 'direct' && !this.changeFilter) {
      return [];
    }
    const after = new Map((await snapshotDirectory(this.cwd, this.changeFilter)).map((snapshot) => [snapshot.relativePath, snapshot]));
    const changes: SolidFsChange[] = [];

    for (const [relativePath, snapshot] of after) {
      const entry = before.get(relativePath);
      if (!entry) {
        changes.push(this.createChange(relativePath, snapshot.absolutePath, 'created'));
        continue;
      }
      if (entry.sourceVersion !== snapshot.version) {
        changes.push(this.createChange(relativePath, snapshot.absolutePath, 'updated'));
      }
    }

    for (const [relativePath, entry] of before) {
      if (!after.has(relativePath)) {
        changes.push(this.createChange(relativePath, entry.sourcePath, 'deleted'));
      }
    }

    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  private createChange(
    relativePath: string,
    sourcePath: string,
    type: SolidFsChange['type'],
  ): SolidFsChange {
    return {
      path: relativePath,
      resource: resolveWorkspaceResource(this.manifest.workspace, relativePath),
      source: this.entrySource,
      sourcePath,
      contentType: contentTypeForPath(relativePath),
      projection: this.projection,
      type,
    };
  }

  private async syncChanges(changes: SolidFsChange[]): Promise<void> {
    if (!this.syncer) {
      return;
    }
    for (const change of changes) {
      await this.syncer.sync(change, this.manifest, this.context);
    }
  }

  private markCommitted(): void {
    for (const entry of this.manifest.entries) {
      entry.state = 'committed';
    }
  }
}

function isLineAddressableRdfPath(filePath: string): boolean {
  return isRdfPath(filePath);
}
