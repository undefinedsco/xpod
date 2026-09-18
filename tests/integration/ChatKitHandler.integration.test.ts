import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

function listeningBaseUrl(server: ApiServer): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a listening TCP server');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('ChatKitHandler Integration', () => {
  let server: ApiServer;
  let baseUrl: string;

  const chatKitService = {
    process: vi.fn(),
  };


  beforeAll(async () => {
    server = new ApiServer({ host: '127.0.0.1', port: 0, authMiddleware });
    registerChatKitRoutes(server, {
      chatKitService: chatKitService as any,
    });
    await server.start();
    baseUrl = listeningBaseUrl(server);
  });

  beforeEach(() => {
    chatKitService.process.mockReset();
    chatKitService.process.mockResolvedValue({
      type: 'non-streaming',
      json: JSON.stringify({ ok: true }),
    });
  });

  afterAll(async () => {
    if (server?.address()) await server.stop();
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

  it('issues a transient key from the authenticated handler context before runtime execution', async () => {
    const runtimeServer = new ApiServer({ host: '127.0.0.1', port: 0, authMiddleware });
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRuntimeBackend();
    const issuer = {
      issue: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:3000/v1',
        apiKey: 'handler-invocation-secret',
        model: 'linx',
      })),
    };
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
      aiConnectionInvocationKeyIssuer: issuer,
      requireAiConnectionsInvocationKeyIssuer: true,
    });
    registerChatKitRoutes(runtimeServer, { chatKitService: service });
    await runtimeServer.start();
    const runtimeBaseUrl = listeningBaseUrl(runtimeServer);

    try {
      const response = await fetch(`${runtimeBaseUrl}/v1/chatkit`, {
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
              aiConnection: {
                baseUrl: 'http://127.0.0.1:3000/v1',
                model: 'linx',
              },
            },
          },
        }),
      });
      await response.text();

      expect(response.status).toBe(200);
      expect(issuer.issue).toHaveBeenCalledWith(expect.objectContaining({
        auth: expect.objectContaining({
          type: 'solid',
          webId: 'https://example.com/user#me',
        }),
      }));
      expect(backend.inputs[0].config.aiConnection?.apiKey).toBe('handler-invocation-secret');
      const run = await store.loadRun(backend.inputs[0].runId, {
        userId: 'https://example.com/user#me',
        auth: {
          type: 'solid',
          webId: 'https://example.com/user#me',
          accountId: 'user-1',
        },
      });
      expect(JSON.stringify(run.metadata)).not.toContain('handler-invocation-secret');
      expect(JSON.stringify(run.metadata)).not.toContain('apiKey');
    } finally {
      await runtimeServer.stop();
    }
  });

  it('validates HTTP client-tool continuation before issuing its transient runtime key', async () => {
    const runtimeServer = new ApiServer({ host: '127.0.0.1', port: 0, authMiddleware });
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
    let issued = 0;
    const issuer = {
      issue: vi.fn(async () => {
        const invocation = ++issued;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          baseUrl: 'http://127.0.0.1:3000/v1',
          apiKey: `handler-continuation-${invocation}`,
        };
      }),
    };
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
      aiConnectionInvocationKeyIssuer: issuer,
      requireAiConnectionsInvocationKeyIssuer: true,
    });
    registerChatKitRoutes(runtimeServer, { chatKitService: service });
    await runtimeServer.start();
    const runtimeBaseUrl = listeningBaseUrl(runtimeServer);

    try {
      const createResponse = await fetch(`${runtimeBaseUrl}/v1/chatkit`, {
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
              aiConnection: { baseUrl: 'http://127.0.0.1:3000/v1' },
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
      const sendContinuation = async (): Promise<Response> => fetch(`${runtimeBaseUrl}/v1/chatkit`, {
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
      expect(backend.inputs[1].config.aiConnection?.apiKey).toBe('handler-continuation-2');
      expect(successfulClaims).toBe(1);

      const replayResponse = await sendContinuation();
      await replayResponse.text();
      expect(issuer.issue).toHaveBeenCalledTimes(2);
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
