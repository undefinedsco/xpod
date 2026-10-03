import { JsonInteractionHandler, assertAccountId, parsePath, type JsonInteractionHandlerInput, type JsonRepresentation, type PodIdRoute } from '@solid/community-server';
import type { PodDeletionLifecycleService } from '../service/PodDeletionLifecycleService';

/** Preserve the upstream GET/POST owner-management handler and add authenticated DELETE. */
export class PodDeletionInteractionHandler extends JsonInteractionHandler {
  public constructor(
    private readonly source: JsonInteractionHandler,
    private readonly podRoute: PodIdRoute,
    private readonly lifecycle: PodDeletionLifecycleService,
  ) { super(); }

  public override async canHandle(input: JsonInteractionHandlerInput): Promise<void> {
    if (input.method !== 'DELETE' && !this.isAuthorization(input)) { await this.source.canHandle(input); }
  }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    if (input.method !== 'DELETE' && !this.isAuthorization(input)) { return this.source.handleSafe(input); }
    assertAccountId(input.accountId);
    const { podId } = parsePath(this.podRoute, input.target.path);
    if (this.isAuthorization(input)) { return { json: { deletionAuthorization: await this.lifecycle.requestDeletionAuthorization(input.accountId, podId) } }; }
    await this.lifecycle.deleteOwned(input.accountId, podId);
    return { json: { success: true } };
  }
  private isAuthorization(input: JsonInteractionHandlerInput): boolean {
    return input.method === 'POST' && (input.json as { action?: unknown } | undefined)?.action === 'requestDeletionAuthorization';
  }
}
