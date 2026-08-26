import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatKitRoutes } from '../../src/api/handlers/ChatKitHandler';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';

class RecordingRuntimeBackend implements RunExecutionBackend {
  public readonly inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    yield { type: 'text', text: 'ok' };
  }
}

class ToolContinuationRuntimeBackend implements RunExecutionBackend {
  public readonly inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    if (!input.continuation) {
      yield {
        type: 'tool_call',
        requestId: 'handler-tool-request',
        name: 'pick_file',
        arguments: JSON.stringify({ prompt: 'choose file' }),
      };
      return;
    }
    yield { type: 'text', text: 'continued over HTTP' };
  }
}

const authMiddleware = new AuthMiddleware({
  authenticator: {
    canAuthenticate: () => true,
    authenticate: async () => ({
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-1' },
    }),
  } as any,
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const address = tester.address();
      if (!address || typeof address === 'string') {
        tester.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      const port = address.port;
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

describe('ChatKitHandler Integration', () => {
  let server: ApiServer;
  let baseUrl: string;

  const chatKitService = {
    process: vi.fn(),
  };


  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatKitRoutes(server, {
      chatKitService: chatKitService as any,
    });
    await server.start();
  });

  beforeEach(() => {
    chatKitService.process.mockReset();
    chatKitService.process.mockResolvedValue({
      type: 'non-streaming',
      json: JSON.stringify({ ok: true }),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('forwards request to chatkit service', async () => {
    const body = {
      type: 'threads.add_user_message',
      messages: [
        { role: 'user', content: '请保存我的 key: sk-test-12345678901234567890' },
      ],
    };

    const response = await fetch(baseUrl + '/v1/chatkit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(chatKitService.process).toHaveBeenCalledTimes(1);
  });

  it('runs from the authenticated handler context without a transient Gateway key', async () => {
    const port = await getFreePort();
    const runtimeServer = new ApiServer({ port, authMiddleware });
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRuntimeBackend();
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    registerChatKitRoutes(runtimeServer, { chatKitService: service });
    await runtimeServer.start();

    try {
      const response = await fetch(`http://localhost:${port}/v1/chatkit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({
          type: 'threads.create',
          params: {
            workspace: `file://localhost${process.cwd()}`,
            input: {
              content: [{ type: 'input_text', text: 'run securely' }],
            },
          },
          metadata: {
            runtime: {
              runner: { type: 'pi', protocol: 'pi' },
            },
          },
        }),
      });
      await response.text();

      expect(response.status).toBe(200);
      expect(backend.inputs[0].context?.auth).toMatchObject({
        type: 'solid',
        webId: 'https://example.com/user#me',
      });
      expect(backend.inputs[0].context).toEqual(expect.objectContaining({
        auth: expect.objectContaining({
          type: 'solid',
          webId: 'https://example.com/user#me',
        }),
      }));
      const run = await store.loadRun(backend.inputs[0].runId, {
        userId: 'https://example.com/user#me',
        auth: {
          type: 'solid',
          webId: 'https://example.com/user#me',
          accountId: 'user-1',
        },
      });
    } finally {
      await runtimeServer.stop();
    }
  });

  it('validates HTTP client-tool continuation before runtime execution', async () => {
    const port = await getFreePort();
    const runtimeServer = new ApiServer({ port, authMiddleware });
    const store = new InMemoryStore<StoreContext>();
    const backend = new ToolContinuationRuntimeBackend();
    const claimContinuation = store.claimClientToolContinuation.bind(store);
    let successfulClaims = 0;
    vi.spyOn(store, 'claimClientToolContinuation').mockImplementation(async (...args) => {
      const claim = await claimContinuation(...args);
      if (claim) {
        successfulClaims += 1;
      }
      return claim;
    });
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    registerChatKitRoutes(runtimeServer, { chatKitService: service });
    await runtimeServer.start();

    try {
      const createResponse = await fetch(`http://localhost:${port}/v1/chatkit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({
          type: 'threads.create',
          params: {
            workspace: `file://localhost${process.cwd()}`,
            input: { content: [{ type: 'input_text', text: 'needs a tool' }] },
          },
          metadata: {
            runtime: {
              runner: { type: 'codex', protocol: 'acp' },
            },
          },
        }),
      });
      const createEvents = parseSse(await createResponse.text());
      const threadId = createEvents.find((event) => event.type === 'thread.created')?.thread.id;
      const toolItem = createEvents.find(
        (event) => event.type === 'thread.item.added' && event.item?.type === 'client_tool_call',
      )?.item;

      const continueRequest = {
        type: 'threads.add_client_tool_output',
        params: {
          thread_id: threadId,
          item_id: toolItem.id,
          output: 'README.md',
        },
      };
      const sendContinuation = async (): Promise<Response> => fetch(`http://localhost:${port}/v1/chatkit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify(continueRequest),
      });
      const [continueResponse, competingResponse] = await Promise.all([
        sendContinuation(),
        sendContinuation(),
      ]);
      const continuationBodies = await Promise.all([
        continueResponse.text(),
        competingResponse.text(),
      ]);
      expect([continueResponse.status, competingResponse.status]).toEqual([200, 200]);
      expect(continuationBodies.flatMap(parseSse)).toContainEqual(expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          code: 'client_tool_output_conflict',
        }),
      }));
      expect(backend.inputs[1].continuation).toEqual({
        kind: 'client_tool_output',
        itemId: toolItem.id,
      });
      expect(successfulClaims).toBe(1);

      const replayResponse = await sendContinuation();
      await replayResponse.text();
      expect(backend.inputs).toHaveLength(2);
      expect(successfulClaims).toBe(1);
    } finally {
      await runtimeServer.stop();
    }
  });
});

function parseSse(body: string): any[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}
