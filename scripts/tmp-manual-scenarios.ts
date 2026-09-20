/**
 * 手工验收场景启动器：本地 cloud(4300) 作 IdP/管控 + local(4200) SP 指向本地 cloud。
 * 依赖 docker infra：postgres(5432)/redis(6379)/minio(9000)，由
 *   docker compose -p xpod-manual -f docker-compose.cluster.yml -f docker-compose.cluster.integration.yml up -d postgres redis minio
 * 提供。用完后 Ctrl-C 或 TaskStop 停止；数据保留在 .test-data/manual/ 下。
 * 种子账号（cloud 侧，config/seed.dev.json）：
 *   test@dev.local/test123456  alice@dev.local/alice123456  bob@dev.local/bob123456
 */
import path from 'node:path';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';

const TEST_GATEWAY_ENV = {
  XPOD_SECRET_CELL_KEY_ID: 'manual-verify',
  XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 1).toString('base64'),
  XPOD_SECRET_CELL_PREVIOUS_KEYS: JSON.stringify({
    'previous-id': Buffer.alloc(32, 2).toString('base64'),
  }),
};
const CLOUD_DB = process.env.XPOD_MANUAL_PG_URL ?? 'postgres://xpod:xpod@localhost:5432/xpod';
const BUSINESS_TOKEN = 'svc-manualverifytoken';

async function main(): Promise<void> {
  const runtimes: XpodRuntimeHandle[] = [];

  const cloud = await startXpodRuntime({
    mode: 'cloud',
    transport: 'port',
    gatewayPort: 4300,
    cssPort: 4301,
    apiPort: 4302,
    baseUrl: 'http://localhost:4300/',
    runtimeRoot: path.resolve('.test-data/manual/cloud'),
    rootFilePath: path.resolve('.test-data/manual/cloud/data'),
    sparqlEndpoint: CLOUD_DB,
    identityDbUrl: CLOUD_DB,
    env: {
      ...TEST_GATEWAY_ENV,
      CSS_BASE_STORAGE_DOMAIN: 'undefineds.site',
      CSS_REDIS_CLIENT: 'localhost:6379',
      CSS_REDIS_USERNAME: '',
      CSS_REDIS_PASSWORD: '',
      CSS_MINIO_ENDPOINT: 'http://localhost:9000',
      CSS_MINIO_ACCESS_KEY: 'minioadmin',
      CSS_MINIO_SECRET_KEY: 'minioadmin',
      CSS_MINIO_BUCKET_NAME: 'xpod',
      CSS_EMAIL_CONFIG_HOST: '',
      CSS_EMAIL_CONFIG_PORT: '587',
      CSS_EMAIL_CONFIG_AUTH_USER: '',
      CSS_EMAIL_CONFIG_AUTH_PASS: '',
      CSS_ALLOWED_HOSTS: 'localhost',
      // 只种账户不种 Pod：Pod 应由 SP provision 流程创建，
      // 带 Pod 的种子会让 cloud PodStore 与回调创建撞同名。
      CSS_SEED_CONFIG: path.resolve('.test-data/manual/seed.accounts-only.json'),
      XPOD_EDGE_NODES_ENABLED: 'false',
      XPOD_BUSINESS_TOKEN: BUSINESS_TOKEN,
      XPOD_NODE_ID: 'cloud-manual',
    },
  });
  runtimes.push(cloud);
  console.log('[scenario] cloud(IdP) ready: http://localhost:4300/ (API :4302)');

  const localSp = await startXpodRuntime({
    mode: 'local',
    transport: 'port',
    gatewayPort: 4200,
    cssPort: 4201,
    apiPort: 4202,
    baseUrl: 'http://localhost:4200/',
    runtimeRoot: path.resolve('.test-data/manual/local-cloud-sp'),
    rootFilePath: path.resolve('.test-data/manual/local-cloud-sp/data'),
    sparqlEndpoint: path.resolve('.test-data/manual/local-cloud-sp/quadstore.sqlite'),
    identityDbUrl: path.resolve('.test-data/manual/local-cloud-sp/identity.sqlite'),
    env: {
      ...TEST_GATEWAY_ENV,
      SOLID_OIDC_ISSUER: 'http://localhost:4300',
      // 单机验收：向 cloud 登记直连地址，SP 回调直接打 localhost:4200，
      // 不走 managed 域（local-manual-node.undefineds.site 在本机不可解析）。
      XPOD_PUBLIC_URL: 'http://localhost:4200/',
      XPOD_NODE_ID: 'local-manual-direct',
      XPOD_SERVICE_TOKEN: BUSINESS_TOKEN,
      CSS_ALLOWED_HOSTS: 'localhost',
      // SP 模式下账户/Pod 都由 cloud 管控，本地不挂种子，
      // 避免种子里的 test pod 与 provision 回调创建同名 Pod 冲突。
    },
  });
  runtimes.push(localSp);
  console.log('[scenario] local(SP→本地cloud) ready: http://localhost:4200/ (API :4202)');

  const shutdown = async(): Promise<void> => {
    console.log('Stopping scenarios...');
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
