/**
 * Seed Pod CLI Module
 *
 * 提供对 seed pod 的管理功能：
 * - status: 查看 seed pod 状态
 * - credentials: 生成测试凭证
 * - reset: 重置 seed pod
 *
 * 安全限制：只能操作 seed 配置中定义的账户，不能操作任意用户。
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface SeedAccount {
  email: string;
  password: string;
  pods?: Array<{ name: string }>;
}

export interface SeedCredentials {
  clientId: string;
  clientSecret: string;
  webId: string;
  podUrl: string;
  issuer: string;
}

const DEFAULT_SEED_PATH = 'config/seeds/test.json';
const DEFAULT_BASE_URL = 'http://localhost:3000/';

/**
 * 加载 seed 配置
 */
export function loadSeedConfig(seedPath?: string): SeedAccount[] {
  const configPath = seedPath || process.env.CSS_SEED_CONFIG || path.resolve(process.cwd(), DEFAULT_SEED_PATH);

  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      console.error('Seed config must be an array');
      return [];
    }

    return parsed.filter(
      (entry): entry is SeedAccount =>
        typeof entry?.email === 'string' && typeof entry?.password === 'string'
    );
  } catch (error) {
    console.error(`Failed to parse seed config: ${error}`);
    return [];
  }
}

/**
 * 获取服务 Base URL
 */
export function getBaseUrl(): string {
  const raw = process.env.CSS_BASE_URL || DEFAULT_BASE_URL;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * 检查服务是否运行
 */
export async function checkServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}.account/`, {
      headers: { Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 使用 seed 账户登录
 */
export async function loginWithSeed(
  baseUrl: string,
  email: string,
  password: string
): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as { authorization?: string };
    return result.authorization ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取账户控制端点
 */
async function getAccountControls(
  baseUrl: string,
  token: string
): Promise<{
  podCreate?: string;
  credCreate?: string;
} | null> {
  try {
    const response = await fetch(`${baseUrl}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as {
      controls?: {
        account?: {
          pod?: string;
          clientCredentials?: string;
        };
      };
    };

    return {
      podCreate: result.controls?.account?.pod,
      credCreate: result.controls?.account?.clientCredentials,
    };
  } catch {
    return null;
  }
}

/**
 * 创建新的 OAuth 客户端凭证
 */
async function createCredentials(
  credCreateUrl: string,
  token: string,
  webId: string
): Promise<{ id: string; secret: string } | null> {
  try {
    const response = await fetch(credCreateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({
        name: `seed-credentials-${Date.now()}`,
        webId,
      }),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as { id: string; secret: string };
  } catch {
    return null;
  }
}

/**
 * 发现 OIDC Issuer
 */
async function discoverIssuer(baseUrl: string, webId: string): Promise<string> {
  try {
    const profileUrl = webId.split('#')[0];
    const response = await fetch(profileUrl, {
      headers: { Accept: 'text/turtle, application/ld+json' },
    });

    if (!response.ok) {
      return baseUrl;
    }

    const body = await response.text();
    const match = body.match(/<http:\/\/www\.w3\.org\/ns\/solid\/terms#oidcIssuer>\s*<([^>]+)>/);
    return match ? match[1] : baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * seed status 命令
 */
export async function seedStatus(seedPath?: string): Promise<void> {
  const baseUrl = getBaseUrl();
  console.log(`Base URL: ${baseUrl}`);

  const isRunning = await checkServer(baseUrl);
  console.log(`Server: ${isRunning ? 'running' : 'not running'}`);

  const accounts = loadSeedConfig(seedPath);
  console.log(`Seed accounts: ${accounts.length}`);

  for (const account of accounts) {
    console.log(`  - ${account.email}`);
    if (account.pods) {
      for (const pod of account.pods) {
        console.log(`    pod: ${pod.name}`);
      }
    }
  }

  if (!isRunning) {
    console.log('\nServer is not running. Start with: xpod start');
  }
}

/**
 * seed credentials 命令
 *
 * 生成 seed pod 的测试凭证，输出到控制台。
 * 只能操作 seed 配置中定义的账户。
 */
export async function seedCredentials(seedPath?: string): Promise<void> {
  const baseUrl = getBaseUrl();
  console.log(`Base URL: ${baseUrl}`);

  // 检查服务
  if (!(await checkServer(baseUrl))) {
    console.error('Server is not running. Start with: xpod start');
    return;
  }

  // 加载 seed 配置
  const accounts = loadSeedConfig(seedPath);
  if (accounts.length === 0) {
    console.error('No seed accounts found in config');
    return;
  }

  // 尝试登录
  let token: string | null = null;
  let activeAccount: SeedAccount | null = null;

  for (const account of accounts) {
    console.log(`Trying login: ${account.email}`);
    token = await loginWithSeed(baseUrl, account.email, account.password);
    if (token) {
      activeAccount = account;
      break;
    }
  }

  if (!token || !activeAccount) {
    console.error('Failed to login with any seed account');
    return;
  }

  console.log(`Logged in: ${activeAccount.email}`);

  // 获取控制端点
  const controls = await getAccountControls(baseUrl, token);
  if (!controls?.credCreate) {
    console.error('Failed to get account controls');
    return;
  }

  // 获取或创建 WebID
  // 假设 seed 账户已有 pod，使用第一个 pod 的 webId
  const podName = activeAccount.pods?.[0]?.name || 'test';
  const webId = `${baseUrl}${podName}/profile/card#me`;
  const podUrl = `${baseUrl}${podName}/`;

  // 创建凭证
  console.log('Creating credentials...');
  const creds = await createCredentials(controls.credCreate, token, webId);

  if (!creds) {
    console.error('Failed to create credentials');
    return;
  }

  const issuer = await discoverIssuer(baseUrl, webId);

  const result: SeedCredentials = {
    clientId: creds.id,
    clientSecret: creds.secret,
    webId,
    podUrl,
    issuer,
  };

  // 输出
  console.log('\n# Seed Pod Credentials');
  console.log(`CLIENT_ID=${result.clientId}`);
  console.log(`CLIENT_SECRET=${result.clientSecret}`);
  console.log(`WEBID=${result.webId}`);
  console.log(`ISSUER=${result.issuer}`);

  // Credentials output to console
}

/**
 * seed reset 命令
 *
 * 重置 seed pod 数据。当前仅输出提示，实际实现需要清理 Pod 数据。
 */
export async function seedReset(seedPath?: string): Promise<void> {
  const baseUrl = getBaseUrl();
  console.log(`Base URL: ${baseUrl}`);

  if (!(await checkServer(baseUrl))) {
    console.error('Server is not running. Start with: xpod start');
    return;
  }

  const accounts = loadSeedConfig(seedPath);
  console.log(`Seed accounts to reset: ${accounts.length}`);

  // TODO: 实现实际的 pod 重置逻辑
  console.log('\nWarning: seed reset is not fully implemented yet.');
  console.log('To reset, you may need to:');
  console.log('  1. Stop the server');
  console.log('  2. Delete the data directory');
  console.log('  3. Restart the server');
}
