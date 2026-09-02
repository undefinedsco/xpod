import type { LoginProviderOption } from './types'
import { resolveLoginProviderSource } from './provider-model'

export interface ProviderStatusBadge {
  label: string
  tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
}

export function getProviderDisplayLabel(provider: LoginProviderOption): string {
  const source = resolveLoginProviderSource(provider)

  if (source === 'local') {
    return '本地空间'
  }

  if (source === 'standalone') {
    return '独立空间'
  }

  if (source === 'cloud') {
    return '云端空间'
  }

  return provider.label
}

export function getProviderSourceLabel(provider: LoginProviderOption): string {
  switch (resolveLoginProviderSource(provider)) {
    case 'cloud':
      return '云端'
    case 'local':
      return '本地'
    case 'standalone':
      return '独立'
    default:
      return '其他'
  }
}

export function getProviderSubtitle(provider: LoginProviderOption, isFailed: boolean): string {
  if (isFailed) {
    return '连接失败，请重试'
  }

  const source = resolveLoginProviderSource(provider)

  if (source === 'cloud') {
    return '云端空间'
  }

  if (source === 'local') {
    return '本地空间'
  }

  if (source === 'standalone') {
    return '本机空间'
  }

  if (provider.runtime?.kind === 'local-pod') {
    return '本地空间'
  }

  return new URL(provider.url).hostname
}

export function getProviderInfoText(provider: LoginProviderOption, isFailed: boolean): string {
  if (isFailed) {
    return '连接失败，请检查网络或服务状态后重试。'
  }

  const source = resolveLoginProviderSource(provider)

  if (source === 'cloud') {
    return '使用云端账号登录，数据保存在云端。'
  }

  if (source === 'local') {
    return '使用云端账号登录，数据写入这台电脑上的本地空间。'
  }

  if (source === 'standalone') {
    return '账号和数据都留在这台电脑，不绑定云端账号。'
  }

  return '使用这个服务登录，数据也保存在这里。'
}

export function getProviderActionLabel(provider: LoginProviderOption): string {
  const source = resolveLoginProviderSource(provider)

  if (source === 'cloud') {
    return '登录'
  }

  if (source === 'custom') {
    return '连接'
  }

  if (provider.runtime?.kind === 'local-pod') {
    const onboarding = provider.runtime.onboarding
    if (onboarding) {
      switch (onboarding.state) {
        case 'space_required':
          return '开始'
        case 'idle':
          return '启动'
        case 'checking':
        case 'starting':
          return '查看'
        case 'repair_required':
          return '设置'
        case 'ready':
          return '登录'
        case 'error':
          return '修复'
      }
    }

    switch (provider.runtime.status) {
      case 'missing':
        return '开始'
      case 'stopped':
        return provider.runtime.canStart ? '启动' : '查看'
      case 'starting':
        return '查看'
      case 'running':
        return '登录'
      case 'error':
        return '修复'
    }
  }

  return '进入'
}

export function getProviderStatusBadge(provider: LoginProviderOption): ProviderStatusBadge | null {
  const source = resolveLoginProviderSource(provider)

  if (source === 'cloud') {
    return { label: '官方', tone: 'primary' }
  }

  if (source === 'local' && provider.runtime?.onboarding?.state === 'ready') {
    return { label: '可用', tone: 'success' }
  }

  if (source === 'standalone' && provider.runtime?.onboarding?.state === 'ready') {
    return { label: '可用', tone: 'success' }
  }

  if (provider.runtime?.kind === 'local-pod') {
    const onboarding = provider.runtime.onboarding
    if (onboarding) {
      switch (onboarding.state) {
        case 'space_required':
          return { label: '未配置', tone: 'neutral' }
        case 'idle':
          return { label: '继续', tone: 'neutral' }
        case 'checking':
        case 'starting':
          return { label: '准备中', tone: 'primary' }
        case 'repair_required':
          return { label: '需设置', tone: 'warning' }
        case 'ready':
          return { label: '就绪', tone: 'success' }
        case 'error':
          return { label: '需修复', tone: 'danger' }
      }
    }

    switch (provider.runtime.status) {
      case 'starting':
        return { label: '准备中', tone: 'primary' }
      case 'running':
        return { label: '就绪', tone: 'success' }
      case 'error':
        return { label: '需修复', tone: 'danger' }
      case 'stopped':
        return provider.runtime.canStart
          ? { label: '继续', tone: 'neutral' }
          : null
      case 'missing':
        return { label: '未配置', tone: 'neutral' }
    }
  }

  return null
}
