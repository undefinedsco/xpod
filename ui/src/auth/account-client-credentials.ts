import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { storedAccountTokenHeaders } from '../utils/account-session';

/** CSS owns issuance and revocation; this host capability keeps Account auth out of applets. */
export function createAccountClientCredentialsCapability({
  collection,
  accountIndex,
  fetch: fetchImpl = window.fetch.bind(window),
}: {
  collection: string;
  accountIndex: string;
  fetch?: typeof fetch;
}): AiClientCredentialsCapability {
  // Keep only verified successful revocations for this host lifetime. A reload
  // deliberately loses this proof: an unknown 404 can also mean a wrong account.
  const revokedBindings = new Set<string>();
  const trustedUrl = async (value: string): Promise<string> => {
    const url = await resolveHostedAccountControlUrl(value, fetchImpl, accountIndex);
    if (!url || !new URL(url).pathname.startsWith('/.account/')) {
      throw new Error('客户端凭据地址不属于可信账号服务。');
    }
    return url;
  };
  const request = (url: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => fetchImpl(url, {
    method,
    credentials: 'include',
    redirect: 'error',
    headers: storedAccountTokenHeaders({ Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  return {
    async create({ name, webId }) {
      if (!name.trim() || !webId) throw new Error('创建客户端凭据需要名称和当前 WebID。');
      const response = await request(await trustedUrl(collection), 'POST', { name: name.trim(), webId });
      if (!response.ok) throw new Error(`创建客户端凭据失败（HTTP ${response.status}）。`);
      const value = await response.json() as Record<string, unknown>;
      if (typeof value.id !== 'string' || !value.id || value.id.includes(':')
        || typeof value.secret !== 'string' || !value.secret
        || typeof value.resource !== 'string' || !value.resource) {
        throw new Error('账号服务未返回有效的客户端凭据。');
      }
      const resource = await trustedUrl(value.resource);
      const bytes = new TextEncoder().encode(`${value.id}:${value.secret}`);
      const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
      return { apiKey: `sk-${encoded}`, resource };
    },
    async list() {
      // CSS owns the collection: one GET returns every credential the account
      // still knows about, keyed by label (which is the OIDC client id).
      const response = await request(await trustedUrl(collection), 'GET');
      if (!response.ok) throw new Error(`读取客户端凭据失败（HTTP ${response.status}）。`);
      const value = await response.json() as { clientCredentials?: Record<string, unknown> };
      const entries = Object.entries(value.clientCredentials ?? {});
      return Promise.all(entries.map(async ([label, path]) => ({
        clientId: label,
        label,
        resource: await trustedUrl(String(path)),
      })));
    },
    async revoke({ clientId, resource, webId }) {
      const url = await trustedUrl(resource);
      const binding = JSON.stringify([url, clientId, webId]);
      const detail = await request(url, 'GET');
      if (detail.status === 404 || detail.status === 410) {
        if (revokedBindings.has(binding)) return;
        throw new Error('无法确认客户端凭据已撤销，请检查当前 Account 登录；Key 记录已保留。');
      }
      if (!detail.ok) throw new Error(`读取客户端凭据失败（HTTP ${detail.status}）。`);
      const value = await detail.json() as Record<string, unknown>;
      if (value.id !== clientId || value.webId !== webId) {
        throw new Error('客户端凭据与当前 Key 或 WebID 不匹配，未执行删除。');
      }
      const response = await request(url, 'DELETE');
      if (!response.ok) {
        throw new Error(`撤销客户端凭据失败（HTTP ${response.status}）。`);
      }
      revokedBindings.add(binding);
    },
  };
}

