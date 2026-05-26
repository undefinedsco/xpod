export type SolidFsProjection = 'direct' | 'copy' | 'hydrated-object';
export type SolidFsEntrySource = 'filesystem' | 'pod-http' | 'object';

export type SolidFsEntryState = 'clean' | 'dirty' | 'committed' | 'conflict';
export type SolidFsChangeType = 'created' | 'updated' | 'deleted';

export interface SolidFsRunRef {
  id?: string;
  workspace?: string;
}

export interface SolidFsPrepareInput {
  run?: SolidFsRunRef;
  workspace: string;
  /**
   * Adapter-provided local source path for workspaces that are resolved by
   * the runner before SolidFS materializes them, such as Pod HTTPS containers.
   */
  sourcePath?: string;
  projection?: SolidFsProjection;
  /**
   * Opaque request/runtime context used by adapter syncers. SolidFS itself must
   * not inspect or persist this value because it can contain credentials.
   */
  context?: unknown;
}

export interface SolidFsManifestEntry {
  path: string;
  resource?: string;
  source: SolidFsEntrySource;
  sourcePath: string;
  contentType?: string;
  projection: SolidFsProjection;
  /**
   * Opaque authority-side version token, such as an ETag, object version, RDF
   * revision, or filesystem hash. For local filesystem projections this can be
   * the same value used for dirty detection.
   */
  sourceVersion?: string;
  /**
   * Local working-copy version captured when the entry was materialized. This
   * lets hydrated objects keep an authority ETag in sourceVersion while still
   * detecting local edits by hashing the working file.
   */
  workingVersion?: string;
  lastAccessedAt?: number;
  state: SolidFsEntryState;
}

export interface SolidFsChange {
  path: string;
  resource?: string;
  source: SolidFsEntrySource;
  sourcePath: string;
  contentType?: string;
  projection: SolidFsProjection;
  type: SolidFsChangeType;
  sourceVersion?: string;
}

export interface SolidFsManifest {
  workspace: string;
  cwd: string;
  projection: SolidFsProjection;
  entries: SolidFsManifestEntry[];
  changes?: SolidFsChange[];
}

export interface SolidFsConflict {
  path: string;
  sourcePath: string;
  expectedVersion?: string;
  actualVersion?: string;
  message: string;
}

export class SolidFsConflictError extends Error {
  public readonly conflicts: SolidFsConflict[];

  public constructor(conflicts: SolidFsConflict[]) {
    super(`SolidFS commit conflict: ${conflicts.map((conflict) => conflict.path).join(', ')}`);
    this.name = 'SolidFsConflictError';
    this.conflicts = conflicts;
  }
}

export class SolidFsNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SolidFsNotFoundError';
  }
}

export interface MaterializedWorkspace {
  cwd: string;
  manifest: SolidFsManifest;
  /**
   * Materialize one object-backed resource into the real cwd. Implementations
   * without object hydration support can leave this undefined.
   */
  hydrate?(relativePath: string): Promise<SolidFsManifestEntry>;
  /**
   * Remove clean hydrated working copies that are no longer needed. Dirty files
   * must never be pruned.
   */
  prune?(options?: SolidFsPruneOptions): Promise<SolidFsManifest>;
  commit(): Promise<SolidFsManifest>;
  rollback(): Promise<void>;
}

export interface SolidFS {
  prepare(input: SolidFsPrepareInput): Promise<MaterializedWorkspace>;
}

export interface SolidFsSyncer {
  shouldTrack?(input: SolidFsPrepareInput): boolean;
  shouldTrackPath?(relativePath: string): boolean;
  sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown): Promise<void>;
}

export interface SolidFsHydrateInput {
  path: string;
  targetPath: string;
  workspace: SolidFsManifest;
  context?: unknown;
}

export interface SolidFsHydrateResult {
  contentType?: string;
  sourceVersion?: string;
}

export interface SolidFsCommitHydratedInput {
  change: SolidFsChange;
  workspace: SolidFsManifest;
  context?: unknown;
}

export interface SolidFsCommitHydratedResult {
  sourceVersion?: string;
}

export interface SolidFsHydrator {
  hydrate(input: SolidFsHydrateInput): Promise<SolidFsHydrateResult | void>;
  commit(input: SolidFsCommitHydratedInput): Promise<SolidFsCommitHydratedResult | void>;
  delete?(input: SolidFsCommitHydratedInput): Promise<void>;
}

export interface SolidFsPruneOptions {
  /**
   * Prune clean hydrated files not accessed for at least this many ms.
   * Defaults to 0, meaning any clean hydrated file is eligible.
   */
  olderThanMs?: number;
  now?: number;
}
