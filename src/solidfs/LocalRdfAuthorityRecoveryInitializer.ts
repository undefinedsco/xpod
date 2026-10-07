import path from 'node:path';
import { LocalPhysicalOperationService } from '../storage/LocalPhysicalOperationService';
import { SolidRdfEngine } from '../storage/rdf/SolidRdfEngine';

import { getLoggerFor } from 'global-logger-factory';
import { access } from 'node:fs/promises';
import {
  Initializer,
  type FileIdentifierMapper,
  type Finalizable,
} from '@solid/community-server';

import type { LocalRdfIndexAccessor } from '../storage/accessors/MixDataAccessor';
import { isLineAddressableRdfPath } from '../storage/rdf/RdfContentTypes';
import { RdfIndexSolidFsSyncer } from './RdfIndexSolidFsSyncer';
import { RootedSolidFsSyncJournal } from './SolidFsSyncJournal';

/** Restores the derived Local RDF index from its authority files before workers start. */
export class LocalRdfAuthorityRecoveryInitializer extends Initializer implements Finalizable {
  protected readonly logger = getLoggerFor(this);

  public constructor(
    private readonly journal: RootedSolidFsSyncJournal,
    private readonly index: LocalRdfIndexAccessor,
    private readonly resourceMapper: FileIdentifierMapper,
    private readonly baseUrl: string,
    private readonly rootFilePath: string,
    private readonly operationService?: LocalPhysicalOperationService,
    private readonly rdfEngine?: SolidRdfEngine,
  ) {
    super();
  }

  public override async handle(): Promise<void> {
    const recover = async (): Promise<void> => {
      await this.rdfEngine?.open();
      await this.recover();
    };
    if (this.operationService) { await this.operationService.run(recover); }
    else { await recover(); }
  }

  private async recover(): Promise<void> {
    const root = path.resolve(this.rootFilePath);
    const syncer = new RdfIndexSolidFsSyncer({ index: this.index, retainedAuthorityFiles: true });

    await this.journal.bootstrapWorkspace({
      workspace: this.baseUrl,
      cwd: root,
      projection: 'direct',
      source: 'filesystem',
      shouldTrackPath: isLineAddressableRdfPath,
      resolveResource: async (absolutePath) =>
        (await this.resourceMapper.mapFilePathToUrl(absolutePath, false)).identifier.path,
    });

    // Recover pending authority tokens: rebuild derived facts from whichever complete authority
    // file actually remains (old or new), then clear only the exact still-current token. A failed
    // rebuild leaves pending and blocks startup (continued refusal).
    const pending = this.journal.listAuthorityPending();
    for (const op of pending) {
      const sourcePath = op.change.sourcePath;
      if (!sourcePath || !(await pathExists(sourcePath))) {
        throw new Error(`Local RDF authority pending has no complete file to recover: ${op.id}`);
      }
      const workspace = {
        workspace: this.baseUrl,
        cwd: root,
        projection: 'direct' as const,
        entries: [],
      };
      try {
        await syncer.sync(op.change, workspace);
      } catch (error) {
        throw new Error(`Local RDF authority pending rebuild failed for ${op.id}: ${String(error)}`);
      }
      this.journal.clearAuthorityPending(op.id);
    }

    const replay = await this.journal.replayPending(syncer);
    const retryable = this.journal.listOperations(['failed_retryable']).length;
    const reconcileRequired = this.journal.listOperations(['reconcile_required']).length;
    const stillPending = this.journal.listAuthorityPending().length;
    if (retryable > 0 || reconcileRequired > 0 || stillPending > 0) {
      throw new Error(
        `Local RDF authority recovery left ${retryable} retryable, ${reconcileRequired} reconcile-required ` +
        `and ${stillPending} pending operations`,
      );
    }

    await this.journal.compact();
    this.logger.info(
      `Recovered local RDF authority index: ${replay.completed} completed, ${replay.attempted} attempted.`,
    );
  }

  public async finalize(): Promise<void> {
    await this.rdfEngine?.close();
    this.journal.close();
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
