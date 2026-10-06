import {
  assertAccountId, BadRequestHttpError, JsonInteractionHandler, MethodNotAllowedHttpError,
  type JsonInteractionHandlerInput, type JsonRepresentation,
} from '@solid/community-server';
import { CloudProfileCreator } from '../provision/CloudProfileCreator';

export class CloudProfilePreparationHandler extends JsonInteractionHandler {
  public constructor(private readonly cloudProfileCreator: CloudProfileCreator) { super(); }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    if (input.method !== 'POST') throw new MethodNotAllowedHttpError(['POST']);
    assertAccountId(input.accountId);
    const body = input.json;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'podName') ||
      !('podName' in body) || typeof body.podName !== 'string' || !body.podName || body.podName.trim() !== body.podName) {
      throw new BadRequestHttpError('The profile preparation body must contain a podName.');
    }
    const prepared = await this.cloudProfileCreator.prepare(input.accountId, body.podName);
    return { json: { ...prepared } };
  }
}
