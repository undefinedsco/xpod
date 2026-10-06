import { JsonInteractionHandler, type JsonView, type JsonInteractionHandlerInput, type JsonRepresentation } from '@solid/community-server';
import type { PodDeletionLifecycleService } from '../service/PodDeletionLifecycleService';

/** The existing pods map remains owner-management; delete capability is separately advertised. */
export class PodDeletionInventoryHandler extends JsonInteractionHandler implements JsonView {
  public constructor(private readonly source: JsonInteractionHandler & JsonView, private readonly lifecycle: PodDeletionLifecycleService) { super(); }
  public async getView(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const result = await this.source.getView(input);
    const pods = result.json.pods;
    const podDeletionAuthorizationControls: Record<string, string> = {};
    const podDeletionControls: Record<string, string> = {};
    if (pods && typeof pods === 'object' && !Array.isArray(pods)) {
      for (const [storageUrl, control] of Object.entries(pods)) {
        if (typeof control !== 'string') { continue; }
        const podId = decodeURIComponent(new URL(control, storageUrl).pathname.split('/').filter(Boolean).pop() ?? '');
        if (await this.lifecycle.canDelete(storageUrl, podId)) { podDeletionControls[storageUrl] = control; }
        else if (input.accountId && await this.lifecycle.canAuthorizeDeletion(storageUrl, podId, input.accountId)) { podDeletionAuthorizationControls[storageUrl] = control; }
      }
    }
    return { ...result, json: { ...result.json, podDeletionControls, podDeletionAuthorizationControls } };
  }
  public override async canHandle(input: JsonInteractionHandlerInput): Promise<void> { await this.source.canHandle(input); }
  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const name = input.json && typeof input.json === 'object' ? (input.json as { name?: unknown }).name : undefined;
    return this.lifecycle.whileCreating(name, () => this.source.handleSafe(input));
  }
}
