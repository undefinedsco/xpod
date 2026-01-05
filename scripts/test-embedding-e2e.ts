/**
 * 测试完整的 Embedding 流程：
 * 1. 从环境变量读取 API Key
 * 2. 写入 Pod (Provider + Model + Credential)
 * 3. 从 Pod 读取配置
 * 4. 调用 EmbeddingService 生成向量
 * 
 * 使用方法：
 * 1. 在 .env.local 配置 GOOGLE_API_KEY
 * 2. 启动本地 CSS: yarn local
 * 3. 运行: npx tsx scripts/test-embedding-e2e.ts
 */

import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle } from 'drizzle-solid';
import { eq, and } from 'drizzle-solid';
import { config as loadEnv } from 'dotenv';

// 加载环境变量
loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

// Schema 定义
import { credentialTable } from '../src/credential/schema/tables';
import { providerTable, modelTable, ModelType } from '../src/embedding/schema/tables';
import { ServiceType, CredentialStatus } from '../src/credential/schema/types';

// Embedding Service
import { EmbeddingServiceImpl } from '../src/embedding/EmbeddingServiceImpl';
import { ProviderRegistryImpl } from '../src/embedding/ProviderRegistryImpl';

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const googleApiKey = process.env.GOOGLE_API_KEY;
const proxyUrl = process.env.PROXY_URL; // 可选代理

// 构建 schema 对象
const schema = {
  credential: credentialTable,
  provider: providerTable,
  model: modelTable,
};

async function main() {
  console.log('=== Embedding E2E Test ===\n');

  // 检查环境变量
  if (!clientId || !clientSecret) {
    console.error('Error: SOLID_CLIENT_ID and SOLID_CLIENT_SECRET are required');
    process.exit(1);
  }
  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY is required');
    process.exit(1);
  }
  console.log(`Google API Key: ${googleApiKey.slice(0, 10)}...`);
  if (proxyUrl) {
    console.log(`Proxy URL: ${proxyUrl}`);
  }
  console.log();

  // 1. 登录
  console.log('1. Logging in to Solid Pod...');
  const session = new Session();
  await session.login({
    clientId,
    clientSecret,
    oidcIssuer,
    tokenType: process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP',
  });

  if (!session.info.isLoggedIn) {
    console.error('Login failed');
    process.exit(1);
  }
  console.log(`   Logged in as: ${session.info.webId}\n`);

  const authenticatedFetch = session.fetch.bind(session);
  const db = drizzle(session, { schema });

  try {
    // 2. 确保目录存在
    console.log('2. Ensuring settings directories exist...');
    await ensureContainer(authenticatedFetch, `${getPodUrl(session)}settings/`);
    await ensureContainer(authenticatedFetch, `${getPodUrl(session)}settings/ai/`);
    console.log('   Done\n');

    // 3. 写入 Google Provider 配置
    console.log('3. Writing Google AI config to Pod...');
    
    // 先删除旧数据（如果存在）
    try {
      await db.delete(providerTable).where(eq(providerTable.columns.id as any, 'google'));
      await db.delete(modelTable).where(eq(modelTable.columns.id as any, 'text-embedding-004'));
      await db.delete(credentialTable).where(eq(credentialTable.columns.id as any, 'google-ai-key'));
    } catch (e) {
      // 忽略删除错误
    }

    // Provider
    console.log('   - Writing provider (google)...');
    await db.insert(providerTable).values({
      id: 'google',
      providerId: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      proxyUrl: proxyUrl || undefined,
    });

    // 获取 provider IRI（用于关联 credential）
    const podUrl = getPodUrl(session);
    const providerIri = `${podUrl}settings/ai/providers.ttl#google`;

    // Model
    console.log('   - Writing model (text-embedding-004)...');
    await db.insert(modelTable).values({
      id: 'text-embedding-004',
      modelId: 'text-embedding-004',
      displayName: 'Google Text Embedding 004',
      modelType: ModelType.EMBEDDING,
      dimension: 768,
      providerId: 'google',
    });

    // Credential（provider 是 URI 引用）
    console.log('   - Writing credential (google-ai-key)...');
    await db.insert(credentialTable).values({
      id: 'google-ai-key',
      provider: providerIri,  // URI 引用到 provider
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: googleApiKey,
      label: 'Google AI Key',
    });
    console.log('   Done\n');

    // 4. 从 Pod 读取配置（使用 with 查询）
    console.log('4. Reading config from Pod...');

    const providers = await db.select().from(providerTable).where(eq(providerTable.columns.providerId as any, 'google'));
    console.log(`   Provider: ${providers[0]?.providerId} @ ${providers[0]?.baseUrl}`);
    if (providers[0]?.proxyUrl) {
      console.log(`   Proxy: ${providers[0].proxyUrl}`);
    }

    const models = await db.select().from(modelTable).where(eq(modelTable.columns.modelId as any, 'text-embedding-004'));
    console.log(`   Model: ${models[0]?.modelId} (dim=${models[0]?.dimension})`);

    // 使用 with 查询 credential + provider
    const credentials = await db.query.credential.findMany({
      where: and(
        eq(credentialTable.columns.service, ServiceType.AI),
        eq(credentialTable.columns.status, CredentialStatus.ACTIVE),
      ),
      with: {
        provider: true,
      },
    });
    const cred = credentials[0];
    console.log(`   Credential: ${cred?.id} (key=${cred?.apiKey?.slice(0, 10)}...)`);
    console.log(`   -> Provider: ${(cred as any)?.provider?.providerId}`);
    console.log();

    // 5. 调用 EmbeddingService
    console.log('5. Calling EmbeddingService...');

    const providerRegistry = new ProviderRegistryImpl();
    const embeddingService = new EmbeddingServiceImpl(providerRegistry);

    const testText = 'Hello, this is a test for embedding generation.';
    console.log(`   Input: "${testText}"`);

    // 直接使用前面查询到的 provider 数据（with 查询可能不工作）
    const providerData = providers[0];
    const credential = {
      provider: 'google',
      apiKey: cred.apiKey!,
      baseUrl: cred.baseUrl || providerData?.baseUrl,
      proxyUrl: providerData?.proxyUrl,
    };

    console.log(`   Using proxy: ${credential.proxyUrl || 'none'}`);

    const embedding = await embeddingService.embed(testText, credential, 'text-embedding-004');

    console.log(`   Output: vector of ${embedding.length} dimensions`);
    console.log(`   First 5 values: [${embedding.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
    console.log();

    // 6. 测试批量 embedding
    console.log('6. Testing batch embedding...');
    const batchTexts = [
      'The quick brown fox jumps over the lazy dog.',
      'Machine learning is a subset of artificial intelligence.',
      'Solid is a decentralized data storage specification.',
    ];
    
    const embeddings = await embeddingService.embedBatch(batchTexts, credential, 'text-embedding-004');
    console.log(`   Input: ${batchTexts.length} texts`);
    console.log(`   Output: ${embeddings.length} vectors, each ${embeddings[0].length} dimensions`);
    console.log();

    console.log('=== Test Complete ===');
    console.log('Successfully read config from Pod and generated embeddings!');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await session.logout().catch(() => {});
  }
}

function getPodUrl(session: Session): string {
  const webId = session.info.webId!;
  return webId.replace(/profile\/card#me$/, '');
}

async function ensureContainer(doFetch: typeof fetch, url: string): Promise<void> {
  const head = await doFetch(url, { method: 'HEAD' });
  if (head.status === 404) {
    const create = await doFetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'text/turtle',
        'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    if (!create.ok && create.status !== 201 && create.status !== 204) {
      throw new Error(`Failed to create container ${url}: ${create.status}`);
    }
  }
}

main().catch(console.error);
