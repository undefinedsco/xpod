import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
  testModel: vi.fn(async () => {}),
  gatewayCatalog: { status: 'available' as 'loading' | 'available' | 'unauthorized' | 'error', models: [] as Array<{ id: string; displayName?: string; provider?: string }> },
  config: { models: {} as Record<string, string>, searchIndexing: {}, lifecycle: {} },
  models: [{ id: 'my-chat', owner: 'openai', ref: '/settings/providers/openai.ttl#my-chat', capabilities: ['chat'] }],
}));
vi.mock('../settings/ai-config/AiConfigContext', () => ({
  AiConfigProvider: ({ children }: { children: React.ReactNode }) => children,
  useAiConfig: () => ({ ...mocks, saving: false, rebuilding: false, capabilities: {}, rebuild: vi.fn(), saveAndRebuild: vi.fn() }),
}));
vi.mock('../settings/ai-config/useBackgroundPodAccess', () => ({ useBackgroundPodAccess: () => ({ loading: false, working: false, grant: vi.fn(), revoke: vi.fn() }) }));
vi.mock('../../solid/useXpodSolidRuntime', () => ({ useXpodSolidRuntime: () => ({ fetch: fetch }) }));
vi.mock('../../api/ai-config', () => ({ testAiConfigModel: mocks.testModel }));

import PodPage from './PodPage';

function row(label: string) { return within(screen.getByText(label, { selector: 'label' }).parentElement!); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.models = {};
  mocks.gatewayCatalog.status = 'available';
  mocks.gatewayCatalog.models = [{ id: 'linx', displayName: 'Gateway 智能', provider: 'cloud' }, { id: 'linx-lite', displayName: 'Gateway 快速', provider: 'cloud' }];
});
afterEach(cleanup);

describe('Pod model settings Gateway defaults', () => {
  it('shows implemented defaults and tests the actual published aliases without saving a Pod override', async () => {
    render(<PodPage section="models" onSection={vi.fn()} />);
    expect(row('智能').queryByText('待接入')).toBeNull();
    expect(row('快速').queryByText('待接入')).toBeNull();
    expect(row('快速').queryByRole('combobox')).toBeNull();
    fireEvent.click(row('智能').getByRole('button', { name: '测试' }));
    await waitFor(() => expect(mocks.testModel).toHaveBeenCalledWith(fetch, { id: 'linx', capabilities: ['chat'] }));
    await screen.findByText('测试通过');
    fireEvent.click(row('快速').getByRole('button', { name: '测试' }));
    await waitFor(() => expect(mocks.testModel).toHaveBeenCalledWith(fetch, { id: 'linx-lite', capabilities: ['chat'] }));
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps a custom smart choice and restore-default action on the existing chatModel policy', async () => {
    mocks.config.models.chatModel = mocks.models[0].ref;
    render(<PodPage section="models" onSection={vi.fn()} />);
    fireEvent.click(row('智能').getByRole('button', { name: '测试' }));
    await waitFor(() => expect(mocks.testModel).toHaveBeenCalledWith(fetch, expect.objectContaining({ id: 'my-chat' })));
    await screen.findByText('测试通过');
    fireEvent.change(row('智能').getByRole('combobox'), { target: { value: '' } });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ models: { chatModel: null } }));
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it.each([
    ['loading', '正在读取模型…'],
    ['unauthorized', '请登录并允许 Xpod 访问'],
    ['error', '模型读取失败，请重试'],
  ] as const)('shows %s independently from implemented support', (status, label) => {
    mocks.gatewayCatalog.status = status;
    mocks.gatewayCatalog.models = [];
    render(<PodPage section="models" onSection={vi.fn()} />);
    for (const name of ['智能', '快速']) {
      expect(row(name).getByText(label)).toBeTruthy();
      expect(row(name).queryByText('待接入')).toBeNull();
      expect(row(name).queryByRole('button', { name: '测试' })).toBeNull();
    }
  });
  it('reports a successful empty catalog as connected and does not offer an unadvertised test', () => {
    mocks.gatewayCatalog.models = [];
    render(<PodPage section="models" onSection={vi.fn()} />);
    expect(row('快速').getByText('已连接 Xpod，暂无模型')).toBeTruthy();
    expect(row('快速').queryByRole('button', { name: '测试' })).toBeNull();
  });
  it('keeps Gateway-managed roles supported when other models are advertised', () => {
    mocks.gatewayCatalog.models = [{ id: 'other', provider: 'cloud' }];
    render(<PodPage section="models" onSection={vi.fn()} />);
    expect(row('快速').getByText('Xpod 管理')).toBeTruthy();
    expect(row('快速').queryByRole('button', { name: '测试' })).toBeNull();
    expect(row('智能').queryByText('待接入')).toBeNull();
  });
  it('does not mistake an unrelated namespace for a testable platform role', () => {
    mocks.gatewayCatalog.models = [{ id: 'other/linx', provider: 'other' }, { id: 'org/linx-lite', provider: 'org' }];
    render(<PodPage section="models" onSection={vi.fn()} />);
    for (const name of ['智能', '快速']) {
      expect(row(name).getByText('Xpod 管理')).toBeTruthy();
      expect(row(name).queryByRole('button', { name: '测试' })).toBeNull();
    }
    expect(mocks.testModel).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('tests supported prefixed platform aliases using their actual published wire ids', async () => {
    mocks.gatewayCatalog.models = [{ id: 'undefineds/LINX', provider: 'cloud' }, { id: 'undefineds/linx-lite', provider: 'cloud' }];
    render(<PodPage section="models" onSection={vi.fn()} />);
    fireEvent.click(row('智能').getByRole('button', { name: '测试' }));
    await waitFor(() => expect(mocks.testModel).toHaveBeenCalledWith(fetch, { id: 'undefineds/LINX', capabilities: ['chat'] }));
    await screen.findByText('测试通过');
    fireEvent.click(row('快速').getByRole('button', { name: '测试' }));
    await waitFor(() => expect(mocks.testModel).toHaveBeenCalledWith(fetch, { id: 'undefineds/linx-lite', capabilities: ['chat'] }));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
