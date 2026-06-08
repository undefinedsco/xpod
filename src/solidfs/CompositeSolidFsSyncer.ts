import type { SolidFsChange, SolidFsManifest, SolidFsPrepareInput, SolidFsSyncer } from './types';

export interface CompositeSolidFsSyncerOptions {
  syncers: SolidFsSyncer[];
}

/**
 * Runs multiple SolidFS sync adapters in a deterministic order.
 *
 * This keeps authority writes and derived-index maintenance separate while
 * still letting the journal treat them as one replayable workspace sync step.
 */
export class CompositeSolidFsSyncer implements SolidFsSyncer {
  private readonly syncers: SolidFsSyncer[];

  public constructor(options: CompositeSolidFsSyncerOptions) {
    this.syncers = options.syncers;
  }

  public shouldTrack(input: SolidFsPrepareInput): boolean {
    return this.syncers.some((syncer) => syncer.shouldTrack?.(input) ?? true);
  }

  public shouldTrackPath(relativePath: string): boolean {
    return this.syncers.some((syncer) => syncer.shouldTrackPath?.(relativePath) ?? false);
  }

  public async initializeWorkspace(workspace: SolidFsManifest, context?: unknown): Promise<void> {
    for (const syncer of this.syncers) {
      await syncer.initializeWorkspace?.(workspace, context);
    }
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown): Promise<void> {
    for (const syncer of this.syncers) {
      await syncer.sync(change, workspace, context);
    }
  }
}
