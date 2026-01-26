import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import dns from 'node:dns';
import { ApiServer } from '../../src/api/ApiServer';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import { VercelChatService } from '../../src/api/service/VercelChatService';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

// This test requires a running CSS server on localhost:3000
// Run with: XPOD_RUN_INTEGRATION_TESTS=true yarn test tests/integration/ChatPodE2E.test.ts
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';

// HACK: Force localhost to IPv4 127.0.0.1 to avoid Node.js 18+ dual-stack timeouts
// This fixes the 'outgoing request timed out' during OIDC discovery
// Note: Node 22+ may use lookupService internally, so we patch more carefully
const originalLookup = dns.lookup.bind(dns);
Object.defineProperty(dns, 'lookup', {
  value: function lookup(
    hostname: string,
    options?: any,
    callback?: any
  ) {
    // Normalize: options might be callback in 2-arg form
    let opts = options;
    let cb = callback;
    if (typeof options === 'function') {
      cb = options;
      opts = undefined;
    }

    if (hostname === 'localhost') {
      // For localhost, always return IPv4
      if (cb) {
        process.nextTick(() => cb(null, '127.0.0.1', 4));
        return;
      }
    }

    // Pass through to original
    return originalLookup(hostname, opts, cb);
  },
  writable: true,
  configurable: true
});

describe.skip('Chat Pod E2E Integration (Real Network)', () => {
  let server: ApiServer;
  let mockAIServer: Server;
  const port = 3107;
  const aiPort = 4002;
  const baseUrl = `http://localhost:${port}`;

  let lastAIRequest: any = null;

  beforeAll(async () => {
    // 1. Setup Mock AI Server (We mock the AI provider to save money/tokens)
    mockAIServer = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        lastAIRequest = {
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body)
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_e2e',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          output: [
            {
              id: 'msg_e2e',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Real E2E Response', annotations: [] }]
            }
          ],
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 }
        }));
      });
    }).listen(aiPort);

    // 2. Setup Services with PodChatKitStore
    // We expect CSS to be running on localhost:3000
    const store = new PodChatKitStore({
      tokenEndpoint: 'http://localhost:3000/.oidc/token',
    });

    // We still mock the Pod DATA response because we don't want to rely on
    // actually writing RDF files to the running CSS server.
    // BUT, the LOGIN process will be REAL.
    // We intercept fetch ONLY for the data read, not the login.
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const u = url.toString();
      // Intercept Pod Data Read
      if (u.includes('/.data/model-providers/')) {
        if (u.includes('/-/sparql')) {
          const method = init?.method?.toUpperCase() ?? 'GET';
          const queryFromUrl = (() => {
            try {
              return new URL(u).searchParams.get('query') ?? '';
            } catch {
              return '';
            }
          })();
          const body = (() => {
            const raw = init?.body;
            if (typeof raw === 'string') {
              return raw;
            }
            if (raw instanceof URLSearchParams) {
              return raw.toString();
            }
            if (raw instanceof Uint8Array) {
              return Buffer.from(raw).toString('utf8');
            }
            return '';
          })();
          const combined = `${queryFromUrl} ${body}`.toUpperCase();
          if (combined.includes('ASK') || method === 'HEAD') {
            return new Response(JSON.stringify({ boolean: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/sparql-results+json' }
            });
          }
        }
        console.log('[E2E] Intercepting Pod Data Read:', u);
        return new Response(`
            @prefix linx: <https://linx.ai/ns#> .
            <http://localhost:3000/test/.data/model-providers/openai#it> a linx:ModelProvider ;
              <https://linx.ai/ns#provider> "openai" ;
              <https://linx.ai/ns#status> true ;
              <https://linx.ai/ns#apiKey> "sk-real-e2e-key" ;
              <https://linx.ai/ns#baseUrl> "http://localhost:${aiPort}/v1" .
          `, {
            status: 200,
            headers: { 'Content-Type': 'text/turtle' }
          });
      }
      return originalFetch(url, init);
    };

    const chatService = new VercelChatService(store);

    // 3. Setup API Server
    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: true,
          // This context simulates a user calling the API with an API Key
          context: { type: 'solid', clientId: 'test-client', webId: 'http://localhost:3000/test/profile/card#me', viaApiKey: true }
        })
      } as any
    });

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    mockAIServer.close();
    // Restore DNS (optional but good practice)
    (dns as any).lookup = originalLookup;
  });

  it('should perform real login and simulated data fetch', async () => {
    // This request triggers:
    // 1. ChatHandler -> VercelChatService -> PodChatKitStore.getAiConfig
    // 2. PodChatKitStore -> session.login() -> REAL NETWORK to localhost:3000
    // 3. PodChatKitStore -> drizzle -> fetch() -> INTERCEPTED (returns Turtle)
    // 4. VercelChatService -> OpenAI -> REAL NETWORK to localhost:4002

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer any' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'ping' }] })
    });

    if (response.status !== 200) {
      const err = await response.json();
      console.error('[E2E Error]', JSON.stringify(err, null, 2));
    }

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.choices[0].message.content).toBe('Real E2E Response');

    // Verify that the key from our INTERCEPTED turtle was used in the REAL request to mock AI
    expect(lastAIRequest.headers.authorization).toBe('Bearer sk-real-e2e-key');
  }, 10000); // 10s timeout for real network
});
