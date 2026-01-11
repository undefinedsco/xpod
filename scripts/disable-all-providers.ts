import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const TOKEN_ENDPOINT = process.env.CSS_TOKEN_ENDPOINT || 'http://localhost:3000/.oidc/token';
const CLIENT_ID = process.env.SOLID_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLID_CLIENT_SECRET;
const WEB_ID = process.env.SOLID_WEBID || 'http://localhost:3000/test/profile/card#me';

async function getAccessToken() {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
  });
  const data = await response.json() as any;
  return data.access_token;
}

async function main() {
  const token = await getAccessToken();
  console.log('Got Access Token.');

  // SPARQL Endpoint for model providers
  // drizzle-solid schema says: base: '/.data/model-providers/'
  // Default sparql endpoint usually at .../-/sparql relative to the resource or container.
  // In `model-provider.schema.ts`: sparqlEndpoint: '/.data/model-providers/-/sparql'
  
  // We need to construct the full URL.
  // Assuming WEB_ID is like http://localhost:3000/test/profile/card#me
  // The root is http://localhost:3000/test/
  
  const storageRoot = WEB_ID!.split('profile/')[0];
  const sparqlUrl = `${storageRoot}.data/model-providers/-/sparql`;
  
  console.log(`Targeting SPARQL: ${sparqlUrl}`);

  const query = `
    PREFIX linx: <https://linx.ai/ns#>
    DELETE { ?s linx:status true }
    INSERT { ?s linx:status false }
    WHERE {
      ?s a linx:ModelProvider .
      ?s linx:status true .
    }
  `;

  const response = await fetch(sparqlUrl, {
    method: 'POST', // Use POST as per SubgraphSparqlHttpHandler.ALLOWED_METHODS
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/sparql-update',
    },
    body: query,
  });

  if (!response.ok) {
    console.error(`Update failed: ${response.status} ${await response.text()}`);
  } else {
    console.log('✅ Disabled all providers.');
  }
}

main().catch(console.error);
