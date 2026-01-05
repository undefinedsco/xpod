import { Session } from '@inrupt/solid-client-authn-node';
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
  
  // 1. 读取 models.ttl
  console.log('\n=== Reading models.ttl ===');
  const modelsRes = await session.fetch(`${podUrl}settings/ai/models.ttl`);
  if (modelsRes.ok) {
    const content = await modelsRes.text();
    console.log(content);
  } else {
    console.log('Status:', modelsRes.status);
  }
  
  // 2. 读取 providers.ttl
  console.log('\n=== Reading providers.ttl ===');
  const providersRes = await session.fetch(`${podUrl}settings/ai/providers.ttl`);
  if (providersRes.ok) {
    const content = await providersRes.text();
    console.log(content);
  } else {
    console.log('Status:', providersRes.status);
    console.log('providers.ttl not found');
  }
  
  // 3. 调用 /models API
  console.log('\n=== Calling /-/vector/models ===');
  const apiRes = await session.fetch(`${podUrl}-/vector/models`);
  const apiData = await apiRes.json();
  console.log(JSON.stringify(apiData, null, 2));
  
  await session.logout();
}

main().catch(console.error);
