/**
 * 简单测试 Google Embedding + Proxy
 *
 * 使用方法：
 * GOOGLE_API_KEY=xxx npx tsx scripts/test-proxy-embedding.ts
 *
 * 可选环境变量：
 * - EMBEDDING_PROXY_URL: 代理地址，默认 http://127.0.0.1:7890
 */

import { EmbeddingServiceImpl } from '../src/embedding/EmbeddingService';
import { ProviderRegistryImpl } from '../src/embedding/ProviderRegistryImpl';

// 测试用代理地址
const TEST_PROXY_URL = process.env.EMBEDDING_PROXY_URL || 'http://127.0.0.1:7890';

async function main() {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    console.error('Error: GOOGLE_API_KEY environment variable is required');
    console.error('Usage: GOOGLE_API_KEY=xxx npx tsx scripts/test-proxy-embedding.ts');
    process.exit(1);
  }

  console.log('=== Google Embedding Proxy Test ===\n');
  console.log(`API Key: ${apiKey.slice(0, 10)}...`);
  console.log(`Proxy URL: ${TEST_PROXY_URL}`);

  // 获取 provider 信息
  const providerRegistry = new ProviderRegistryImpl();
  const provider = await providerRegistry.getProvider('google');

  console.log(`Provider: ${provider?.name}`);
  console.log(`Base URL: ${provider?.baseUrl}`);
  console.log();

  // 创建 embedding service
  const embeddingService = new EmbeddingServiceImpl(providerRegistry);

  // 测试时手动传入 proxyUrl
  const credential = {
    provider: 'google',
    apiKey,
    proxyUrl: TEST_PROXY_URL,
  };

  // 测试单个 embedding
  console.log('Testing single embedding...');
  const testText = 'Hello, this is a test for embedding generation.';
  console.log(`Input: "${testText}"`);

  try {
    const startTime = Date.now();
    const embedding = await embeddingService.embed(testText, credential, 'text-embedding-004');
    const elapsed = Date.now() - startTime;

    console.log(`✅ Success! (${elapsed}ms)`);
    console.log(`   Dimension: ${embedding.length}`);
    console.log(`   First 5 values: [${embedding.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
    console.log();

    // 测试批量 embedding
    console.log('Testing batch embedding...');
    const batchTexts = [
      'The quick brown fox jumps over the lazy dog.',
      'Machine learning is a subset of artificial intelligence.',
      'Solid is a decentralized data storage specification.',
    ];

    const batchStart = Date.now();
    const embeddings = await embeddingService.embedBatch(batchTexts, credential, 'text-embedding-004');
    const batchElapsed = Date.now() - batchStart;

    console.log(`✅ Success! (${batchElapsed}ms)`);
    console.log(`   Input: ${batchTexts.length} texts`);
    console.log(`   Output: ${embeddings.length} vectors, each ${embeddings[0].length} dimensions`);
    console.log();

    console.log('=== All tests passed! ===');

  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
