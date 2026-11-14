/**
 * Legacy client-credentials authentication helper.
 *
 * Descriptor/resource/rdf/secret CLI commands use `auth-context.ts`, which
 * supports both shared Solid OAuth sessions and client credentials. Keep this
 * helper only for legacy callers that explicitly need a Solid Node Session from
 * client credentials.
 */

import { authenticate, type PodAuth } from './solid-auth';
import { loadCredentials, isClientCredentials } from './credentials-store';

/**
 * 获取 client-credentials 认证信息。
 *
 * 规则：
 * 1. 只读取 shared Solid auth source：$SOLID_HOME/auth/credentials.json
 * 2. OAuth credentials intentionally return null here; use auth-context for
 *    resource operations.
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
