import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { setupAccount } from '../tests/integration/helpers/solidAccount';
import {
  createVectorIntegrationContext,
  getSqliteVecCapability,
  randomVector,
} from '../tests/vector/helpers/vectorIntegration';

async function verifyOpenRuntime(): Promise<void> {
  const stack = new XpodTestStack();
  await stack.start('local', { logLevel: 'warn' });

  try {
    const statusResponse = await fetch(new URL('/service/status', stack.baseUrl));
    if (!statusResponse.ok) {
      throw new Error(`open runtime status failed: ${statusResponse.status}`);
    }

    const account = await setupAccount(stack.baseUrl.replace(/\/$/, ''), 'bun-open');
    if (!account) {
      throw new Error('failed to create open runtime account');
    }

    const targetUrl = new URL('bun-open-runtime.txt', account.podUrl).href;
    const putResponse = await fetch(targetUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello from bun runtime smoke',
    });

    if (![201, 204].includes(putResponse.status)) {
      throw new Error(`open runtime PUT failed: ${putResponse.status}`);
    }

    const getResponse = await fetch(targetUrl);
    const body = await getResponse.text();
    if (getResponse.status !== 200 || !body.includes('hello from bun runtime smoke')) {
      throw new Error(`open runtime GET failed: ${getResponse.status}`);
    }
  } finally {
    await stack.stop();
  }
}

async function verifyVectorRuntime(): Promise<void> {
  const capability = getSqliteVecCapability();
  if (!capability.available) {
    console.warn(`[bun-smoke] skip vector runtime: ${capability.reason ?? 'sqlite-vec unavailable'}`);
    return;
  }

  const context = await createVectorIntegrationContext('bun-runtime');
  const model = `bun-runtime-${Date.now()}`;
  const firstVector = randomVector();
  const secondVector = randomVector();

  try {
    const statusResponse = await fetch(new URL('/service/status', context.baseUrl));
    if (!statusResponse.ok) {
      throw new Error(`vector runtime status failed: ${statusResponse.status}`);
    }

    const upsert = await context.client.upsert(model, [
      { id: 1, vector: firstVector },
      { id: 2, vector: secondVector },
    ]);
    if (upsert.upserted !== 2 || upsert.errors.length > 0) {
      throw new Error(`vector upsert failed: ${JSON.stringify(upsert)}`);
    }

    const search = await context.client.search(model, firstVector, { limit: 1 });
    if (search.results.length !== 1 || search.results[0].id !== 1) {
      throw new Error(`vector search failed: ${JSON.stringify(search)}`);
    }
  } finally {
    await context.stop();
  }
}

async function main(): Promise<void> {
  process.env.XPOD_TEST_TRANSPORT = process.env.XPOD_TEST_TRANSPORT || 'port';

  await verifyOpenRuntime();
  await verifyVectorRuntime();

  console.log('[bun-smoke] ok');
}

main().catch((error) => {
  console.error('[bun-smoke] failed:', error);
  process.exit(1);
});
