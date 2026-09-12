import type { AiProviderCredentialSummary } from './ai-connections-client'

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

export function healthTone(health: AiProviderCredentialSummary['health']): { row: string; dot: string } {
  if (health === 'healthy') {
    return { row: 'border-emerald-500/40 bg-emerald-500/5', dot: 'bg-emerald-500' }
  }
  if (health === 'unknown') {
    return { row: 'border-border/50 bg-background', dot: 'bg-muted-foreground/50' }
  }
  return { row: 'border-destructive/40 bg-destructive/5', dot: 'bg-destructive' }
}
