import { config as loadEnv } from 'dotenv';
import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq } from 'drizzle-solid';
import { modelTable, providerTable, ModelType } from '../src/embedding/schema/tables';

loadEnv({ path: '.env.local' });

async function main() {
  const session = new Session();
  
  await session.login({
    clientId: process.env.SOLID_CLIENT_ID!,
    clientSecret: process.env.SOLID_CLIENT_SECRET!,
    oidcIssuer: process.env.SOLID_OIDC_ISSUER!,
    tokenType: "DPoP",
  });

  const db = drizzle(session as any, {
    schema: { model: modelTable, provider: providerTable },
  });

  console.log('=== All Models ===');
  const models = await db.query.model.findMany();
  console.log(JSON.stringify(models, null, 2));

  console.log('\n=== Embedding Models ===');
  const embeddingModels = await db.query.model.findMany({
    where: eq(modelTable.modelType, ModelType.EMBEDDING),
  });
  console.log(JSON.stringify(embeddingModels, null, 2));

  console.log('\n=== All Providers ===');
  const providers = await db.query.provider.findMany();
  console.log(JSON.stringify(providers, null, 2));

  await session.logout();
}

main().catch(console.error);
