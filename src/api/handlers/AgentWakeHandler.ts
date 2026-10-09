import { readBoundedRequestBody } from './readBoundedRequestBody';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { MatrixError } from '../matrix/MatrixError';
import type { MatrixStoreContext } from '../matrix/types';
import type { AgentWakeLeaseRequest, AgentWakeRequest, AgentWakeResult, AgentWakeRuntimeService } from '../reconciler/AgentWakeRuntimeService';

export interface AgentWakeHandlerOptions {
  service: AgentWakeRuntimeService;
  resolveContext(request: AuthenticatedRequest): Promise<MatrixStoreContext>;
}

/** Xpod runtime contract; independent of the Matrix client-server route namespace. */
export function registerAgentWakeRoutes(server: ApiServer, options: AgentWakeHandlerOptions): void {
  for (const operation of ['claim', 'renew', 'complete', 'fail'] as const) {
    server.post(`/v1/agent-wakes/${operation}`, async (request, response) => {
      try {
        const context = await options.resolveContext(request);
        const body = await readBody(request);
        validate(body, operation);
        const result = await options.service[operation](body as unknown as AgentWakeLeaseRequest & AgentWakeResult, context);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        const known = error instanceof MatrixError;
        response.writeHead(known ? error.status : 500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          errcode: known ? error.errcode : 'M_UNKNOWN',
          error: known ? error.message : 'Agent runtime request failed',
        }));
      }
    });
  }
}

async function readBody(request: AuthenticatedRequest): Promise<Record<string, unknown>> {
  const chunks = await readBoundedRequestBody(request, 65_536, 'Request exceeds 64 KiB');
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('object required'); }
    return value as Record<string, unknown>;
  } catch {
    throw new MatrixError(400, 'M_BAD_JSON', 'JSON object required');
  }
}

function validate(body: Record<string, unknown>, operation: string): asserts body is Record<string, unknown> & AgentWakeRequest {
  const required = ['roomId', 'agent', 'runtimeId', ...(operation === 'claim' ? [] : ['id', 'fencingToken'])];
  for (const field of required) {
    if (typeof body[field] !== 'string' || !(body[field] as string).trim() || (body[field] as string).length > (field === 'runtimeId' ? 128 : 4096)) {
      throw new MatrixError(400, 'M_BAD_JSON', `${field} must be a non-empty bounded string`);
    }
  }
  if (body.leaseMs !== undefined && (typeof body.leaseMs !== 'number' || !Number.isSafeInteger(body.leaseMs) || body.leaseMs < 1000 || body.leaseMs > 300_000)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'leaseMs must be between 1000 and 300000');
  }
  if (operation === 'complete' && (typeof body.body !== 'string' || !body.body.trim())) {
    throw new MatrixError(400, 'M_BAD_JSON', 'Completion requires body');
  }
  if ((body.handoffTo !== undefined && (typeof body.handoffTo !== 'string' || !body.handoffTo.trim())) ||
    (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.length > 100 || body.evidence.some(item => typeof item !== 'string' || !item.trim()))) ||
    (body.retry !== undefined && typeof body.retry !== 'boolean') ||
    (body.error !== undefined && typeof body.error !== 'string')) {
    throw new MatrixError(400, 'M_BAD_JSON', 'Invalid completion or failure fields');
  }
}
