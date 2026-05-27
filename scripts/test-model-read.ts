import { Session } from '@inrupt/solid-client-authn-node';
import { aiConfigProviderRef } from '@undefineds.co/models';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const BASE_URL = 'http://localhost:4000';
const clientId = process.env.SOLID_CLIENT_ID!;
const clientSecret = process.env.SOLID_CLIENT_SECRET!;

async function main() {
  const session = new Session();
  
  await session.login({
    clientId,
    clientSecret,
    oidcIssuer: BASE_URL + '/',
    tokenType: "DPoP",
  });
  
  console.log('Logged in as:', session.info.webId);
  
  const podUrl = session.info.webId!.replace(/profile\/card#me$/, '');

  const providerId = process.env.AI_PROVIDER_ID || 'openai';
  const providerPath = aiConfigProviderRef(providerId).replace(/^\//, '');

  // 1. 读取 Provider 文档
  console.log(`\n=== Reading ${providerPath} ===`);
  const providersRes = await session.fetch(`${podUrl}${providerPath}`);
  if (providersRes.ok) {
    const content = await providersRes.text();
    console.log(content);
  } else {
    console.log('Status:', providersRes.status);
    console.log(`${providerPath} not found`);
  }

  // 2. 读取 credentials.ttl
  console.log('\n=== Reading settings/credentials.ttl ===');
  const credentialsRes = await session.fetch(`${podUrl}settings/credentials.ttl`);
  if (credentialsRes.ok) {
    const content = await credentialsRes.text();
    console.log(content);
  } else {
    console.log('Status:', credentialsRes.status);
  }
  
  // 3. 调用 /models API
  console.log('\n=== Calling /-/vector/models ===');
  const apiRes = await session.fetch(`${podUrl}-/vector/models`);
  const apiData = await apiRes.json();
  console.log(JSON.stringify(apiData, null, 2));
  
  await session.logout();
}

main().catch(console.error);
