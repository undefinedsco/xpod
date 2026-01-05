import { Session } from '@inrupt/solid-client-authn-node';
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
  
  // 1. 读取 models.ttl
  console.log('\n=== Reading models.ttl ===');
  const modelsRes = await session.fetch(`${podUrl}settings/ai/models.ttl`);
  if (modelsRes.ok) {
    console.log(await modelsRes.text());
  } else {
    console.log('Status:', modelsRes.status);
  }
  
  // 2. 读取 providers.ttl
  console.log('\n=== Reading providers.ttl ===');
  const providersRes = await session.fetch(`${podUrl}settings/ai/providers.ttl`);
  if (providersRes.ok) {
    console.log(await providersRes.text());
  } else {
    console.log('Status:', providersRes.status);
  }

  // 3. 读取 credentials.ttl
  console.log('\n=== Reading credentials.ttl ===');
  const credRes = await session.fetch(`${podUrl}settings/credentials.ttl`);
  if (credRes.ok) {
    console.log(await credRes.text());
  } else {
    console.log('Status:', credRes.status);
  }
  
  await session.logout();
}

main().catch(console.error);
