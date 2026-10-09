import { timingSafeEqual } from 'node:crypto';
import {
  HttpError, ForbiddenHttpError, HttpHandler, InternalServerError,
  NotImplementedHttpError, UnauthorizedHttpError,
  type ErrorHandler, type ResponseWriter, type HttpHandlerInput,
} from '@solid/community-server';
import {
  readLocalProvisionState, resolveLocalSetupPath, resolveLocalSetupProviderId,
  type LocalProvisionState,
} from '../provision/LocalProvisionState';
import { podDeletionRouteName } from '../provision/PodDeletionRoute';
import type { PodDeletionLifecycleService } from '../service/PodDeletionLifecycleService';

export interface LocalPodDeletionHttpHandlerOptions {
  lifecycle: PodDeletionLifecycleService;
  storageBaseUrl: string;
  rootFilePath: string;
  errorHandler: ErrorHandler;
  responseWriter: ResponseWriter;
}

interface ClaimedDeletion {
  operationId: string;
  accountId: string;
  podId: string;
  storageUrl: string;
  nodeId: string;
  action: 'delete-pod';
  state: 'claimed' | 'completed';
  ownerWebIds: string[];
  remotePodId: string;
}

/** Executes only a local root credential or an exact, authenticated Cloud command. */
export class LocalPodDeletionHttpHandler extends HttpHandler {
  private readonly setupPath: string;
  private readonly providerId: string;
  private readonly configuredServiceToken?: string;

  public constructor(private readonly options: LocalPodDeletionHttpHandlerOptions) {
    super();
    this.setupPath = resolveLocalSetupPath(process.env.XPOD_LOCAL_SETUP_PATH, options.rootFilePath);
    this.providerId = resolveLocalSetupProviderId(process.env.XPOD_PROVIDER_ID);
    this.configuredServiceToken = process.env.XPOD_SERVICE_TOKEN;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!podDeletionRouteName(request.method, request.url ?? '')) { throw new NotImplementedHttpError(); }
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    try {
      await this.execute({ request, response });
    } catch (error: unknown) {
      // This route runs before CSS's normal operation/error pipeline. Reuse its
      // negotiator and writer so command failures retain their HTTP status.
      const result = await this.options.errorHandler.handleSafe({
        error: HttpError.isInstance(error) ? error : new InternalServerError('POD_DELETE_NODE_FAILED'),
        request,
      });
      await this.options.responseWriter.handleSafe({ response, result });
    }
  }

  private async execute({ request, response }: HttpHandlerInput): Promise<void> {
    const name = podDeletionRouteName(request.method, request.url ?? '');
    if (!name) { throw new NotImplementedHttpError(); }
    const storageUrl = new URL(`${name}/`, this.options.storageBaseUrl.replace(/\/?$/u, '/')).href;
    const state = readLocalProvisionState(this.setupPath, this.providerId);
    const authorization = request.headers.authorization ?? '';
    const serviceToken = this.configuredServiceToken || state?.serviceToken;
    if (serviceToken && authorization.startsWith('Bearer ') && sameSecret(authorization.slice(7), serviceToken)) {
      await this.options.lifecycle.deleteLocal(storageUrl);
    } else {
      const operationId = request.headers['x-xpod-pod-deletion-operation'];
      const grant = /^XpodPodDelete ([a-zA-Z0-9_-]{43})$/u.exec(authorization)?.[1];
      if (!grant || typeof operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(operationId)) {
        throw new UnauthorizedHttpError('POD_DELETE_INVALID_COMMAND');
      }
      const command = { operationId, grant, storageUrl };
      const claimed = await this.callback(state, command, 'claim') as { operation?: ClaimedDeletion };
      const operation = claimed?.operation;
      if (!operation || operation.operationId !== operationId || operation.nodeId !== state?.nodeId ||
        operation.storageUrl !== storageUrl || typeof operation.accountId !== 'string' || !operation.accountId ||
        typeof operation.podId !== 'string' || !operation.podId ||
        typeof operation.remotePodId !== 'string' || !operation.remotePodId ||
        !Array.isArray(operation.ownerWebIds) || !operation.ownerWebIds.length ||
        operation.ownerWebIds.some((webId) => typeof webId !== 'string' || !webId) ||
        operation.action !== 'delete-pod' || !['claimed', 'completed'].includes(operation.state)) {
        throw new ForbiddenHttpError('POD_DELETE_INVALID_GRANT');
      }
      // A completed command must never resolve a newly provisioned Pod at the same URL.
      if (operation.state !== 'completed') {
        await this.options.lifecycle.deleteLocal(storageUrl, operationId, {
          podId: operation.remotePodId, ownerWebIds: operation.ownerWebIds,
        });
      }
      const completion = await this.callback(state, command, 'complete') as { success?: boolean };
      if (completion?.success !== true) { throw new HttpError(502, 'PodDeletionGatewayError', 'POD_DELETE_NOT_ACKNOWLEDGED'); }
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ success: true, storageUrl }));
  }

  private async callback(
    state: LocalProvisionState | undefined,
    command: { operationId: string; grant: string; storageUrl: string },
    action: 'claim' | 'complete',
  ): Promise<unknown> {
    if (!state?.cloudApiUrl || !state.nodeId || !state.nodeToken) { throw new UnauthorizedHttpError('POD_DELETE_NODE_AUTH_REQUIRED'); }
    let root: URL;
    try { root = new URL(state.cloudApiUrl); } catch { throw new UnauthorizedHttpError('POD_DELETE_NODE_AUTH_REQUIRED'); }
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
      throw new UnauthorizedHttpError('POD_DELETE_NODE_AUTH_REQUIRED');
    }
    let result: Response;
    try {
      result = await fetch(new URL(`api/pod-deletions/${command.operationId}/${action}`, root.href.replace(/\/?$/u, '/')), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `XpodNode ${state.nodeId}:${state.nodeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant: command.grant, storageUrl: command.storageUrl }),
      });
    } catch { throw new HttpError(502, 'PodDeletionGatewayError', 'POD_DELETE_NODE_UNAVAILABLE'); }
    if (result.status === 401 || result.status === 403) { throw new ForbiddenHttpError('POD_DELETE_INVALID_GRANT'); }
    if (!result.ok) { throw new HttpError(502, 'PodDeletionGatewayError', 'POD_DELETE_NODE_FAILED'); }
    try { return await result.json(); } catch { throw new HttpError(502, 'PodDeletionGatewayError', 'POD_DELETE_INVALID_RESPONSE'); }
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
