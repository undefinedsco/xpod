/**
 * Setup integration-test credentials.
 *
 * Strategy:
 * 1. Login with one available seeded account (env override first, then CSS_SEED_CONFIG candidates).
 * 2. Create a fresh pod based on current base URL.
 * 3. Create fresh client credentials bound to that pod WebID.
 * 4. Overwrite .env.local with latest SOLID_CLIENT_* / SOLID_WEBID / SOLID_OIDC_ISSUER.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const rawBaseUrl = process.env.CSS_BASE_URL ?? 'http://localhost:5739';
const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
const envFilePath = path.resolve(process.cwd(), '.env.local');
const defaultSeedConfigPath = path.resolve(process.cwd(), 'config/seeds/test.json');
const seedConfigPath = process.env.CSS_SEED_CONFIG ?? defaultSeedConfigPath;

interface SeedAccount {
  email: string;
  password: string;
}

interface AccountControls {
  controls: {
    account?: {
      pod?: string;
      clientCredentials?: string;
    };
    password?: {
      create?: string;
    };
  };
}

interface PodCreationResult {
  pod?: string;
  webId?: string;
}

function loadSeedAccounts(): SeedAccount[] {
  const accounts: SeedAccount[] = [];

  if (process.env.SOLID_TEST_EMAIL && process.env.SOLID_TEST_PASSWORD) {
    accounts.push({
      email: process.env.SOLID_TEST_EMAIL,
      password: process.env.SOLID_TEST_PASSWORD,
    });
  }

  if (fs.existsSync(seedConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(seedConfigPath, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>).email === 'string' &&
            typeof (entry as Record<string, unknown>).password === 'string'
          ) {
            const email = (entry as Record<string, unknown>).email as string;
            const password = (entry as Record<string, unknown>).password as string;
            if (!accounts.some((item) => item.email === email)) {
              accounts.push({ email, password });
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to parse seed file ${seedConfigPath}: ${error}`);
    }
  }

  if (accounts.length === 0) {
    // Final fallback for older setups.
    accounts.push({
      email: 'test-integration@example.com',
      password: 'TestIntegration123!',
    });
  }

  return accounts;
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

async function login(email: string, password: string): Promise<string | null> {
  const loginResponse = await fetch(`${baseUrl}.account/login/password/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!loginResponse.ok) {
    const body = await loginResponse.text();
    console.warn(`Login failed for ${email}: ${body}`);
    return null;
  }

  const loginResult = (await loginResponse.json()) as { authorization?: string };
  return loginResult.authorization ?? null;
}


async function createAccountToken(): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}.account/account/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      console.warn(`Account bootstrap failed: ${response.status} ${await response.text()}`);
      return null;
    }

    const data = (await response.json()) as { authorization?: string };
    return data.authorization ?? null;
  } catch (error) {
    console.warn(`Account bootstrap error: ${error}`);
    return null;
  }
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


async function ensurePasswordLogin(
  token: string,
  controls: AccountControls,
  email: string,
  password: string,
): Promise<void> {
  const createUrl = controls.controls.password?.create;
  if (!createUrl) {
    return;
  }

  try {
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const body = await response.text();
      // Existing login method should not block proceeding.
      if (!body.includes('already') && !body.includes('exists')) {
        console.warn(`Password login binding failed: ${response.status} ${body}`);
      }
    }
  } catch (error) {
    console.warn(`Password login binding error: ${error}`);
  }
}

async function createFreshPod(token: string, podCreateUrl: string): Promise<{ webId: string; podName: string } | null> {
  // Never use SOLID_TEST_POD_ID as a prefix because it is overwritten on every run.
  const baseName = process.env.SOLID_TEST_POD_PREFIX ?? 'test-integration';
  const candidateNames = [
    `${baseName}-${Date.now().toString(36)}`,
    `${baseName}-${Math.random().toString(36).slice(2, 8)}`,
  ];

  for (const podName of candidateNames) {
    const response = await fetch(podCreateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({ name: podName }),
    });

    if (response.ok) {
      const podData = (await response.json()) as PodCreationResult;
      if (podData.webId) {
        return { webId: podData.webId, podName };
      }
      console.error('Pod created but no webId returned:', JSON.stringify(podData));
      return null;
    }

    const text = await response.text();
    console.warn(`Create pod failed (${podName}): ${response.status} ${text.slice(0, 200)}`);
  }

  return null;
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
      name: `integration-test-${Date.now()}`,
      webId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('Failed to create client credentials:', text);
    return null;
  }

  return (await response.json()) as { id: string; secret: string };
}

function toApiKey(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  return `sk-${Buffer.from(raw).toString('base64')}`;
}

function updateEnvFile(clientId: string, clientSecret: string, webId: string, podName: string): string {
  let envContent = '';
  if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, 'utf8');
  }

  const apiKey = toApiKey(clientId, clientSecret);

  const updates: Record<string, string> = {
    CSS_BASE_URL: baseUrl.replace(/\/$/, ''),
    SOLID_CLIENT_ID: clientId,
    SOLID_CLIENT_SECRET: clientSecret,
    SOLID_API_KEY: apiKey,
    SOLID_WEBID: webId,
    SOLID_OIDC_ISSUER: baseUrl,
    SOLID_TEST_POD_ID: podName,
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
  return apiKey;
}

async function main(): Promise<void> {
  console.log('Setting up test credentials...');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Seed config: ${seedConfigPath}`);

  if (!(await checkServer())) {
    console.error('Server is not running. Please run `yarn test:integration:lite` (auto starts local xpod) or start xpod manually and set CSS_BASE_URL.');
    process.exit(1);
  }
  console.log('Server is running');

  const accounts = loadSeedAccounts();
  console.log(`Trying ${accounts.length} seed account(s)...`);

  let token: string | null = null;
  let activeEmail: string | null = null;
  let activePassword: string | null = null;

  for (const account of accounts) {
    console.log(`Logging in as ${account.email}...`);
    token = await login(account.email, account.password);
    if (token) {
      activeEmail = account.email;
      activePassword = account.password;
      break;
    }
  }

  const allowBootstrap = process.env.TEST_SETUP_ALLOW_BOOTSTRAP !== 'false';
  if (!token && allowBootstrap) {
    console.warn('Seed login failed, trying optional account bootstrap...');
    token = await createAccountToken();
    activeEmail = `bootstrap-${Date.now()}@test.local`;
    activePassword = process.env.SOLID_TEST_PASSWORD ?? 'TestIntegration123!';
  }

  if (!token || !activeEmail) {
    console.error('Failed to obtain account token from seeded accounts.');
    console.error(`Seed config: ${seedConfigPath}`);
    console.error('Hint: ensure seeded account password matches current server data, then rerun yarn test:setup.');
    process.exit(1);
  }

  console.log(`Account token ready: ${activeEmail}`);

  const controls = await getAccountControls(token);
  if (!controls) {
    console.error('Failed to get account controls');
    process.exit(1);
  }

  if (allowBootstrap && activeEmail && activePassword) {
    await ensurePasswordLogin(token, controls, activeEmail, activePassword);
  }

  const podCreateUrl = controls.controls?.account?.pod;
  const credCreateUrl = controls.controls?.account?.clientCredentials;
  if (!podCreateUrl || !credCreateUrl) {
    console.error('Pod/client credentials endpoints not found in controls:', JSON.stringify(controls, null, 2));
    process.exit(1);
  }

  console.log('Creating fresh pod...');
  const podInfo = await createFreshPod(token, podCreateUrl);
  if (!podInfo) {
    console.error('Failed to create pod for integration tests');
    process.exit(1);
  }
  console.log(`Pod ready: ${podInfo.webId}`);

  console.log('Creating fresh client credentials...');
  const credentials = await createClientCredentials(token, credCreateUrl, podInfo.webId);
  if (!credentials) {
    console.error('Failed to create client credentials');
    process.exit(1);
  }

  console.log(`Created credentials: ${credentials.id}`);
  const apiKey = updateEnvFile(credentials.id, credentials.secret, podInfo.webId, podInfo.podName);
  console.log('Credentials saved to .env.local');
  console.log(`Generated SOLID_API_KEY: ${apiKey.slice(0, 24)}...`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
