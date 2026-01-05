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
  
  // 删除旧的 models.ttl
  console.log('\n=== Deleting old models.ttl ===');
  const deleteRes = await session.fetch(`${podUrl}settings/ai/models.ttl`, {
    method: 'DELETE',
  });
  console.log('Delete status:', deleteRes.status);
  
  await session.logout();
  console.log('Done');
}

main().catch(console.error);
