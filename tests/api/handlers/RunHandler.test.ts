import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerRunRoutes } from '../../../src/api/handlers/RunHandler';
import { RunStepType, RunStatus } from '../../../src/api/runs/schema';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';

type CapturedRoute = {
  method: string;
  path: string;
  handler: Function;
};

function createMockServer(): { server: ApiServer; routes: Record<string, CapturedRoute> } {
  const routes: Record<string, CapturedRoute> = {};
  const server = {
    get: vi.fn((path: string, handler: Function) => {
      routes[`GET ${path}`] = { method: 'GET', path, handler };
    }),
    post: vi.fn((path: string, handler: Function) => {
      routes[`POST ${path}`] = { method: 'POST', path, handler };
    }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createRequest(url: string): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.url = url;
  req.headers = { host: 'localhost' };
  req.auth = {
    type: 'solid',
    webId: 'http://localhost/alice/profile/card#me',
  } as any;
  return req;
}

function createResponse(): {
  response: any;
  body(): unknown;
} {
  let text = '';
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      text += chunk ?? '';
    },
  };
  return {
    response,
    body: () => JSON.parse(text),
  };
}

describe('RunHandler', () => {
  it('lists Runs with URI filters from RunStore', async () => {
    const { server, routes } = createMockServer();
    const runId = 'task/default/2026/05/18/runs.ttl#run_1';
    const runStore = {
      listRuns: vi.fn(async () => [{
        id: runId,
        thread: 'http://localhost/alice/.data/chat/default/index.ttl#thread_1',
        workspace: 'file://localhost/tmp/xpod',
        status: RunStatus.COMPLETED,
        runner: 'pi:pi',
        createdAt: 100,
        updatedAt: 101,
      }]),
      loadRun: vi.fn(),
      loadRunSteps: vi.fn(),
      saveRun: vi.fn(async () => {}),
      appendRunStep: vi.fn(async () => {}),
    };
    registerRunRoutes(server, { runStore });

    const { response, body } = createResponse();
    await routes['GET /v1/runs'].handler(
      createRequest('/v1/runs?commandKind=task&status=completed&workspace=file%3A%2F%2Flocalhost%2Ftmp%2Fxpod&limit=5'),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(runStore.listRuns).toHaveBeenCalledWith({
      task: undefined,
      thread: undefined,
      workspace: 'file://localhost/tmp/xpod',
      status: RunStatus.COMPLETED,
      limit: undefined,
    }, expect.objectContaining({
      userId: 'http://localhost/alice/profile/card#me',
    }));
    expect(body()).toEqual({
      runs: [{
        id: runId,
        thread: 'http://localhost/alice/.data/chat/default/index.ttl#thread_1',
        workspace: 'file://localhost/tmp/xpod',
        commandKind: 'task',
        surfaceId: 'default',
        status: RunStatus.COMPLETED,
        runner: 'pi:pi',
        createdAt: 100,
        updatedAt: 101,
      }],
    });
  });

  it('loads Run steps by run id', async () => {
    const { server, routes } = createMockServer();
    const runId = 'chat/default/2026/05/18/runs.ttl#run_1';
    const stepId = 'chat/default/2026/05/18/runs.ttl#step_1';
    const runStore = {
      listRuns: vi.fn(),
      loadRun: vi.fn(),
      loadRunSteps: vi.fn(async () => [{
        id: stepId,
        runId,
        run: 'http://localhost/alice/.data/chat/default/2026/05/18/runs.ttl#run_1',
        type: RunStepType.STARTED,
        message: 'Run started',
        createdAt: 100,
      }]),
      saveRun: vi.fn(async () => {}),
      appendRunStep: vi.fn(async () => {}),
    };
    registerRunRoutes(server, { runStore });

    const { response, body } = createResponse();
    await routes['GET /v1/runs/:runId/steps'].handler(
      createRequest('/v1/runs/' + encodeURIComponent(runId) + '/steps'),
      response,
      { runId: encodeURIComponent(runId) },
    );

    expect(response.statusCode).toBe(200);
    expect(runStore.loadRunSteps).toHaveBeenCalledWith(runId, expect.objectContaining({
      userId: 'http://localhost/alice/profile/card#me',
    }));
    expect(body()).toEqual({
      steps: [{
        id: stepId,
        commandKind: 'chat',
        surfaceId: 'default',
        runId,
        run: 'http://localhost/alice/.data/chat/default/2026/05/18/runs.ttl#run_1',
        type: RunStepType.STARTED,
        message: 'Run started',
        createdAt: 100,
      }],
    });
  });

  it('requests cancellation for a queued Run and appends a cancellation step', async () => {
    const { server, routes } = createMockServer();
    const runId = 'chat/default/2026/05/18/runs.ttl#run_1';
    const savedRuns: any[] = [];
    const savedSteps: any[] = [];
    const runStore = {
      listRuns: vi.fn(),
      loadRun: vi.fn(async () => ({
        id: runId,
        thread: 'http://localhost/alice/.data/chat/default/index.ttl#thread_1',
        workspace: 'file://localhost/tmp/xpod',
        status: RunStatus.QUEUED,
        runner: 'pi:pi',
        createdAt: 100,
        updatedAt: 101,
      })),
      loadRunSteps: vi.fn(),
      saveRun: vi.fn(async (run) => {
        savedRuns.push(run);
      }),
      appendRunStep: vi.fn(async (step) => {
        savedSteps.push(step);
      }),
    };
    registerRunRoutes(server, { runStore });

    const { response, body } = createResponse();
    await routes['POST /v1/runs/:runId/cancel'].handler(
      createRequest('/v1/runs/' + encodeURIComponent(runId) + '/cancel'),
      response,
      { runId: encodeURIComponent(runId) },
    );

    expect(response.statusCode).toBe(200);
    expect(savedRuns[0]).toMatchObject({
      id: runId,
      status: RunStatus.CANCELLED,
      cancelRequestedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
    expect(savedSteps[0]).toMatchObject({
      runId,
      type: RunStepType.CANCEL_REQUESTED,
      message: 'Run cancellation requested',
    });
    expect(body()).toEqual({
      run: expect.objectContaining({
        id: runId,
        status: RunStatus.CANCELLED,
      }),
    });
  });
});
