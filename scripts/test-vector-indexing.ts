/**
 * 测试文件驱动的向量索引流程：
 * 1. 设置 Provider + Credential (AI 配置)
 * 2. 创建 VectorStore 定义 (指定要索引的文件夹)
 * 3. 上传测试文件到该文件夹
 * 4. 验证自动索引是否触发
 * 
 * 使用方法：
 * 1. 在 .env.local 配置 GOOGLE_API_KEY, SOLID_CLIENT_ID, SOLID_CLIENT_SECRET
 * 2. 启动本地服务器: yarn local
 * 3. 运行: npx tsx scripts/test-vector-indexing.ts
 */

import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq } from 'drizzle-solid';
import { config as loadEnv } from 'dotenv';

// 加载环境变量
loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

// Schema 定义
import { credentialTable } from '../src/credential/schema/tables';
import { providerTable, vectorStoreTable, VectorStoreStatus, ChunkingStrategy } from '../src/embedding/schema/tables';
import { ServiceType, CredentialStatus } from '../src/credential/schema/types';

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const googleApiKey = process.env.GOOGLE_API_KEY;
const proxyUrl = process.env.PROXY_URL;

const schema = {
  credential: credentialTable,
  provider: providerTable,
  vectorStore: vectorStoreTable,
};

async function main() {
  console.log('=== Vector Indexing Test ===\n');

  // 检查环境变量
  if (!clientId || !clientSecret) {
    console.error('Error: SOLID_CLIENT_ID and SOLID_CLIENT_SECRET are required');
    process.exit(1);
  }
  if (!googleApiKey) {
    console.error('Error: GOOGLE_API_KEY is required');
    process.exit(1);
  }

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
  const podUrl = getPodUrl(session);
  console.log(`   Logged in as: ${session.info.webId}`);
  console.log(`   Pod URL: ${podUrl}\n`);

  const authenticatedFetch = session.fetch.bind(session);
  const db = drizzle(session, { schema });

  try {
    // 2. 确保目录存在
    console.log('2. Ensuring directories exist...');
    await ensureContainer(authenticatedFetch, `${podUrl}settings/`);
    await ensureContainer(authenticatedFetch, `${podUrl}settings/ai/`);
    await ensureContainer(authenticatedFetch, `${podUrl}documents/`);
    console.log('   Done\n');

    // 3. 设置 AI 配置
    console.log('3. Setting up AI configuration...');
    
    // Provider
    const providerIri = `${podUrl}settings/ai/providers.ttl#google`;
    try {
      await db.delete(providerTable).where(eq(providerTable.columns.id as any, 'google'));
    } catch (e) { /* ignore */ }
    
    await db.insert(providerTable).values({
      id: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      proxyUrl: proxyUrl || undefined,
    });
    console.log('   - Provider: google');

    // Credential
    try {
      await db.delete(credentialTable).where(eq(credentialTable.columns.id as any, 'google-ai-key'));
    } catch (e) { /* ignore */ }
    
    await db.insert(credentialTable).values({
      id: 'google-ai-key',
      provider: providerIri,
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: googleApiKey,
      label: 'Google AI Key',
    });
    console.log('   - Credential: google-ai-key');
    console.log('   Done\n');

    // 4. 创建 VectorStore 定义
    console.log('4. Creating VectorStore definition...');
    const vectorStoreId = 'documents-index';
    const containerUrl = `${podUrl}documents/`;
    
    try {
      await db.delete(vectorStoreTable).where(eq(vectorStoreTable.columns.id as any, vectorStoreId));
    } catch (e) { /* ignore */ }
    
    await db.insert(vectorStoreTable).values({
      id: vectorStoreId,
      name: 'Documents Index',
      container: containerUrl,
      chunkingStrategy: ChunkingStrategy.AUTO,
      status: VectorStoreStatus.COMPLETED,
      createdAt: new Date(),
    });
    console.log(`   - VectorStore: ${vectorStoreId}`);
    console.log(`   - Container: ${containerUrl}`);
    console.log('   Done\n');

    // 5. 验证配置已写入
    console.log('5. Verifying configuration...');
    
    const providers = await db.select().from(providerTable);
    console.log(`   Providers: ${providers.length}`);
    for (const p of providers) {
      console.log(`     - ${p.id}: ${p.baseUrl}`);
    }

    const credentials = await db.select().from(credentialTable);
    console.log(`   Credentials: ${credentials.length}`);
    for (const c of credentials) {
      console.log(`     - ${c.id}: service=${c.service}, status=${c.status}`);
    }

    const vectorStores = await db.select().from(vectorStoreTable);
    console.log(`   VectorStores: ${vectorStores.length}`);
    for (const vs of vectorStores) {
      console.log(`     - ${vs.id}: container=${vs.container}`);
    }
    console.log();

    // 6. 上传测试文件
    console.log('6. Uploading test file...');
    const testFileUrl = `${podUrl}documents/test-doc.txt`;
    const testContent = `This is a test document for vector indexing.

It contains multiple paragraphs to test the chunking strategy.

The quick brown fox jumps over the lazy dog.
Machine learning is revolutionizing how we process information.
Solid pods provide decentralized data storage with user control.
`;

    const putResponse = await authenticatedFetch(testFileUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: testContent,
    });
    console.log(`   PUT ${testFileUrl} -> ${putResponse.status}`);
    
    if (putResponse.ok) {
      console.log('   File uploaded successfully');
      console.log('   Waiting for VectorIndexingListener to process...\n');
      
      // 等待几秒让 listener 处理
      await sleep(3000);
      
      // 7. 检查索引状态
      console.log('7. Checking index status...');
      const statusResponse = await authenticatedFetch(`${podUrl}-/vector/status`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      console.log(`   GET /-/vector/status -> ${statusResponse.status}`);
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        console.log(`   Index status: ${JSON.stringify(status, null, 2)}`);
      }
    }

    console.log('\n=== Test Complete ===');

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
