#!/usr/bin/env ts-node
/**
 * 开发环境初始化脚本
 *
 * 在 CSS + API Server 启动后运行，为 seed 账号创建 Client Credentials
 *
 * 前置条件:
 * 1. CSS 已启动并加载了 seed.dev.json
 * 2. API Server 已启动
 *
 * 用法:
 *   # 启动服务 (带 seed)
 *   CSS_SEED_CONFIG=./config/seed.dev.json yarn dev
 *
 *   # 运行初始化
 *   yarn ts-node scripts/init-dev-credentials.ts
 */

const CSS_BASE = process.env.CSS_BASE_URL ?? 'http://localhost:3000';
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001';

interface SeedAccount {
  email: string;
  password: string;
  podName: string;
}

const SEED_ACCOUNTS: SeedAccount[] = [
  { email: 'test@dev.local', password: 'test123456', podName: 'test' },
  { email: 'alice@dev.local', password: 'alice123456', podName: 'alice' },
  { email: 'bob@dev.local', password: 'bob123456', podName: 'bob' },
];

interface CredentialsResult {
  email: string;
  webId: string;
  clientId: string;
  clientSecret: string;
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('🔧 开发环境凭据初始化');
  console.log('='.repeat(60));
  console.log(`CSS: ${CSS_BASE}`);
  console.log(`API: ${API_BASE}`);
  console.log();

  const results: CredentialsResult[] = [];

  for (const account of SEED_ACCOUNTS) {
    console.log(`\n处理账号: ${account.email}`);
    console.log('-'.repeat(40));

    try {
      // 1. 登录获取 cookie
      const loginResult = await login(account.email, account.password);
      if (!loginResult.success) {
        console.log(`❌ 登录失败: ${loginResult.error}`);
        continue;
      }
      console.log(`✅ 登录成功`);

      // 2. 获取 WebID
      const webId = `${CSS_BASE}/${account.podName}/profile/card#me`;
      console.log(`   WebID: ${webId}`);

      // 3. 创建 Client Credentials
      const credResult = await createClientCredentials(loginResult.cookie!, account.podName);
      if (!credResult.success) {
        console.log(`❌ 创建凭据失败: ${credResult.error}`);
        continue;
      }
      console.log(`✅ Client Credentials 已创建`);
      console.log(`   client_id: ${credResult.clientId}`);

      // 4. 注册到 API Server (开发模式)
      if (process.env.NODE_ENV === 'development') {
        const regResult = await registerToApiServer(
          credResult.clientId!,
          credResult.clientSecret!,
          webId
        );
        if (regResult.success) {
          console.log(`✅ 已注册到 API Server`);
        } else {
          console.log(`⚠️  API Server 注册跳过: ${regResult.error}`);
        }
      }

      results.push({
        email: account.email,
        webId,
        clientId: credResult.clientId!,
        clientSecret: credResult.clientSecret!,
      });

    } catch (error) {
      console.log(`❌ 处理失败: ${error}`);
    }
  }

  // 输出结果
  console.log('\n');
  console.log('='.repeat(60));
  console.log('📋 凭据汇总');
  console.log('='.repeat(60));

  for (const r of results) {
    console.log(`\n[${r.email}]`);
    console.log(`WebID: ${r.webId}`);
    console.log(`XPOD_CLIENT_ID=${r.clientId}`);
    console.log(`XPOD_CLIENT_SECRET=${r.clientSecret}`);
  }

  // 输出环境变量文件
  if (results.length > 0) {
    const envContent = results.map(r => `
# ${r.email}
# WebID: ${r.webId}
XPOD_CLIENT_ID_${r.email.split('@')[0].toUpperCase()}=${r.clientId}
XPOD_CLIENT_SECRET_${r.email.split('@')[0].toUpperCase()}=${r.clientSecret}
`).join('\n');

    console.log('\n\n可添加到 .env.local:');
    console.log('-'.repeat(40));
    console.log(envContent);
  }
}

async function login(email: string, password: string): Promise<{
  success: boolean;
  cookie?: string;
  error?: string;
}> {
  try {
    // CSS 的登录流程
    // 1. 获取登录页面 (获取 CSRF token 和 session cookie)
    const loginPageRes = await fetch(`${CSS_BASE}/.account/login/password/`, {
      redirect: 'manual',
    });

    const cookies = loginPageRes.headers.get('set-cookie') ?? '';

    // 2. 提交登录表单
    const loginRes = await fetch(`${CSS_BASE}/.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
      },
      body: new URLSearchParams({ email, password }),
      redirect: 'manual',
    });

    if (loginRes.status === 302 || loginRes.status === 303) {
      const newCookies = loginRes.headers.get('set-cookie') ?? cookies;
      return { success: true, cookie: newCookies };
    }

    // 尝试 JSON API
    const jsonRes = await fetch(`${CSS_BASE}/.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookies,
      },
      body: JSON.stringify({ email, password }),
    });

    if (jsonRes.ok) {
      const newCookies = jsonRes.headers.get('set-cookie') ?? cookies;
      return { success: true, cookie: newCookies };
    }

    return { success: false, error: `Status ${loginRes.status}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function createClientCredentials(cookie: string, podName: string): Promise<{
  success: boolean;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}> {
  try {
    // CSS Client Credentials API
    const res = await fetch(`${CSS_BASE}/.account/client-credentials/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
      },
      body: JSON.stringify({
        name: `dev-credentials-${podName}`,
        webId: `${CSS_BASE}/${podName}/profile/card#me`,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `${res.status}: ${text}` };
    }

    const data = await res.json() as {
      id: string;
      secret: string;
    };

    return {
      success: true,
      clientId: data.id,
      clientSecret: data.secret,
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function registerToApiServer(
  clientId: string,
  clientSecret: string,
  webId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/dev/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        webId,
        displayName: `Dev: ${webId}`,
      }),
    });

    if (!res.ok) {
      return { success: false, error: `${res.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

main().catch(console.error);
