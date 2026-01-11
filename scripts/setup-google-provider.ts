import { drizzle } from 'drizzle-solid';
import { eq } from 'drizzle-solid';
import { modelProviderTable } from '../src/api/models/model-provider.schema';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const TOKEN_ENDPOINT = process.env.CSS_TOKEN_ENDPOINT || 'http://localhost:3000/.oidc/token';
const CLIENT_ID = process.env.SOLID_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLID_CLIENT_SECRET;
const WEB_ID = process.env.SOLID_WEBID || 'http://localhost:3000/test/profile/card#me';
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

if (!CLIENT_ID || !CLIENT_SECRET || !GOOGLE_KEY) {
  console.error('Missing credentials in .env.local');
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

    // 2. Insert/Update Google Provider
    const googleProviderId = 'google-gemini-test';
    console.log(`Configuring Google Provider (${googleProviderId})...`);
    
    // Blindly insert (or update if I could)
    // Since I can't check if exists easily due to the error, I'll just try to insert.
    // Drizzle-Solid insert might fail if ID exists? No, RDF is additive usually, or overrides.
    // Actually, drizzle-solid uses SPARQL UPDATE.
    
    await db.insert(modelProviderTable).values({
        id: googleProviderId,
        enabled: true,
        apiKey: GOOGLE_KEY,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        proxy: 'http://127.0.0.1:7890',
        models: ['gemini-pro', 'gpt-4o'],
        updatedAt: new Date()
    });

    console.log('✅ Google Provider configured successfully.');

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

main();
