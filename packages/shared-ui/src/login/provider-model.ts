import type { LoginProviderOption, LoginProviderSource } from './types'

type ProviderShape = Partial<Pick<LoginProviderOption, 'oidcProvider' | 'storageProvider'>> & {
  source?: LoginProviderSource
}

export function resolveLoginProviderSource(provider: ProviderShape | null | undefined): LoginProviderSource {
  const oidcProviderKind = provider?.oidcProvider?.kind
  const storageProviderKind = provider?.storageProvider?.kind

  if (oidcProviderKind === 'cloud' && storageProviderKind === 'cloud') return 'cloud'
  if (oidcProviderKind === 'cloud' && storageProviderKind === 'local') return 'local'
  if (oidcProviderKind === 'local' && storageProviderKind === 'local') return 'standalone'
  if (oidcProviderKind === 'custom' && storageProviderKind === 'custom') return 'custom'

  return provider?.source ?? 'custom'
}

export function isLocalLoginProviderSource(source: LoginProviderSource): source is Extract<LoginProviderSource, 'local' | 'standalone'> {
  return source === 'local' || source === 'standalone'
}

export function isLocalLoginProvider(provider: ProviderShape | null | undefined): boolean {
  return isLocalLoginProviderSource(resolveLoginProviderSource(provider))
}
