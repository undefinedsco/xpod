// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PodSettingsStatus } from '../../api/pod-settings';
import { UsagePage } from './UsagePage';

const runtime = vi.hoisted(() => ({
  webId: 'https://id.example/alice/profile/card#me',
  podUrl: 'https://pod.example/alice/',
  fetch: vi.fn(),
}));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => runtime }));

const client = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../api/pod-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/pod-settings')>(),
  fetchPodSettingsStatus: client.fetch,
}));

function status(storage: PodSettingsStatus['storage']): PodSettingsStatus {
  return {
    identity: { webId: runtime.webId, podUrl: runtime.podUrl },
    storage,
    aiConnection: { status: 'unsupported' },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('usage page', () => {
  it('shows measured values and limits, including a real zero', async () => {
    client.fetch.mockResolvedValue(status({
      status: 'available',
      usage: { storageBytes: 0, ingressBytes: 2048, egressBytes: 4096, computeSeconds: 90, tokensUsed: 12 },
      limits: { storageLimitBytes: null, bandwidthLimitBps: 1024, computeLimitSeconds: null, tokenLimitMonthly: 100 },
      source: 'identity_usage',
    }));

    render(<UsagePage kind="overview" />);

    await waitFor(() => expect(screen.getByTestId('usage-storage')).toBeTruthy());
    // 真的 0 显示 0，不是"未知"
    expect(screen.getByText('0 B')).toBeTruthy();
    expect(screen.getByText('2.0 KiB')).toBeTruthy();
    // 上限为 null 表示不限
    expect(screen.getAllByText('不限').length).toBeGreaterThan(0);
    expect(screen.getByText('来源：identity_usage')).toBeTruthy();
  });

  it('says the deployment does not report usage instead of showing zeros', async () => {
    client.fetch.mockResolvedValue(status({ status: 'unsupported', reason: 'usage_not_available' }));

    render(<UsagePage kind="storage" />);

    await waitFor(() => expect(screen.getByTestId('usage-state')).toBeTruthy());
    expect(screen.getByTestId('usage-state').getAttribute('data-usage-state')).toBe('unsupported');
    expect(screen.getByText('此部署不提供用量数据')).toBeTruthy();
    expect(screen.queryByTestId('usage-storage')).toBeNull();
  });

  it('keeps a failed read unknown and offers a retry', async () => {
    client.fetch.mockRejectedValue(new Error('network down'));

    render(<UsagePage kind="bandwidth" />);

    await waitFor(() => expect(screen.getByTestId('usage-state')).toBeTruthy());
    expect(screen.getByText('状态无法确认')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
    expect(screen.queryByTestId('usage-fact')).toBeNull();
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  });

  it('marks index storage as having no separate source', async () => {
    client.fetch.mockResolvedValue(status({
      status: 'available',
      usage: { storageBytes: 1024, ingressBytes: 0, egressBytes: 0, computeSeconds: 0, tokensUsed: 0 },
      limits: { storageLimitBytes: 1024, bandwidthLimitBps: null, computeLimitSeconds: null, tokenLimitMonthly: null },
    }));

    render(<UsagePage kind="index-storage" />);

    await waitFor(() => expect(screen.getByText(/索引占用尚无独立数据来源/u)).toBeTruthy());
    expect(screen.getByTestId('usage-storage')).toBeTruthy();
    expect(screen.queryByTestId('usage-ai')).toBeNull();
  });
});
