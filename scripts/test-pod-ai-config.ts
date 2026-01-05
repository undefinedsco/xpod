/**
 * 测试从 Pod 读取 AI 配置（Provider、Model、Credential）
 * 
 * 使用方法：
 * 1. 确保 .env.local 配置了 SOLID_CLIENT_ID、SOLID_CLIENT_SECRET 等
 * 2. 启动本地 CSS: yarn local
 * 3. 运行: npx tsx scripts/test-pod-ai-config.ts
 */

import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle } from 'drizzle-solid';
import { eq, and } from 'drizzle-solid';
import { config as loadEnv } from 'dotenv';

// 加载环境变量
loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

// Schema 定义
import { credentialTable } from '../src/credential/schema/tables';
import { providerTable, modelTable } from '../src/embedding/schema/tables';
import { ServiceType, CredentialStatus } from '../src/credential/schema/types';
import { ModelType } from '../src/embedding/schema/types';

// 构建 schema 对象
const schema = {
  credential: credentialTable,
  provider: providerTable,
  model: modelTable,
};

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const webId = process.env.SOLID_WEBID;

async function main() {
  console.log('=== Pod AI Config Test ===\n');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`WebID: ${webId}`);
  console.log(`OIDC Issuer: ${oidcIssuer}`);
  console.log();

  if (!clientId || !clientSecret) {
    console.error('Error: SOLID_CLIENT_ID and SOLID_CLIENT_SECRET are required');
    console.error('Please configure them in .env.local');
    process.exit(1);
  }

  // 1. 登录
  console.log('1. Logging in...');
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
    // 2. 确保设置目录存在
    console.log('2. Ensuring settings directories exist...');
    await ensureContainer(authenticatedFetch, `${baseUrl}settings/`);
    await ensureContainer(authenticatedFetch, `${baseUrl}settings/ai/`);
    console.log('   Done\n');

    // 3. 写入测试数据
    console.log('3. Writing test data...');

    // 写入 Provider
    console.log('   - Writing provider (openai)...');
    try {
      await db.insert(providerTable).values({
        id: 'openai',
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      });
    } catch (e) {
      // 可能已存在，忽略
      console.log('     (may already exist)');
    }

    // 写入 Model
    console.log('   - Writing model (text-embedding-3-small)...');
    try {
      await db.insert(modelTable).values({
        id: 'text-embedding-3-small',
        modelId: 'text-embedding-3-small',
        displayName: 'OpenAI Text Embedding 3 Small',
        modelType: ModelType.EMBEDDING,
        dimension: 1536,
        providerId: 'openai',
      });
    } catch (e) {
      console.log('     (may already exist)');
    }

    // 写入 Credential
    console.log('   - Writing credential (test-openai-key)...');
    try {
      await db.insert(credentialTable).values({
        id: 'test-openai-key',
        provider: 'openai',
        service: ServiceType.AI,
        status: CredentialStatus.ACTIVE,
        apiKey: 'sk-test-key-placeholder',
        label: 'Test OpenAI Key',
      });
    } catch (e) {
      console.log('     (may already exist)');
    }

    console.log('   Done\n');

    // 4. 读取并验证数据
    console.log('4. Reading data from Pod...\n');

    // 读取 Providers
    console.log('   --- Providers (/settings/ai/providers.ttl) ---');
    const providers = await db.select().from(providerTable);
    if (providers.length === 0) {
      console.log('   (empty)');
    } else {
      for (const p of providers) {
        console.log(`   - ${p.id}: ${p.providerId} @ ${p.baseUrl}`);
      }
    }
    console.log();

    // 读取 Models
    console.log('   --- Models (/settings/ai/models.ttl) ---');
    const models = await db.select().from(modelTable);
    if (models.length === 0) {
      console.log('   (empty)');
    } else {
      for (const m of models) {
        console.log(`   - ${m.id}: ${m.displayName} (${m.modelType}, dim=${m.dimension})`);
      }
    }
    console.log();

    // 读取 Credentials
    console.log('   --- Credentials (/settings/credentials.ttl) ---');
    const credentials = await db.select().from(credentialTable);
    if (credentials.length === 0) {
      console.log('   (empty)');
    } else {
      for (const c of credentials) {
        const maskedKey = c.apiKey ? `${c.apiKey.slice(0, 8)}...` : '(none)';
        console.log(`   - ${c.id}: ${c.provider}/${c.service} [${c.status}] key=${maskedKey}`);
      }
    }
    console.log();

    // 5. 测试查询
    console.log('5. Testing queries...\n');

    // 查询 active 的 AI credentials
    console.log('   Query: Active AI credentials for openai');
    const activeAiCreds = await db
      .select()
      .from(credentialTable)
      .where(
        and(
          eq(credentialTable.provider, 'openai'),
          eq(credentialTable.service, ServiceType.AI),
          eq(credentialTable.status, CredentialStatus.ACTIVE),
        ),
      );
    console.log(`   Result: ${activeAiCreds.length} credential(s) found`);
    console.log();

    // 查询 embedding models
    console.log('   Query: Embedding models');
    const embeddingModels = await db
      .select()
      .from(modelTable)
      .where(eq(modelTable.modelType, ModelType.EMBEDDING));
    console.log(`   Result: ${embeddingModels.length} model(s) found`);
    for (const m of embeddingModels) {
      console.log(`     - ${m.modelId} (provider: ${m.providerId})`);
    }
    console.log();

    console.log('=== Test Complete ===');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await session.logout().catch(() => {});
  }
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
