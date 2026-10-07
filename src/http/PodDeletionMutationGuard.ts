import { HttpHandler, NotImplementedHttpError, type HttpHandlerInput } from '@solid/community-server';
import { PodDeletionOperationRepository } from '../identity/drizzle/PodDeletionOperationRepository';

/** Runs before Pod write handlers, keeping a durable deletion snapshot stable across retries. */
export class PodDeletionMutationGuard extends HttpHandler {
  private readonly operations: PodDeletionOperationRepository;
  public constructor(identityDbUrl: string, private readonly baseUrl: string) {
    super(); this.operations = new PodDeletionOperationRepository(identityDbUrl);
  }
  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(request.method ?? '')) { throw new NotImplementedHttpError(); }
    const path = new URL(request.url ?? '/', this.baseUrl).href;
    if (!await this.operations.blocksMutation(path)) { throw new NotImplementedHttpError(); }
  }
  public async handle({ response }: HttpHandlerInput): Promise<void> {
    response.statusCode = 409;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'POD_DELETE_IN_PROGRESS' }));
  }
}
