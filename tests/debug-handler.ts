/**
 * 模拟 VectorHttpHandler.createDb 和 getModelsFromPod 的逻辑
 */
import { config as loadEnv } from 'dotenv';
import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq } from 'drizzle-solid';
import { modelTable, providerTable, modelRelations, ModelType } from '../src/embedding/schema/tables';

loadEnv({ path: '.env.local' });

async function main() {
  // 1. 先用正常 session 登录
  const session = new Session();
  await session.login({
    clientId: process.env.SOLID_CLIENT_ID!,
    clientSecret: process.env.SOLID_CLIENT_SECRET!,
    oidcIssuer: process.env.SOLID_OIDC_ISSUER!,
    tokenType: "DPoP",
  });

  console.log('Logged in:', session.info.webId);

  // 2. 模拟 VectorHttpHandler.createDb 的方式
  // 它用的是 createAuthenticatedFetch，只是转发 Authorization header
  const authHeader = 'DPoP fake-token'; // 模拟一个假的 header
  
  const fakeSession = {
    info: { isLoggedIn: true },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', authHeader);
      return fetch(input, { ...init, headers });
    },
  };

  console.log('\n=== Test with FAKE session (simulating VectorHttpHandler) ===');
  try {
    const fakeDb = drizzle(fakeSession, {
      schema: { model: modelTable, provider: providerTable, modelRelations },
    });
    const fakeModels = await fakeDb.query.model.findMany({
      where: eq(modelTable.modelType, ModelType.EMBEDDING),
    });
    console.log('Fake session models:', fakeModels);
  } catch (e) {
    console.error('Fake session error:', e);
  }

  console.log('\n=== Test with REAL session ===');
  const realDb = drizzle(session as any, {
    schema: { model: modelTable, provider: providerTable, modelRelations },
  });
  const realModels = await realDb.query.model.findMany({
    where: eq(modelTable.modelType, ModelType.EMBEDDING),
  });
  console.log('Real session models:', realModels);

  await session.logout();
}

main().catch(console.error);
