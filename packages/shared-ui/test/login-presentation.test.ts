import { describe, expect, it } from 'vitest'

import {
  getProviderActionLabel,
  getProviderInfoText,
  getProviderStatusBadge,
  getProviderSubtitle,
  resolveLoginProviderSource,
  type LoginProviderOption,
} from '../src'

function localProvider(state: 'space_required' | 'repair_required' | 'ready'): LoginProviderOption {
  return {
    id: 'local',
    url: 'http://localhost:5737',
    label: 'Local',
    source: 'local',
    oidcProvider: { kind: 'cloud', url: 'https://id.undefineds.co', label: 'Cloud' },
    storageProvider: { kind: 'local', url: 'http://localhost:5737', label: 'Local' },
    runtime: {
      kind: 'local-pod',
      status: state === 'ready' ? 'running' : 'missing',
      canStart: state !== 'ready',
      canCreate: state === 'space_required',
      onboarding: { state, spaceKind: state === 'space_required' ? null : 'local', message: null },
    },
  }
}

describe('LinX provider presentation parity', () => {
  it('derives source from the OIDC/storage pair before the legacy source field', () => {
    expect(resolveLoginProviderSource({
      source: 'custom',
      oidcProvider: { kind: 'cloud', url: 'https://id.example', label: 'Cloud' },
      storageProvider: { kind: 'local', url: 'http://localhost:5737', label: 'Local' },
    })).toBe('local')
  })

  it('preserves Cloud copy and official badge', () => {
    const cloud: LoginProviderOption = {
      id: 'cloud',
      url: 'https://cloud.example.com',
      label: 'Cloud',
      source: 'cloud',
      oidcProvider: { kind: 'cloud', url: 'https://cloud.example.com', label: 'Cloud' },
      storageProvider: { kind: 'cloud', url: 'https://cloud.example.com', label: 'Cloud' },
    }
    expect(getProviderSubtitle(cloud, false)).toBe('云端空间')
    expect(getProviderInfoText(cloud, false)).toBe('使用云端账号登录，数据保存在云端。')
    expect(getProviderStatusBadge(cloud)).toEqual({ label: '官方', tone: 'primary' })
    expect(getProviderActionLabel(cloud)).toBe('登录')
  })

  it('preserves Local onboarding action mapping', () => {
    expect(getProviderActionLabel(localProvider('space_required'))).toBe('开始')
    expect(getProviderActionLabel(localProvider('repair_required'))).toBe('设置')
    expect(getProviderActionLabel(localProvider('ready'))).toBe('登录')
  })

  it('preserves Local onboarding badge mapping', () => {
    expect(getProviderStatusBadge(localProvider('space_required'))).toEqual({ label: '未配置', tone: 'neutral' })
    expect(getProviderStatusBadge(localProvider('repair_required'))).toEqual({ label: '需设置', tone: 'warning' })
    expect(getProviderStatusBadge(localProvider('ready'))).toEqual({ label: '可用', tone: 'success' })
  })
})
