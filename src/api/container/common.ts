/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';
import { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../auth/ServiceTokenAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
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
        isSqlite: config.databaseUrl.startsWith('sqlite:'),
      });
    }).singleton(),

    // 认证
    serviceTokenRepo: asFunction(({ db }: ApiContainerCradle) => {
      return new ServiceTokenRepository(db);
    }).singleton(),

    authenticator: asFunction(({ nodeRepo, serviceTokenRepo, config }: ApiContainerCradle) => {
      const solidAuthenticator = new SolidTokenAuthenticator({
        resolveAccountId: async (webId) => webId,
      });

      const clientCredAuthenticator = new ClientCredentialsAuthenticator({
        tokenEndpoint: config.cssTokenEndpoint,
      });

      const nodeTokenAuthenticator = new NodeTokenAuthenticator({
        repository: nodeRepo,
      });

      const serviceTokenAuthenticator = new ServiceTokenAuthenticator({
        repository: serviceTokenRepo,
      });

      return new MultiAuthenticator({
        // Order: Solid DPoP → Service Token → Node Token → Client Credentials
        // ServiceTokenAuthenticator handles 'svc-' prefix, so no ambiguity
        authenticators: [solidAuthenticator, serviceTokenAuthenticator, nodeTokenAuthenticator, clientCredAuthenticator],
      });
    }).singleton(),

    authMiddleware: asFunction(({ authenticator }: ApiContainerCradle) => {
      return new AuthMiddleware({ authenticator });
    }).singleton(),

    // ChatKit 存储与服务
    chatKitStore: asFunction(({ config }: ApiContainerCradle) => {
      return new PodChatKitStore({
        tokenEndpoint: config.cssTokenEndpoint,
      });
    }).singleton(),

    chatKitAiProvider: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new VercelAiProvider({ store: chatKitStore });
    }).singleton(),

    chatKitService: asFunction(({ chatKitStore, chatKitAiProvider, config }: ApiContainerCradle) => {
      return new ChatKitService({
        store: chatKitStore,
        aiProvider: chatKitAiProvider,
        enablePtyRuntime: config.edition === 'local',
      });
    }).singleton(),

    // 业务服务
    chatService: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new VercelChatService(chatKitStore);
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
