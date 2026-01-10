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
import { DrizzleClientCredentialsStore } from '../../src/api/store/DrizzleClientCredentialsStore';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { providerTable } from '../../src/embedding/schema/tables';
import { credentialTable } from '../../src/credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../src/credential/schema/types';

/**
 * Chat Pod E2E Integration Test
 * 
 * This test validates the full chat completion flow with REAL authentication:
 * 1. Register CSS client credentials in api_keys table
 * 2. Write AI provider config (with proxy) to Pod
 * 3. Write credential (API key) to Pod
 * 4. Call Chat API with Bearer client_id (real authentication)
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
const encryptionKey = process.env.XPOD_ENCRYPTION_KEY || 'test-encryption-key-for-e2e';

const hasRequiredConfig = !!(googleApiKey && proxyUrl && clientId && clientSecret);
const shouldRun = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && hasRequiredConfig;

// Force IPv4 to avoid Node.js dual-stack timeouts
dns.setDefaultResultOrder('ipv4first');

const schema = {
  credential: credentialTable,
  provider: providerTable,
};

describe.skipIf(!shouldRun)('Chat Pod E2E Integration (Real Google AI via Proxy)', () => {
  let server: ApiServer;
  let session: Session;
  let db: ReturnType<typeof drizzle>;
  let apiKeyStore: DrizzleClientCredentialsStore;
  let proxyAvailable = false;
  const port = 3107;
  const baseUrl = `http://localhost:${port}`;
  const testProviderId = 'google-e2e-test';
  const testCredentialId = 'google-cred-e2e-test';

  beforeAll(async () => {
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

    // 2. Setup identity database and api_keys store
    const identityDbUrl = process.env.CSS_IDENTITY_DB_URL || 'sqlite:./data/identity.sqlite';
    const identityDb = getIdentityDatabase(identityDbUrl);
    apiKeyStore = new DrizzleClientCredentialsStore({ db: identityDb, encryptionKey });

    // 3. Register CSS client credentials in api_keys table (THIS IS THE KEY STEP!)
    await apiKeyStore.store({
      clientId: clientId!,
      clientSecret: clientSecret!,
      webId: webId,
      accountId: 'e2e-test-account',
      displayName: 'E2E Test API Key',
    });
    console.log(`[E2E] Registered client credentials in api_keys table: ${clientId}`);

    // 4. Create drizzle instance to write to Pod
    db = drizzle(
      { fetch: session.fetch.bind(session), info: { webId, isLoggedIn: true } } as any,
      { schema }
    );

    // 5. Clean up any existing test data first
    try {
      await db.delete(credentialTable).where(eq(credentialTable.id, testCredentialId));
      await db.delete(providerTable).where(eq(providerTable.id, testProviderId));
    } catch {
      // Ignore errors if data doesn't exist
    }

    // 6. Write provider config with proxy to Pod
    await db.insert(providerTable).values({
      id: testProviderId,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      proxyUrl: proxyUrl!,
    });
    console.log(`[E2E] Written provider ${testProviderId} with proxy ${proxyUrl}`);

    // 7. Write credential with API key to Pod
    const podBaseUrl = webId.replace(/\/profile\/card#me$/, '/');
    const providerUri = `${podBaseUrl}settings/ai/providers.ttl#${testProviderId}`;
    
    await db.insert(credentialTable).values({
      id: testCredentialId,
      provider: providerUri,
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: googleApiKey!,
      label: 'E2E Test Google Credential',
    });
    console.log(`[E2E] Written credential ${testCredentialId}`);

    // 8. Setup API server with REAL authentication
    const tokenEndpoint = `${cssBaseUrl}/.oidc/token`;
    
    // Real ClientCredentialsAuthenticator using the api_keys store
    const authenticator = new ClientCredentialsAuthenticator({
      store: apiKeyStore,
      tokenEndpoint,
    });

    const authMiddleware = new AuthMiddleware({ authenticator });

    // Real InternalPodService
    const podService = new InternalPodService({
      tokenEndpoint,
      apiKeyStore,
    });

    const chatService = new VercelChatService(podService);

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });

    await server.start();
    console.log(`[E2E] API server started on ${baseUrl} with REAL authentication`);
  });

  afterAll(async () => {
    // Cleanup: remove test data from Pod
    try {
      await db.delete(credentialTable).where(eq(credentialTable.id, testCredentialId));
      await db.delete(providerTable).where(eq(providerTable.id, testProviderId));
      console.log('[E2E] Cleaned up test data from Pod');
    } catch (e) {
      console.warn('[E2E] Failed to cleanup Pod data:', e);
    }

    // Cleanup: remove client credentials from api_keys table
    try {
      await apiKeyStore.delete(clientId!);
      console.log('[E2E] Cleaned up api_keys table');
    } catch (e) {
      console.warn('[E2E] Failed to cleanup api_keys:', e);
    }

    await server?.stop();
    await session?.logout();
  });

  // ============================================
  // Authentication Tests (always run)
  // ============================================

  it('should reject request with invalid client_id', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': 'Bearer invalid-client-id-12345' 
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

  it('should authenticate successfully with valid client_id', async () => {
    // This test verifies authentication works, even if AI call fails due to proxy
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${clientId}` 
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

  it('should complete a chat request using Bearer client_id authentication', async () => {
    if (!proxyAvailable) {
      console.log('[E2E] Skipping AI call test - proxy not available');
      return;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${clientId}` 
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
        'Authorization': `Bearer ${clientId}` 
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
