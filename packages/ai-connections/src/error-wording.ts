import type { AiConnectionsClient, AiConnectionsProvider } from './contract/ai-connections-client'
import { AiConnectionsRequestError, aiConnectionsErrorCode } from './contract/ai-connections-client'

/**
 * The wording a failed AI Connection request is shown under.
 *
 * This used to live in the shared core, which meant the published contract
 * carried sentences: nine Chinese messages plus the English fallbacks, and every
 * consumer of the client - the applet and the web app - displayed wording chosen
 * by a package that has no idea who is rendering it. The core now classifies a
 * failure and hands over its code; the sentence is chosen here, where it is read.
 *
 * The rules below are a move, not a rewrite: the same codes map to the same
 * sentences as before, so nothing a user reads changes.
 */

const AI_CONNECTIONS_GENERIC_ERROR_MESSAGE = 'AI Connection request failed. Please try again.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const LOCAL_SESSION_REFRESH_FAILED_MESSAGE = '订阅登录态自动刷新失败，请稍后重试。'
const LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE = '订阅登录态已失效，请在原客户端重新登录后重读，或使用设备码登录。'

const OAUTH_MODEL_AUTH_FAILED_MESSAGE = '订阅登录态不可用，请重读登录态或重新登录后再同步模型。'

const MODEL_DISCOVERY_SAFE_MESSAGES = new Set([
  OAUTH_MODEL_AUTH_FAILED_MESSAGE,
  LOCAL_SESSION_REFRESH_FAILED_MESSAGE,
  LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE,
  '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。',
  '模型服务地址不正确。请检查服务地址后重试。',
  '请求太频繁。请稍等一会儿再试。',
  '模型服务暂时没有响应。请稍后重试。',
  '模型列表获取失败。请检查密钥、服务地址或网络后重试。',
])

function normalizeAiConnectionsErrorText(message: string): string {
  if (message.startsWith('provider_models_response_error:')) {
    return sanitizeProviderResponseMessage(message.slice('provider_models_response_error:'.length))
      ?? '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
  }
  const exact = messageForSafeErrorCode(message)
  if (exact) return exact
  const prefix = message.split(':', 1)[0]?.trim()
  const prefixed = prefix ? messageForSafeErrorCode(prefix) : undefined
  if (prefixed) return prefixed
  if (message === 'AI Connection service identity is unavailable') return message
  if (MODEL_DISCOVERY_SAFE_MESSAGES.has(message)) return message
  if (isModelDiscoveryMessageWithProviderDetail(message)) return message
  if (message.startsWith('invalid_')) return 'AI Connection returned an invalid response.'
  return AI_CONNECTIONS_GENERIC_ERROR_MESSAGE
}


/**
 * The sentence to show for anything a request threw.
 *
 * A failed request carries the facts - the wire code, the upstream status, the
 * request's provider and auth mode - so the sentence is chosen from those rather
 * than parsed back out of a message. Anything that is not a request failure (a
 * thrown string, an unexpected `Error`) still goes through the sanitiser, which
 * is what keeps internals off the screen.
 */
export function aiConnectionsErrorMessage(error: unknown): string {
  if (error instanceof AiConnectionsRequestError) {
    return aiConnectionsErrorMessageForPayload(error.payload, error.status, {
      provider: error.provider as AiConnectionsProvider | undefined,
      authMode: error.authMode as 'apiKey' | 'deviceCodeOAuth' | 'local' | undefined,
    })
  }
  if (error instanceof Error) {
    return normalizeAiConnectionsErrorText(error.message)
  }
  return normalizeAiConnectionsErrorText(String(error))
}

export function aiConnectionsErrorMessageForPayload(
  payload: unknown,
  status: number,
  context: { provider?: AiConnectionsProvider; authMode?: 'apiKey' | 'deviceCodeOAuth' | 'local' } = {},
): string {
  const code = aiConnectionsErrorCode(payload)
  if (code === 'provider_models_response_error') {
    const message = isRecord(payload) && typeof payload.message === 'string'
      ? sanitizeProviderResponseMessage(payload.message)
      : undefined
    if (message) return message
    return '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
  }
  if (code === 'provider_models_fetch_failed') {
    const providerStatus = isRecord(payload) && typeof payload.providerStatus === 'number'
      ? payload.providerStatus
      : undefined
    const providerMessage = isRecord(payload) && typeof payload.providerMessage === 'string'
      ? payload.providerMessage.trim()
      : undefined
    return withProviderMessage(modelDiscoveryErrorMessage(providerStatus, context.authMode), providerMessage)
  }
  const coded = code ? messageForSafeErrorCode(code, context.provider) : undefined
  if (coded) return coded

  const text = isRecord(payload) && typeof payload.error === 'string'
    ? payload.error
    : undefined
  if (text) {
    const exact = messageForSafeErrorCode(text, context.provider)
    if (exact) return exact
    if (text === 'AI Connection service identity is unavailable') {
      return text
    }
    if (text === 'Provider credential not found for current identity') {
      return '当前身份没有可用的额度凭证。'
    }
    if (text === 'Provider quota adapter not found' || text === 'Provider quota lookup failed') {
      return '该接入方式不支持查询官方额度。'
    }
  }

  if (status === 401) return 'Please sign in again to continue.'
  if (status === 403) return 'AI Connection permission was denied.'
  if (status === 404 && context.provider) {
    return `${providerLabel(context.provider)} connection is not configured.`
  }
  if (status === 429) return 'AI Connection is rate limited. Please try again later.'
  if (status === 503) return 'AI Connection service is unavailable.'
  return AI_CONNECTIONS_GENERIC_ERROR_MESSAGE
}


function messageForSafeErrorCode(
  code: string,
  provider?: AiConnectionsProvider,
): string | undefined {
  switch (code.trim().toLowerCase().replace(/-/g, '_')) {
    case 'not_configured':
    case 'notconfigured':
      return provider
        ? `${providerLabel(provider)} connection is not configured.`
        : 'AI provider connection is not configured.'
    case 'unsupported':
      return provider
        ? `${providerLabel(provider)} does not support this operation.`
        : 'This AI Connection operation is not supported.'
    case 'service_identity_unavailable':
      return 'AI Connection service identity is unavailable'
    case 'unauthorized':
      return 'Please sign in again to continue.'
    case 'forbidden':
    case 'permission_denied':
      return 'AI Connection permission was denied.'
    case 'rate_limited':
      return 'AI Connection is rate limited. Please try again later.'
    case 'service_unavailable':
      return 'AI Connection service is unavailable.'
    case 'unsafe_provider_base_url':
      return '该服务地址指向 Xpod 不允许访问的网络，请改用公网 HTTPS 地址。'
    case 'invalid_proxy_url':
      return '代理地址必须是无账号密码的 HTTP 或 HTTPS 地址。'
    case 'oauth_refresh_failed':
    case 'oauth_refresh_unavailable':
    case 'local_session_refresh_failed':
      return LOCAL_SESSION_REFRESH_FAILED_MESSAGE
    case 'oauth_session_reauth_required':
    case 'oauth_refresh_token_required':
    case 'local_session_reauth_required':
    case 'local_session_missing_refresh_token':
      return LOCAL_SESSION_REAUTH_REQUIRED_MESSAGE
    case 'models_persistence_failed':
      return '模型已获取，但保存到 Pod 失败。请重试同步模型。'
    case 'quota_credential_not_found':
      return '当前身份没有可用的额度凭证。'
    case 'credential_secret_unavailable':
      return '当前凭证密钥不可用，请重新保存后再查询额度。'
    case 'gateway_api_key_plaintext_unavailable':
      return 'Pod 中未找到此 API Key 的原文，无法复制配置。请创建新的 Key，更新客户端后再删除旧 Key。'
    case 'quota_adapter_not_found':
      return '该接入方式不支持查询官方额度。'
    default:
      return undefined
  }
}

function modelDiscoveryErrorMessage(providerStatus: number | undefined, authMode?: string): string {
  if (providerStatus === 401 || providerStatus === 403) {
    if (authMode === 'deviceCodeOAuth') return OAUTH_MODEL_AUTH_FAILED_MESSAGE
    return '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。'
  }
  if (providerStatus === 404) {
    return '模型服务地址不正确。请检查服务地址后重试。'
  }
  if (providerStatus === 429) {
    return '请求太频繁。请稍等一会儿再试。'
  }
  if (providerStatus !== undefined && providerStatus >= 500) {
    return '模型服务暂时没有响应。请稍后重试。'
  }
  return '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
}

function withProviderMessage(message: string, providerMessage: string | undefined): string {
  const sanitized = providerMessage ? sanitizeProviderResponseMessage(providerMessage) : undefined
  if (!sanitized) return message
  return `${message} 上游返回：${sanitized}`
}

function isModelDiscoveryMessageWithProviderDetail(message: string): boolean {
  const marker = ' 上游返回：'
  const index = message.indexOf(marker)
  if (index <= 0) return false
  return MODEL_DISCOVERY_SAFE_MESSAGES.has(message.slice(0, index))
}

function sanitizeProviderResponseMessage(value: string): string | undefined {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:sk|id)[._-][A-Za-z0-9._-]{8,}/gu, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/giu, '[URL]')
    .trim()
    .slice(0, 240)
  return sanitized || undefined
}

function providerLabel(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI'
    case 'anthropic': return 'Anthropic'
    case 'kimi': return 'Kimi'
    case 'bailian': return 'Bailian'
    case 'deepseek': return 'DeepSeek'
    case 'zhipu': return 'Zhipu'
    case 'ollama': return 'Ollama'
    case 'custom': return 'Custom'
  }
}

/**
 * The shared client reports a failure by naming its code; the sentence a user
 * reads is the applet's (`error-wording`). This app renders messages straight
 * from the thrown error, so it relabels them once, at its own boundary, instead
 * of letting a code reach the screen or teaching every call site to translate.
 * The error object itself is rethrown unchanged, so callers that inspect it -
 * `instanceof`, `code`, `providerStatus` - keep working.
 */
export function withDisplayableErrors(client: AiConnectionsClient): AiConnectionsClient {
  const wrapped: Record<string, unknown> = { ...client };
  for (const [key, value] of Object.entries(client)) {
    if (typeof value !== 'function') continue;
    wrapped[key] = async (...args: unknown[]) => {
      try {
        return await (value as (...rest: unknown[]) => unknown).apply(client, args);
      } catch (error) {
        if (error instanceof AiConnectionsRequestError) {
          error.message = aiConnectionsErrorMessage(error);
        }
        throw error;
      }
    };
  }
  return wrapped as unknown as AiConnectionsClient;
}
