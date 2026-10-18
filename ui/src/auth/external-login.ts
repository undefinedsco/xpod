import { storedAccountTokenHeaders } from '../utils/account-session';

interface PendingLogin { proof: string; callback: string; created: number }
const prefix = 'xpod.external-login.';

export class ExternalLoginCallbackError extends Error {
  public readonly retryTo: string;
  public constructor(message: string, retryTo: string) {
    super(message);
    this.retryTo = retryTo;
  }
}

function accountUrl(value: string): URL {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/.account/') || url.username || url.password || url.hash || url.search) {
    throw new Error('登录地址不属于当前账号服务。');
  }
  return url;
}

export async function beginExternalLogin(login: string, intent: 'login' | 'register' | 'link', remember: boolean, fetchImpl = fetch): Promise<string> {
  const target = accountUrl(login);
  // Availability must be known before the one-time server transaction is created.
  window.sessionStorage.setItem(`${prefix}probe`, '1');
  window.sessionStorage.removeItem(`${prefix}probe`);
  for (const key of Object.keys(window.sessionStorage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const previous = JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as PendingLogin;
      if (previous.created + 10 * 60_000 < Date.now()) window.sessionStorage.removeItem(key);
    } catch { window.sessionStorage.removeItem(key); }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const proof = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetchImpl(target.href, {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: storedAccountTokenHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify({ intent, proof, remember }),
  });
  const body = await response.json();
  if (!response.ok || typeof body.state !== 'string' || !/^[\w-]{43}$/u.test(body.state) || typeof body.authorizationUrl !== 'string' || typeof body.callback !== 'string') {
    throw new Error('暂时无法开始登录，请重试。');
  }
  const callback = accountUrl(body.callback);
  const authorization = new URL(body.authorizationUrl);
  if (authorization.protocol !== 'https:' || authorization.username || authorization.password) throw new Error('无效的授权地址。');
  const pending: PendingLogin = { proof, callback: callback.href, created: Date.now() };
  window.sessionStorage.setItem(`${prefix}${body.state}`, JSON.stringify(pending));
  return authorization.href;
}

/** Strip OAuth parameters before any asynchronous work. The verifier stays tab-scoped. */
export async function completeExternalLogin(fetchImpl = fetch): Promise<{ authorization?: string; location: string }> {
  const url = new URL(window.location.href);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const duplicate = url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1;
  window.history.replaceState(null, '', url.pathname);
  if (!state || !/^[\w-]{43}$/u.test(state) || !code || duplicate) throw new Error('授权已取消或回调无效，请重新登录。');
  const key = `${prefix}${state}`;
  const saved = window.sessionStorage.getItem(key);
  window.sessionStorage.removeItem(key);
  if (!saved) throw new Error('没有找到本次登录，请在发起登录的浏览器窗口重试。');
  const pending = JSON.parse(saved) as PendingLogin;
  const callback = accountUrl(pending.callback);
  const retryTo = callback.pathname.replace(/\/login\/[^/]+\/callback\/$/u, '/login/password/');
  // The stored completion route may include a CSS interaction. Its canonical
  // provider/callback suffix must match the public page that WeChat returned to.
  const canonical = callback.pathname.replace(/\/interaction\/[^/]+/u, '');
  if (canonical !== url.pathname || pending.created + 10 * 60_000 <= Date.now() || pending.created > Date.now()
    || !/^[\w-]{43,128}$/u.test(pending.proof)) throw new ExternalLoginCallbackError('登录已过期，请重新登录。', retryTo);
  const response = await fetchImpl(callback.href, {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: storedAccountTokenHeaders({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify({ code, state, proof: pending.proof }),
  });
  const body = await response.json();
  if (!response.ok) throw new ExternalLoginCallbackError('登录未完成。请确认已绑定账号；首次使用请选择创建账号后重试。', retryTo);
  if (typeof body.authorization !== 'string' || typeof body.location !== 'string') throw new Error('登录结果无效，请重新登录。');
  const location = new URL(body.location, window.location.origin);
  if (location.origin !== window.location.origin || location.username || location.password || !['http:', 'https:'].includes(location.protocol)) throw new Error('无效的登录返回地址。');
  return { authorization: body.authorization, location: location.href };
}
