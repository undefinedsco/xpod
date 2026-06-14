/**
 * CLI Authentication Helper
 *
 * 统一的认证入口。所有 Solid app 只从 `$SOLID_HOME/auth/credentials.json`
 * 这一套 shared Solid auth source 恢复权限；`~/.xpod/config.json` /
 * `~/.xpod/secrets.json` 不是 Solid auth source。
 */

import { authenticate, type PodAuth } from './solid-auth';
import { loadCredentials, isClientCredentials } from './credentials-store';

/**
 * 获取认证信息
 *
 * 规则：
 * 1. 只读取 shared Solid auth source：$SOLID_HOME/auth/credentials.json
 * 2. 如果没有，提示用户先运行 `xpod auth create-credentials`
 *
 * @returns PodAuth 或 null（如果没有保存的 credentials）
 */
export async function getAuth(): Promise<PodAuth | null> {
  const creds = loadCredentials();

  if (!creds) {
    return null;
  }

  // 检查是否是 client credentials
  if (!isClientCredentials(creds.secrets)) {
    console.error('Saved credentials are not client credentials.');
    console.error('Please run: xpod auth create-credentials');
    return null;
  }

  // 使用 client credentials 认证
  try {
    const oidcIssuer = creds.url;
    const auth = await authenticate(
      creds.secrets.clientId,
      creds.secrets.clientSecret,
      oidcIssuer,
    );

    return auth;
  } catch (error) {
    console.error('Authentication failed:', error);
    console.error('Your credentials may be expired or invalid.');
    console.error('Please run: xpod auth create-credentials');
    return null;
  }
}

/**
 * 获取认证信息，如果失败则退出进程
 *
 * @returns PodAuth
 */
export async function requireAuth(): Promise<PodAuth> {
  const auth = await getAuth();

  if (!auth) {
    console.error('\nNo credentials found. Please run:');
    console.error('  xpod auth create-credentials --email your@email.com');
    process.exit(1);
  }

  return auth;
}
