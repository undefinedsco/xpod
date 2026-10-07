import { describe, expect, it } from 'vitest'
import { credentialFailurePresentation } from '../src/credential-labels'
import type { AiProviderCredentialSummary } from '../src/contract/ai-connections-client'
const credential = { enabled: true, health: 'healthy', authMode: 'apiKey' } as AiProviderCredentialSummary

describe('credential failure presentation', () => {
  it.each([
    ['authentication', 'key', '密钥无效'],
    ['login_expired', 'login', '登录已过期'],
    ['quota_exhausted', 'charge', '额度用完了'],
    ['authorization', 'reason', '没有这个模型或地区的权限'],
  ] as const)('maps %s to its recovery action', (lastFailureCode, action, message) => {
    expect(credentialFailurePresentation({ ...credential, lastFailureCode })).toMatchObject({ action, message: expect.stringContaining(message) })
  })
  it('automatically removes the rate-limit message when the cooldown expires', () => {
    const reset = new Date('2026-10-02T00:01:00Z')
    const value = { ...credential, lastFailureCode: 'rate_limited', rateLimitResetAt: reset.toISOString() }
    expect(credentialFailurePresentation(value, reset.getTime() - 1)?.message).toContain('自动恢复')
    expect(credentialFailurePresentation(value, reset.getTime())).toBeUndefined()
  })
  it('keeps disabled credentials and provider-wide outages out of per-key errors', () => {
    expect(credentialFailurePresentation({ ...credential, lastFailureCode: 'upstream_unavailable' })).toBeUndefined()
    expect(credentialFailurePresentation({ ...credential, enabled: false, lastFailureCode: 'authentication' })).toBeUndefined()
  })
})
