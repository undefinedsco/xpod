/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
import { VercelChatService } from '../service/VercelChatService';
import { ApiServer } from '../ApiServer';
import { ChatKitService, PodChatKitStore, VercelAiProvider } from '../chatkit';
import { IntentRecognitionService, IntentStorageService } from '../../ai/service';
import { SmartInputPipelineService } from '../service/SmartInputPipelineService';

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
        isSqlite: config.databaseUrl.startsWith('sqlite:'),
      });
    }).singleton(),

    // 认证
    authenticator: asFunction(({ apiKeyStore, nodeRepo, config }: ApiContainerCradle) => {
      const solidAuthenticator = new SolidTokenAuthenticator({
        resolveAccountId: async (webId) => webId,
      });

      const clientCredAuthenticator = new ClientCredentialsAuthenticator({
        store: apiKeyStore,
        tokenEndpoint: config.cssTokenEndpoint,
      });

      const nodeTokenAuthenticator = new NodeTokenAuthenticator({
        repository: nodeRepo,
      });

      return new MultiAuthenticator({
        // NodeTokenAuthenticator 必须在 ClientCredentialsAuthenticator 之前
        // 因为两者都处理 Bearer token，但 Node Token 有 X-Node-Id 头
        authenticators: [solidAuthenticator, nodeTokenAuthenticator, clientCredAuthenticator],
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

    chatKitService: asFunction(({ chatKitStore, chatKitAiProvider }: ApiContainerCradle) => {
      return new ChatKitService({
        store: chatKitStore,
        aiProvider: chatKitAiProvider,
      });
    }).singleton(),

    // 业务服务
    chatService: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new VercelChatService(chatKitStore);
    }).singleton(),

    smartInputPipeline: asFunction(() => {
      return new SmartInputPipelineService({
        recognitionService: new IntentRecognitionService(),
        storageService: new IntentStorageService(),
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
