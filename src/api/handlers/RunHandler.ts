import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import { getAccountId, getWebId } from '../auth/AuthContext';
import { generateId, nowTimestamp } from '../chatkit/types';
import type { StoreContext } from '../chatkit/store';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { RunStatus, RunStepType, type RunStatusType } from '../runs/schema';
import {
  generateRunStepResourceId,
  resolveDataResource,
  resolveRunUrn,
  type RunListOptions,
  type RunRecordData,
  type RunStore,
} from '../runs/store';
import { isWorkspaceRef } from '../workspace/types';

export interface RunHandlerOptions {
  runStore: RunStore<StoreContext>;
}

export function registerRunRoutes(server: ApiServer, options: RunHandlerOptions): void {
  const logger = getLoggerFor('RunHandler');
  const { runStore } = options;

  server.get('/v1/runs', async (request, response) => {
    try {
      const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
      const runs = await runStore.listRuns(parseRunListOptions(url), buildStoreContext(request));
      sendJson(response, 200, { runs });
    } catch (error) {
      logger.error(`Failed to list runs: ${error}`);
      sendJson(response, 400, { error: formatError(error) });
    }
  });

  server.get('/v1/runs/:runId', async (request, response, params) => {
    try {
      const run = await runStore.loadRun(decodeURIComponent(params.runId), buildStoreContext(request));
      sendJson(response, 200, { run });
    } catch (error) {
      logger.error(`Failed to load run: ${error}`);
      sendJson(response, 404, { error: formatError(error) });
    }
  });

  server.get('/v1/runs/:runId/steps', async (request, response, params) => {
    try {
      const steps = await runStore.loadRunSteps(decodeURIComponent(params.runId), buildStoreContext(request));
      sendJson(response, 200, { steps });
    } catch (error) {
      logger.error(`Failed to load run steps: ${error}`);
      sendJson(response, 404, { error: formatError(error) });
    }
  });

  server.post('/v1/runs/:runId/cancel', async (request, response, params) => {
    try {
      const context = buildStoreContext(request);
      const run = await runStore.loadRun(decodeURIComponent(params.runId), context);
      const now = nowTimestamp();
      run.cancelRequestedAt = run.cancelRequestedAt ?? now;
      run.updatedAt = now;

      if (run.status === RunStatus.QUEUED) {
        run.status = RunStatus.CANCELLED;
        run.completedAt = now;
        run.leaseOwner = undefined;
        run.leaseExpiresAt = undefined;
      }

      await runStore.saveRun(run, context);
      await runStore.appendRunStep({
        id: generateRunStepResourceId({
          key: generateId('run-step'),
          runId: run.id,
          commandKind: run.commandKind,
          surfaceId: run.surfaceId,
          createdAt: now,
        }),
        commandKind: run.commandKind,
        surfaceId: run.surfaceId,
        runId: run.id,
        run: resolveRunResource(run, context),
        type: RunStepType.CANCEL_REQUESTED,
        message: 'Run cancellation requested',
        data: { status: run.status },
        createdAt: now,
      }, context);

      sendJson(response, 200, { run });
    } catch (error) {
      logger.error(`Failed to cancel run: ${error}`);
      sendJson(response, 404, { error: formatError(error) });
    }
  });
}

function parseRunListOptions(url: URL): RunListOptions {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  if (workspace && !isWorkspaceRef(workspace)) {
    throw new Error('workspace must be an http(s):// or file:// workspace reference');
  }

  return {
    task: url.searchParams.get('task') ?? undefined,
    thread: url.searchParams.get('thread') ?? undefined,
    workspace,
    commandKind: parseCommandKind(url.searchParams.get('commandKind')),
    status: parseRunStatus(url.searchParams.get('status')),
    limit: parseOptionalNumber(url.searchParams.get('limit')),
  };
}

function parseCommandKind(value: string | null): RunListOptions['commandKind'] {
  if (!value) {
    return undefined;
  }
  if (value === 'chat' || value === 'task') {
    return value;
  }
  throw new Error('commandKind must be chat or task');
}

function parseRunStatus(value: string | null): RunStatusType | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === RunStatus.QUEUED
    || value === RunStatus.RUNNING
    || value === RunStatus.WAITING_INPUT
    || value === RunStatus.WAITING_RUNNER
    || value === RunStatus.COMPLETED
    || value === RunStatus.FAILED
    || value === RunStatus.CANCELLED
  ) {
    return value;
  }
  throw new Error(`Unknown run status: ${value}`);
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildStoreContext(request: AuthenticatedRequest): StoreContext {
  const auth = request.auth;
  const userId = auth ? getWebId(auth) ?? getAccountId(auth) ?? 'anonymous' : 'anonymous';
  return {
    userId,
    auth,
  };
}

function resolveRunResource(run: RunRecordData, context: StoreContext): string {
  const auth = context.auth as { webId?: unknown } | undefined;
  const webId = typeof auth?.webId === 'string' ? auth.webId : undefined;
  const podBaseUrl = webId ? resolvePodBaseUrl(webId) : undefined;
  if (podBaseUrl) {
    return resolveDataResource(podBaseUrl, run.id);
  }
  return resolveRunUrn(run.id);
}

function resolvePodBaseUrl(webId: string): string | undefined {
  try {
    const url = new URL(webId);
    url.hash = '';
    url.search = '';
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (!normalizedPath.endsWith('/profile/card')) {
      return undefined;
    }
    url.pathname = normalizedPath.slice(0, -'/profile/card'.length) || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
