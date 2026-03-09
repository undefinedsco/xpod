/**
 * Setup Google AI Provider for Testing
 *
 * 创建测试用的 AI Provider 配置，包含：
 * - Google Gemini API 配置
 * - 代理设置
 */
import { drizzle } from '@undefineds.co/drizzle-solid';
import { modelProviderTable } from '../src/api/models/model-provider.schema';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const TOKEN_ENDPOINT = process.env.CSS_TOKEN_ENDPOINT || 'http://localhost:3000/.oidc/token';
const CLIENT_ID = process.env.SOLID_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLID_CLIENT_SECRET;
const WEB_ID = process.env.SOLID_WEBID || 'http://localhost:3000/test/profile/card#me';
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const PROXY_URL = process.env.XPOD_AI_PROXY_URL || 'http://127.0.0.1:7890';

if (!CLIENT_ID || !CLIENT_SECRET || !GOOGLE_KEY) {
  console.error('Missing credentials in .env.local');
  console.error('Required: SOLID_CLIENT_ID, SOLID_CLIENT_SECRET, GOOGLE_API_KEY');
  process.exit(1);
}

async function getAccessToken() {
  console.log('Authenticating with CSS...');
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
  });

  if (!response.ok) {
    throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  return data.access_token;
}

async function main() {
  try {
    const token = await getAccessToken();
    console.log('Got Access Token.');

    // Custom fetcher with Auth
    const authFetch = (url: any, init: any) => {
      const headers = new Headers(init?.headers || {});
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    };

    // Initialize Drizzle-Solid
    const db = drizzle({
      fetch: authFetch,
      info: { webId: WEB_ID, isLoggedIn: true }
    } as any);

    console.log(`Connecting to Pod: ${WEB_ID}`);

    // Insert Google Provider
    const googleProviderId = 'google-gemini';
    console.log(`Configuring Google Provider (${googleProviderId})...`);
    console.log(`  - API Key: ${GOOGLE_KEY?.slice(0, 10)}...`);
    console.log(`  - Base URL: https://generativelanguage.googleapis.com/v1beta/openai/`);
    console.log(`  - Proxy: ${PROXY_URL}`);

    await db.insert(modelProviderTable).values({
      id: googleProviderId,
      enabled: true,
      apiKey: GOOGLE_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      proxy: PROXY_URL,
      updatedAt: new Date()
    });

    console.log('✅ Google Provider configured successfully.');

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

main();
