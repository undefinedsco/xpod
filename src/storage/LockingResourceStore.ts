import {
  LockingResourceStore as BaseLockingResourceStore,
  ResourceIdentifier,
  Representation,
  getLoggerFor,
  Conditions,
  ChangeMap,
} from '@solid/community-server';

export class LockingResourceStore extends BaseLockingResourceStore {
  protected override logger = getLoggerFor(this);

  override getLockIdentifier(identifier: ResourceIdentifier): ResourceIdentifier {
    // Guard against missing auxiliary strategy in custom wiring
    const hasAuxiliary = (this as any).auxiliaryStrategy?.isAuxiliaryIdentifier;
    const lockIdentifier = hasAuxiliary ? super.getLockIdentifier(identifier) : identifier;
    this.logger.debug(`getLockIdentifier: ${identifier.path} -> ${lockIdentifier.path}`);
    return lockIdentifier;
  }

  override async addResource(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    this.logger.debug(`trying[addResource]: ${identifier.path}`);
    try {
      const result = await super.addResource(identifier, representation, conditions);
      this.logger.debug(`done[addResource]: ${identifier.path}`);
      return result;
    } catch (error) {
      this.logger.error(`locking: ${identifier.path}, ${error}`);
      throw error;
    } finally {
      this.logger.debug(`unlocked: ${identifier.path}`);
    }
  }

  override async lockedRepresentationRun(identifier: ResourceIdentifier, whileLocked: () => Promise<Representation>):
  Promise<Representation> {
    this.logger.debug(`trying[lockedRepresentationRun]: ${identifier.path}`);
    try {
      const result = await super.lockedRepresentationRun(identifier, async () => {
        this.logger.debug(`  locked: ${identifier.path}`);
        return await whileLocked();
      });
      this.logger.debug(`done[lockedRepresentationRun]: ${identifier.path}`);
      return result;
    } catch (error) {
      this.logger.error(`locking: ${identifier.path}, ${error}`);
      throw error;
    } finally {
      this.logger.debug(`unlocked: ${identifier.path}`);
    }
  }

  override async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    this.logger.debug(`trying[setRepresentation]: ${identifier.path}`);
    try {
      const result = await super.setRepresentation(identifier, representation, conditions);
      this.logger.debug(`done[setRepresentation]: ${identifier.path}`);
      return result;
    } catch (error) {
      this.logger.error(`locking: ${identifier.path}, ${error}`);
      throw error;
    } finally {
      this.logger.debug(`unlocked: ${identifier.path}`);
    }
  }
}
