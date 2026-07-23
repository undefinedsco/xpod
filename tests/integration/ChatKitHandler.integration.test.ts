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

  it('issues a transient key from the authenticated handler context before runtime execution', async () => {
    const port = await getFreePort();
    const runtimeServer = new ApiServer({ port, authMiddleware });
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRuntimeBackend();
    const issuer = {
      issue: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:3000/v1',
        gatewayKey: 'handler-invocation-secret',
        model: 'linx',
      })),
    };
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
      aiConnectionInvocationKeyIssuer: issuer,
      requireAiConnectionInvocationKeyIssuer: true,
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
      expect(backend.inputs[0].config.aiConnection?.gatewayKey).toBe('handler-invocation-secret');
      const run = await store.loadRun(backend.inputs[0].runId, {
        userId: 'https://example.com/user#me',
        auth: {
          type: 'solid',
          webId: 'https://example.com/user#me',
          accountId: 'user-1',
        },
      });
      expect(JSON.stringify(run.metadata)).not.toContain('handler-invocation-secret');
      expect(JSON.stringify(run.metadata)).not.toContain('gatewayKey');
    } finally {
      await runtimeServer.stop();
    }
  });
});
