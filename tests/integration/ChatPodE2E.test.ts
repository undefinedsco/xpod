import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dns from 'node:dns';
import { drizzle, eq } from 'drizzle-solid';
import { Session } from '@inrupt/solid-client-authn-node';
import { ApiServer } from '../../src/api/ApiServer';
import { VercelChatService } from '../../src/api/service/VercelChatService';
import { InternalPodService } from '../../src/api/service/InternalPodService';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { ClientCredentialsAuthenticator } from '../../src/api/auth/ClientCredentialsAuthenticator';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { Provider } from '../../src/embedding/schema/tables';
import { Credential } from '../../src/credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../src/credential/schema/types';

/**
 * Chat Pod E2E Integration Test
 * 
 * This test validates the full chat completion flow with REAL authentication:
 * 1. Login to CSS with client credentials
 * 2. Write AI provider config (with proxy) to Pod
 * 3. Write credential (API key) to Pod
 * 4. Call Chat API with API Key (Bearer sk-xxx)
 * 5. Real AI request via proxy to Google Gemini
 * 
 * Requirements:
 * - XPOD_RUN_INTEGRATION_TESTS=true
 * - GOOGLE_API_KEY
 * - TEST_AI_PROXY_URL (proxy to access Google API)
 * - Running CSS server with valid SOLID_CLIENT_ID/SECRET
 * - Proxy server running (for AI call tests)
 */

const googleApiKey = process.env.GOOGLE_API_KEY;
const proxyUrl = process.env.TEST_AI_PROXY_URL;
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const cssBaseUrl = process.env.CSS_BASE_URL || 'http://localhost:3000';

const hasRequiredConfig = !!(googleApiKey && proxyUrl && clientId && clientSecret);
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && hasRequiredConfig;

// Force IPv4 to avoid Node.js dual-stack timeouts
dns.setDefaultResultOrder('ipv4first');

const schema = {
  credential: Credential,
  provider: Provider,
};

describe.skipIf(!shouldRun)('Chat Pod E2E Integration (Real Google AI via Proxy)', () => {
  let server: ApiServer;
  let session: Session;
  let db: ReturnType<typeof drizzle>;
  let apiKey: string; // Generated API Key: sk-{base64(client_id:client_secret)}
  let proxyAvailable = false;
  const port = 3107;
  const baseUrl = `http://localhost:${port}`;
  const testProviderId = 'google-e2e-test';
  const testCredentialId = 'google-cred-e2e-test';

  beforeAll(async () => {
    // Generate API Key from client credentials
    apiKey = ClientCredentialsAuthenticator.generateApiKey(clientId!, clientSecret!);
    console.log(`[E2E] Generated API Key: ${apiKey.slice(0, 20)}...`);

    // 0. Check if proxy is available
    if (proxyUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeout);
        proxyAvailable = true;
        console.log(`[E2E] Proxy ${proxyUrl} is available`);
      } catch {
        proxyAvailable = false;
        console.log(`[E2E] Proxy ${proxyUrl} is NOT available - AI call tests will be skipped`);
      }
    }

    // 1. Login to CSS and get authenticated session
    session = new Session();
    await session.login({
      oidcIssuer: cssBaseUrl,
      clientId: clientId!,
      clientSecret: clientSecret!,
    });

    if (!session.info.isLoggedIn || !session.info.webId) {
      throw new Error('Failed to login to CSS');
    }

    const webId = session.info.webId;
    console.log(`[E2E] Logged in as ${webId}`);

    // 2. Create drizzle instance to write to Pod
    db = drizzle(
      { fetch: session.fetch.bind(session), info: { webId, isLoggedIn: true } } as any,
      { schema }
    );

    // 3. Clean up any existing test data first
    try {
      await db.delete(Credential).where(eq(Credential.id, testCredentialId));
      await db.delete(Provider).where(eq(Provider.id, testProviderId));
    } catch {
      // Ignore errors if data doesn't exist
    }

    // 4. Write provider config with proxy to Pod
    await db.insert(Provider).values({
      id: testProviderId,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      proxyUrl: proxyUrl!,
    });
    console.log(`[E2E] Written provider ${testProviderId} with proxy ${proxyUrl}`);

    // 5. Write credential with API key to Pod
    const podBaseUrl = webId.replace(/\/profile\/card#me$/, '/');
    const providerUri = `${podBaseUrl}settings/ai/providers.ttl#${testProviderId}`;
    
    await db.insert(Credential).values({
      id: testCredentialId,
      provider: providerUri,
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: googleApiKey!,
      label: 'E2E Test Google Credential',
    });
    console.log(`[E2E] Written credential ${testCredentialId}`);

    // 6. Setup API server with stateless API Key auth
    const tokenEndpoint = `${cssBaseUrl}/.oidc/token`;
    
    // ClientCredentialsAuthenticator (stateless - no store needed)
    const authenticator = new ClientCredentialsAuthenticator({
      tokenEndpoint,
    });

    const authMiddleware = new AuthMiddleware({ authenticator });

    // InternalPodService (no store needed, credentials from auth context)
    const podService = new InternalPodService({
      tokenEndpoint,
    });

    const chatService = new VercelChatService(podService);

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });

    await server.start();
    console.log(`[E2E] API server started on ${baseUrl} with stateless API Key auth`);
  });

  afterAll(async () => {
    // Cleanup: remove test data from Pod
    try {
      await db.delete(Credential).where(eq(Credential.id, testCredentialId));
      await db.delete(Provider).where(eq(Provider.id, testProviderId));
      console.log('[E2E] Cleaned up test data from Pod');
    } catch (e) {
      console.warn('[E2E] Failed to cleanup Pod data:', e);
    }

    await server?.stop();
    await session?.logout();
  });

  // ============================================
  // Authentication Tests (always run)
  // ============================================

  it('should reject request with invalid API Key', async () => {
    const invalidKey = ClientCredentialsAuthenticator.generateApiKey('invalid-client', 'wrong-secret');
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${invalidKey}`
      },
      body: JSON.stringify({ 
        model: 'gemini-2.0-flash', 
        messages: [{ role: 'user', content: 'Hello' }],
      })
    });

    expect(response.status).toBe(401);
    const data = await response.json() as any;
    expect(data.error).toBe('Unauthorized');
  });

  it('should authenticate successfully with valid API Key', async () => {
    // This test verifies authentication works, even if AI call fails due to proxy
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ 
        model: 'gemini-2.0-flash', 
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      })
    });

    // Should NOT be 401 (authentication passed)
    // May be 200 (success) or 500 (proxy error) depending on proxy availability
    expect(response.status).not.toBe(401);
    console.log(`[E2E] Authentication test: status=${response.status}`);
  }, 30000);

  // ============================================
  // AI Call Tests (require proxy)
  // ============================================

  it('should complete a chat request using API Key authentication', async () => {
    if (!proxyAvailable) {
      console.log('[E2E] Skipping AI call test - proxy not available');
      return;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ 
        model: 'gemini-2.0-flash', 
        messages: [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
        max_tokens: 10
      })
    });

    if (response.status !== 200) {
      const err = await response.json();
      console.error('[E2E Error]', JSON.stringify(err, null, 2));
    }

    expect(response.status).toBe(200);
    
    const data = await response.json() as any;
    expect(data.object).toBe('chat.completion');
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0].message.role).toBe('assistant');
    expect(data.choices[0].message.content).toBeTruthy();
    expect(data.choices[0].message.content.toUpperCase()).toContain('PONG');
  }, 60000);

  it('should handle streaming chat request with real authentication', async () => {
    if (!proxyAvailable) {
      console.log('[E2E] Skipping streaming test - proxy not available');
      return;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ 
        model: 'gemini-2.0-flash', 
        messages: [{ role: 'user', content: 'Reply with exactly: STREAM OK' }],
        stream: true,
        max_tokens: 20
      })
    });

    if (response.status !== 200) {
      const err = await response.text();
      console.error('[E2E Streaming Error]', err);
    }

    expect(response.status).toBe(200);
    // AI SDK v6 toTextStreamResponse returns text/plain, not SSE
    expect(response.headers.get('content-type')).toContain('text/plain');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      fullContent += chunk;
    }

    expect(fullContent.length).toBeGreaterThan(0);
    console.log(`[E2E] Streaming response: ${fullContent}`);
  }, 60000);
});
