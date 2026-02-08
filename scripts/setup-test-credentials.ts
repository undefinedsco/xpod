/**
 * Setup test credentials before running integration tests.
 * This script:
 * 1. Checks if the server is running
 * 2. Logs in with the seeded account
 * 3. Creates client credentials if needed
 * 4. Updates .env.local with the credentials
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const rawBaseUrl = process.env.CSS_BASE_URL ?? 'http://localhost:3000';
const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
const seedCandidates = [
  {
    email: process.env.SOLID_SEED_EMAIL ?? 'test-integration@example.com',
    password: process.env.SOLID_SEED_PASSWORD ?? 'TestIntegration123!',
  },
  // docker standalone 默认 seed.dev.json
  {
    email: 'test@dev.local',
    password: 'test123456',
  },
];
const envFilePath = path.resolve(process.cwd(), '.env.local');

interface AccountControls {
  controls: {
    password?: { create?: string };
    credentials?: { create?: string };
    account?: { clientCredentials?: string };
  };
}

async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}.account/`, {
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function login(): Promise<string | null> {
  for (const candidate of seedCandidates) {
    const loginResponse = await fetch(`${baseUrl}.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: candidate.email, password: candidate.password }),
    });

    if (!loginResponse.ok) {
      continue;
    }

    const loginResult = (await loginResponse.json()) as { authorization?: string };
    if (loginResult.authorization) {
      console.log(`Login successful with seed account: ${candidate.email}`);
      return loginResult.authorization;
    }
  }

  return null;
}

async function getAccountControls(token: string): Promise<AccountControls | null> {
  const response = await fetch(`${baseUrl}.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });

  if (!response.ok) {
    console.error('Failed to get account controls:', await response.text());
    return null;
  }

  return (await response.json()) as AccountControls;
}

async function createClientCredentials(
  token: string,
  createUrl: string,
  webId: string,
): Promise<{ id: string; secret: string } | null> {
  const response = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
    body: JSON.stringify({
      name: 'integration-test',
      webId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    // If credential already exists, that's fine
    if (text.includes('already exists')) {
      console.log('Client credentials already exist');
      return null;
    }
    console.error('Failed to create client credentials:', text);
    return null;
  }

  return (await response.json()) as { id: string; secret: string };
}

function updateEnvFile(clientId: string, clientSecret: string, webId: string): void {
  let envContent = '';
  if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, 'utf8');
  }

  const updates: Record<string, string> = {
    SOLID_CLIENT_ID: clientId,
    SOLID_CLIENT_SECRET: clientSecret,
    SOLID_WEBID: webId,
    SOLID_OIDC_ISSUER: baseUrl,
  };

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envFilePath, envContent.trim() + '\n');
  console.log(`Updated ${envFilePath}`);
}

async function verifyCredentials(clientId: string, clientSecret: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}.oidc/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('Setting up test credentials...');
  console.log(`Base URL: ${baseUrl}`);

  // Check if server is running
  if (!(await checkServer())) {
    console.error('Server is not running. Please start it with "yarn local" first.');
    process.exit(1);
  }
  console.log('Server is running');

  // Check if existing credentials work
  const existingClientId = process.env.SOLID_CLIENT_ID;
  const existingClientSecret = process.env.SOLID_CLIENT_SECRET;
  if (existingClientId && existingClientSecret) {
    console.log('Checking existing credentials...');
    if (await verifyCredentials(existingClientId, existingClientSecret)) {
      console.log('Existing credentials are valid');
      return;
    }
    console.log('Existing credentials are invalid, creating new ones...');
  }

  // Login
  console.log('Logging in with seeded account...');
  const token = await login();
  if (!token) {
    console.error('Failed to login with all known seed accounts.');
    process.exit(1);
  }
  console.log('Login successful');

  // Get account controls
  const controls = await getAccountControls(token);
  if (!controls) {
    console.error('Failed to get account controls');
    process.exit(1);
  }

  // Find client credentials creation endpoint
  const createUrl = controls.controls?.account?.clientCredentials;
  if (!createUrl) {
    console.error('Client credentials endpoint not found in controls:', JSON.stringify(controls, null, 2));
    process.exit(1);
  }

  // Derive WebID
  const webId = `${baseUrl}test/profile/card#me`;

  // Create client credentials
  console.log('Creating client credentials...');
  const credentials = await createClientCredentials(token, createUrl, webId);
  if (credentials) {
    console.log(`Created credentials: ${credentials.id}`);
    updateEnvFile(credentials.id, credentials.secret, webId);
    console.log('Credentials saved to .env.local');
  } else {
    console.log('Could not create new credentials (may already exist)');
    console.log('If tests fail with invalid_client, try running: yarn clean && yarn local');
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
