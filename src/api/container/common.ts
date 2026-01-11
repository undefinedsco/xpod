/**
 * 共享服务注册
 * 
 * cloud 和 local 模式都需要的服务
 */

import { asClass, asFunction, asValue, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
import { InternalPodService } from '../service/InternalPodService';
import { VercelChatService } from '../service/VercelChatService';
import { ApiServer } from '../ApiServer';
import { ChatKitService, PodChatKitStore, VercelAiProvider } from '../chatkit';

/**
 * 注册共享服务到容器
 */
export function registerCommonServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  container.register({
    // 数据库
    db: asFunction(({ config }: ApiContainerCradle) => {
      return getIdentityDatabase(config.databaseUrl);
    }).singleton(),

    // 仓库
    nodeRepo: asFunction(({ db }: ApiContainerCradle) => {
      return new EdgeNodeRepository(db);
    }).singleton(),

    apiKeyStore: asFunction(({ db, config }: ApiContainerCradle) => {
      return new DrizzleClientCredentialsStore({
        db,
        encryptionKey: config.encryptionKey,
      });
    }).singleton(),

    // 认证
    authenticator: asFunction(({ apiKeyStore, config }: ApiContainerCradle) => {
      const solidAuthenticator = new SolidTokenAuthenticator({
        resolveAccountId: async (webId) => webId,
      });

      const clientCredAuthenticator = new ClientCredentialsAuthenticator({
        store: apiKeyStore,
        tokenEndpoint: config.cssTokenEndpoint,
      });

      return new MultiAuthenticator({
        authenticators: [solidAuthenticator, clientCredAuthenticator],
      });
    }).singleton(),

    authMiddleware: asFunction(({ authenticator }: ApiContainerCradle) => {
      return new AuthMiddleware({ authenticator });
    }).singleton(),

    // 业务服务
    podService: asFunction(({ apiKeyStore, config }: ApiContainerCradle) => {
      return new InternalPodService({
        tokenEndpoint: config.cssTokenEndpoint,
        apiKeyStore,
      });
    }).singleton(),

    chatService: asFunction(({ podService }: ApiContainerCradle) => {
      return new VercelChatService(podService);
    }).singleton(),

    // ChatKit 服务 (OpenAI ChatKit 协议)
    chatKitStore: asFunction(({ config }: ApiContainerCradle) => {
      return new PodChatKitStore({
        tokenEndpoint: config.cssTokenEndpoint,
      });
    }).singleton(),

    chatKitAiProvider: asFunction(({ podService }: ApiContainerCradle) => {
      return new VercelAiProvider({ podService });
    }).singleton(),

    chatKitService: asFunction(({ chatKitStore, chatKitAiProvider }: ApiContainerCradle) => {
      return new ChatKitService({
        store: chatKitStore,
        aiProvider: chatKitAiProvider,
      });
    }).singleton(),

    // API Server
    apiServer: asFunction(({ config, authMiddleware }: ApiContainerCradle) => {
      return new ApiServer({
        port: config.port,
        host: config.host,
        authMiddleware,
        corsOrigins: config.corsOrigins,
      });
    }).singleton(),
  });
}
