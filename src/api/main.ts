#!/usr/bin/env node
/**
 * API Service Entry Point
 *
 * Starts the standalone API server separate from the CSS main process.
 * 
 * Authentication:
 * - Solid DPoP Token: for browser/frontend users
 * - Client Credentials (client_id + client_secret): for edge nodes and third-party backends
 */

import { getIdentityDatabase } from '../identity/drizzle/db';

import { ApiServer } from './ApiServer';
import { AuthMiddleware } from './middleware/AuthMiddleware';
import { SolidTokenAuthenticator } from './auth/SolidTokenAuthenticator';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

import { registerSignalRoutes } from './handlers/SignalHandler';
import { registerNodeRoutes } from './handlers/NodeHandler';
import { registerChatRoutes } from './handlers/ChatHandler';
import { registerApiKeyRoutes } from './handlers/ApiKeyHandler';
import { registerVectorRoutes } from './handlers/VectorHandler';
import { registerVectorStoreRoutes } from './handlers/VectorStoreHandler';
import { DrizzleClientCredentialsStore } from './store/DrizzleClientCredentialsStore';
import { ClientCredentialsAuthenticator } from './auth/ClientCredentialsAuthenticator';
import { MultiAuthenticator } from './auth/MultiAuthenticator';
import { InternalPodService } from './service/InternalPodService';
import { VercelChatService } from './service/VercelChatService';
import { VectorService } from './service/VectorService';
import { VectorStoreService } from './service/VectorStoreService';
import { EmbeddingServiceImpl } from '../embedding/EmbeddingServiceImpl';
import { ProviderRegistryImpl } from '../embedding/ProviderRegistryImpl';

// Simple logger to avoid Components.js dependency
const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
};

async function main(): Promise<void> {
  const port = parseInt(process.env.API_PORT ?? '3001', 10);
  const host = process.env.API_HOST ?? '0.0.0.0';
  const databaseUrl = process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL;
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? ['*'];
  const encryptionKey = process.env.XPOD_ENCRYPTION_KEY ?? 'default-dev-key-change-me';
  const cssTokenEndpoint = process.env.CSS_TOKEN_ENDPOINT ?? 'http://localhost:3000/.oidc/token';
  const webhookUrl = process.env.VECTOR_STORE_WEBHOOK_URL; // e.g., https://api.example.com/v1/vector_stores/webhook

  if (!databaseUrl) {
    logger.error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
    process.exit(1);
  }

  logger.info('Starting API Service...');

  const db = getIdentityDatabase(databaseUrl);

  const nodeRepo = new EdgeNodeRepository(db);
  const apiKeyStore = new DrizzleClientCredentialsStore({ db, encryptionKey });

  // Setup authenticators
  // 1. Solid DPoP Token - for browser/frontend
  // No need to resolve accountId - use webId directly
  const solidAuthenticator = new SolidTokenAuthenticator({});

  // 2. Client Credentials - for edge nodes and third-party backends
  const clientCredAuthenticator = new ClientCredentialsAuthenticator({
    store: apiKeyStore,
    tokenEndpoint: cssTokenEndpoint,
  });

  const multiAuthenticator = new MultiAuthenticator({
    authenticators: [solidAuthenticator, clientCredAuthenticator],
  });

  const authMiddleware = new AuthMiddleware({
    authenticator: multiAuthenticator,
  });

  // Setup AI services
  const podService = new InternalPodService({
    tokenEndpoint: cssTokenEndpoint,
    apiKeyStore: apiKeyStore,
  });
  const chatService = new VercelChatService(podService);

  // Setup Vector services
  const cssBaseUrl = process.env.CSS_BASE_URL ?? 'http://localhost:3000';
  const providerRegistry = new ProviderRegistryImpl();
  const embeddingService = new EmbeddingServiceImpl(providerRegistry);
  const vectorService = new VectorService({
    cssBaseUrl,
    podService,
    embeddingService,
  });

  // Setup Vector Store service (OpenAI compatible)
  const vectorStoreService = new VectorStoreService({
    cssBaseUrl,
    tokenEndpoint: cssTokenEndpoint,
    apiKeyStore,
    embeddingService,
    webhookUrl,
  });

  // Create server
  const server = new ApiServer({
    port,
    host,
    authMiddleware,
    corsOrigins,
  });

  // Public health check endpoints
  server.get('/health', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  }, { public: true });

  server.get('/ready', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ready' }));
  }, { public: true });

  // Register API routes
  registerSignalRoutes(server, { repository: nodeRepo });
  registerNodeRoutes(server, { repository: nodeRepo });
  registerApiKeyRoutes(server, { store: apiKeyStore });
  registerChatRoutes(server, { chatService });
  registerVectorRoutes(server, { vectorService });
  registerVectorStoreRoutes(server, { vectorStoreService });

  // Start server
  await server.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`API Service listening on ${host}:${port}`);
}

main().catch((error) => {
  logger.error(`Failed to start API Service: ${error}`);
  process.exit(1);
});
