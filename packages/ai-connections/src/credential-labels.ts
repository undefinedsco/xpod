import type { AiProviderCredentialSummary } from './contract/ai-connections-client'

/** Highest priority first: a new credential joins the end of the pool. */
export function nextCredentialPriority(credentials: AiProviderCredentialSummary[]): number {
  if (credentials.length === 0) return 10
  return Math.max(...credentials.map((credential) => credential.priority)) + 10
}

export function credentialDisplayLabel(credential: AiProviderCredentialSummary): string {
  if (credential.label?.trim()) return credential.label
  if (credential.maskedHint) return `API Key · ${credential.maskedHint}`
  if (credential.authMode === 'oauth' || credential.authMode === 'deviceCode') return '已授权账号'
  return 'API Key'
}

/** Account names are shown inside a pool; only the domain stays readable. */
export function maskAccountLabel(value: string): string {
  const at = value.indexOf('@')
  if (at > 0) {
    const accountName = value.slice(0, at)
    const visible = accountName.length > 6
      ? `${accountName.slice(0, 3)}***${accountName.slice(-2)}`
      : accountName.length > 1
      ? `${accountName[0]}***${accountName[accountName.length - 1]}`
      : `${accountName[0]}***`
    return `${visible}${value.slice(at)}`
  }
  return value
}

export function healthLabel(health: AiProviderCredentialSummary['health']): string {
  if (health === 'healthy') return '有效'
  if (health === 'unknown') return '未验证'
  if (health === 'expired') return '已过期'
  return '错误'
}

/**
 * Tone of one credential row: the tint the row carries and the colour of its
 * health dot. The row's border and dividers belong to the list container now, so
 * the tone is a background rather than a box.
 */
export function healthTone(health: AiProviderCredentialSummary['health']): { row: string; dot: string } {
  if (health === 'healthy') {
    return { row: 'bg-emerald-500/5', dot: 'bg-emerald-500' }
  }
  if (health === 'unknown') {
    return { row: 'bg-background', dot: 'bg-muted-foreground/50' }
  }
  return { row: 'bg-destructive/5', dot: 'bg-destructive' }
}

export function credentialFailurePresentation(credential: AiProviderCredentialSummary, now = Date.now()): {
  message: string; action?: 'key' | 'login' | 'charge' | 'reason'
} | undefined {
  if (!credential.enabled) return undefined
  switch (credential.lastFailureCode) {
    case 'authentication': return { message: '密钥无效或已被撤销，已跳过', action: 'key' }
    case 'login_expired': return { message: '登录已过期', action: 'login' }
    case 'quota_exhausted': return { message: '额度用完了', action: 'charge' }
    case 'authorization': return { message: '没有这个模型或地区的权限', action: 'reason' }
    case 'rate_limited': {
      const reset = credential.rateLimitResetAt ? new Date(credential.rateLimitResetAt) : undefined
      if (reset && reset.getTime() <= now) return undefined
      return { message: reset && Number.isFinite(reset.getTime())
        ? `请求太频繁，${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 后自动恢复；先换用下一条连接`
        : '请求太频繁，稍后自动恢复；先换用下一条连接' }
    }
    case 'upstream_unavailable': return undefined
  }
  if (credential.health === 'expired') return { message: '登录已过期', action: 'login' }
  if (credential.health === 'invalid') return { message: '密钥无效或已被撤销，已跳过', action: credential.authMode === 'apiKey' ? 'key' : 'login' }
  return undefined
}
