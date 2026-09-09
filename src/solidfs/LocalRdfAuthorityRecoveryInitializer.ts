import path from 'node:path';

import { getLoggerFor } from 'global-logger-factory';
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
  ) {
    super();
  }

  public override async handle(): Promise<void> {
    const root = path.resolve(this.rootFilePath);
    const syncer = new RdfIndexSolidFsSyncer({ index: this.index });

    await this.journal.bootstrapWorkspace({
      workspace: this.baseUrl,
      cwd: root,
      projection: 'direct',
      source: 'filesystem',
      shouldTrackPath: isLineAddressableRdfPath,
      resolveResource: async (absolutePath) =>
        (await this.resourceMapper.mapFilePathToUrl(absolutePath, false)).identifier.path,
    });
    const replay = await this.journal.replayPending(syncer);
    const retryable = this.journal.listOperations(['failed_retryable']).length;
    const reconcileRequired = this.journal.listOperations(['reconcile_required']).length;
    if (retryable > 0 || reconcileRequired > 0) {
      throw new Error(
        `Local RDF authority recovery left ${retryable} retryable and ${reconcileRequired} reconcile-required operations`,
      );
    }

    await this.journal.compact();
    this.logger.info(
      `Recovered local RDF authority index: ${replay.completed} completed, ${replay.attempted} attempted.`,
    );
  }

  public async finalize(): Promise<void> {
    this.journal.close();
  }
}
