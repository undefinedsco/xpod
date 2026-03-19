/**
 * OAuth Credential Manager
 *
 * 管理 AI Provider 的 OAuth credentials：
 * - 存储到 Pod
 * - 从 Pod 读取
 * - Token 刷新
 */

import { drizzle } from '@undefineds.co/drizzle-solid';
import { OAuthCredential } from '../../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';
import type { Session } from '@inrupt/solid-client-authn-node';
import type { OAuthCredentials } from '@mariozechner/pi-ai/dist/utils/oauth/types.js';
import { getOAuthProvider } from '@mariozechner/pi-ai/dist/utils/oauth/index.js';

/**
 * 保存 OAuth credentials 到 Pod
 *
 * @param session - Solid session
 * @param providerId - Provider ID (e.g., 'codebuddy')
 * @param providerUri - Provider 的完整 URI (e.g., 'http://pod/settings/ai/providers.ttl#codebuddy')
 * @param credentials - OAuth credentials from provider.login()
 * @param label - 可选的标签
 */
export async function saveOAuthCredential(
  session: Session,
  providerId: string,
  providerUri: string,
  credentials: OAuthCredentials,
  label?: string,
): Promise<string> {
  const db: any = drizzle({
    fetch: session.fetch,
    info: session.info,
  } as any);

  // 生成 credential ID
  const credentialId = `oauth-${providerId}-${Date.now()}`;

  // 插入 OAuthCredential
  await db.insert(OAuthCredential).values({
    id: credentialId,
    provider: providerUri,
    service: ServiceType.AI,
    status: CredentialStatus.ACTIVE,
    label: label || `${providerId} OAuth`,
    oauthRefreshToken: credentials.refresh,
    oauthAccessToken: credentials.access,
    oauthExpiresAt: new Date(credentials.expires),
  });

  console.log(`✓ OAuth credential saved: ${credentialId}`);
  return credentialId;
}

/**
 * 刷新 OAuth token
 *
 * @param session - Solid session
 * @param credentialId - Credential ID
 * @param providerId - Provider ID (用于查找 OAuth provider)
 */
export async function refreshOAuthToken(
  session: Session,
  credentialId: string,
  providerId: string,
): Promise<void> {
  const db: any = drizzle({
    fetch: session.fetch,
    info: session.info,
  } as any);

  // 1. 读取现有 credential
  const allCredentials = await db.select().from(OAuthCredential);
  const credential = allCredentials.find((c: any) => c.id === credentialId);

  if (!credential) {
    throw new Error(`OAuth credential not found: ${credentialId}`);
  }

  // 2. 获取 OAuth provider
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`OAuth provider not found: ${providerId}`);
  }

  // 3. 刷新 token
  const oldCredentials: OAuthCredentials = {
    refresh: credential.oauthRefreshToken || '',
    access: credential.oauthAccessToken || '',
    expires: credential.oauthExpiresAt ? new Date(credential.oauthExpiresAt).getTime() : 0,
  };

  const newCredentials = await provider.refreshToken(oldCredentials);

  // 4. 更新 Pod 中的 credential
  await db.update(OAuthCredential)
    .set({
      oauthRefreshToken: newCredentials.refresh,
      oauthAccessToken: newCredentials.access,
      oauthExpiresAt: new Date(newCredentials.expires),
    })
    .where({ id: credentialId } as any);

  console.log(`✓ OAuth token refreshed: ${credentialId}`);
}

/**
 * 检查并自动刷新过期的 OAuth token
 *
 * @param session - Solid session
 * @param credentialId - Credential ID
 * @param providerId - Provider ID
 * @returns 是否成功刷新
 */
export async function ensureOAuthTokenValid(
  session: Session,
  credentialId: string,
  providerId: string,
): Promise<boolean> {
  const db: any = drizzle({
    fetch: session.fetch,
    info: session.info,
  } as any);

  // 读取 credential
  const allCredentials = await db.select().from(OAuthCredential);
  const credential = allCredentials.find((c: any) => c.id === credentialId);

  if (!credential) {
    return false;
  }

  // 检查是否过期（提前 5 分钟刷新）
  const expiresAt = credential.oauthExpiresAt ? new Date(credential.oauthExpiresAt) : null;
  if (!expiresAt) {
    return false;
  }

  const now = new Date();
  const fiveMinutesLater = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesLater) {
    // Token 还有效
    return true;
  }

  // Token 即将过期或已过期，尝试刷新
  try {
    await refreshOAuthToken(session, credentialId, providerId);
    return true;
  } catch (error) {
    console.error(`Failed to refresh OAuth token: ${error}`);
    return false;
  }
}
