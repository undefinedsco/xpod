import { Session } from '@inrupt/solid-client-authn-node';
import { aiConfigProviderRef } from '@undefineds.co/models';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const oidcIssuer = process.env.SOLID_OIDC_ISSUER || 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID!;
const clientSecret = process.env.SOLID_CLIENT_SECRET!;

async function main() {
  const session = new Session();
  
  await session.login({
    clientId,
    clientSecret,
    oidcIssuer,
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
    console.log(await providersRes.text());
  } else {
    console.log('Status:', providersRes.status);
  }

  // 2. 读取 credentials.ttl
  console.log('\n=== Reading settings/credentials.ttl ===');
  const credRes = await session.fetch(`${podUrl}settings/credentials.ttl`);
  if (credRes.ok) {
    console.log(await credRes.text());
  } else {
    console.log('Status:', credRes.status);
  }
  
  await session.logout();
}

main().catch(console.error);
