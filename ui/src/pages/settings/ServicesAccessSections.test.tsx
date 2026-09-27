// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PodSettingsSubjectPanel } from './SystemSettingsSubjectPanel';

const runtime = vi.hoisted(() => ({
  webId: 'https://id.example/alice/profile/card#me',
  podUrl: 'https://pod.example/alice/',
  state: { status: 'authenticated' },
  fetch: vi.fn(),
}));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => runtime }));

const admin = vi.hoisted(() => ({
  getAdminStatus: vi.fn(async () => ({
    status: 'running', pid: 1, ppid: 0, uptime: 65_000,
    env: { CSS_BASE_URL: 'https://pod.example/', XPOD_EDITION: 'local' },
    configs: [],
  })),
  getAdminConfig: vi.fn(async () => ({ env: { CSS_BASE_URL: 'https://pod.example/' }, secrets: {} })),
  getProvisionStatus: vi.fn(async () => ({})),
  getDdnsStatus: vi.fn(async () => ({})),
  getPublicIpCheck: vi.fn(async () => null),
  resolveAdminAccessBaseUrl: vi.fn(() => 'https://pod.example/'),
}));
vi.mock('../../api/admin', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/admin')>(),
  ...admin,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('services & access sections', () => {
  it('names the four §7.5 themes with their state and destinations', async () => {
    render(<PodSettingsSubjectPanel kind="runtime" />);

    await waitFor(() => expect(screen.getByTestId('services-access-sections')).toBeTruthy());
    const sections = screen.getAllByTestId('services-access-section');
    expect(sections.map((section) => section.getAttribute('data-section')))
      .toEqual(['services', 'access', 'public-access', 'diagnostics']);

    expect(screen.getByText('服务与启动')).toBeTruthy();
    expect(screen.getByText('访问与连接')).toBeTruthy();
    expect(screen.getByText('对外访问设置')).toBeTruthy();
    expect(screen.getByText('诊断')).toBeTruthy();
    // 读不到对外访问时不得写成"可达"
    expect(screen.getByText('对外访问状态无法确认')).toBeTruthy();
  });
});
