import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { DeviceServicesPage, DeviceLogsPage, DeviceNetworkPage, DeviceRuntimePage } from './DevicePages';
import { fetchServicesStatusSnapshot, getAdminConfig, getLogs, updateAdminConfig } from '../../api/admin';
import { fetchTunnelClients, fetchNetworkSettingsStatus } from '../../api/network-settings';
vi.mock('../../api/admin', () => ({ fetchServicesStatusSnapshot: vi.fn(), getLogs: vi.fn(), triggerRestart: vi.fn(), getAdminConfig: vi.fn(), updateAdminConfig: vi.fn() }));
vi.mock('../../api/network-settings', () => ({ fetchTunnelClients: vi.fn(), fetchNetworkSettingsStatus: vi.fn(), installTunnelClient: vi.fn(), updateNetworkConfiguration: vi.fn(), renewNetworkCertificate: vi.fn(), runNetworkDiagnostics: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(fetchServicesStatusSnapshot).mockResolvedValue({ adminData: { status: 'running' } as never, servicesData: [{ name: 'api', status: 'running', restartCount: 0 }, { name: 'qlever', status: 'stopped', restartCount: 0 }, { name: 'inngest', status: 'running', restartCount: 0 }], configData: null, ddnsData: null, publicCheck: null, checkedAt: new Date() });
  vi.mocked(fetchTunnelClients).mockResolvedValue({ clients: [{ provider: 'cloudflare', binary: 'cloudflared', state: 'missing', installHint: 'brew install cloudflared' } as never] });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.xpodDesktop = undefined; });
const render = async (element: React.ReactNode) => { await act(async () => { root.render(<BrowserRouter>{element}</BrowserRouter>); await new Promise((resolve) => setTimeout(resolve, 20)); }); };
describe('device pages', () => {
  test('shows query and scheduler evidence without inventing missing service health', async () => {
    await render(<DeviceServicesPage />);
    expect(container.textContent).toContain('查询引擎（QLever）已停止');
    expect(container.textContent).toContain('任务调度（Inngest）运行中');
    expect(container.textContent).toContain('Solid 服务未报告');
    expect(container.textContent).toContain('cloudflared未安装');
    expect(container.textContent).toContain('停止只影响这台设备');
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '停止 Xpod')?.disabled).toBe(true);
  });
  test('persists the automatic-restart choice through the desktop host', async () => {
    const setAutoRestart = vi.fn().mockResolvedValue(undefined);
    globalThis.xpodDesktop = {
      setIdentity: vi.fn(), deviceRuntime: {
        getRuntimeSettings: vi.fn().mockResolvedValue({ state: 'running', ownership: 'desktop', launchAtLogin: false, autoRestart: true }),
        setAutoRestart, setLaunchAtLogin: vi.fn(), runtimeAction: vi.fn(), showDataDirectory: vi.fn(), selectDataDirectory: vi.fn(),
      },
    };
    await render(<DeviceRuntimePage />);
    const toggle = container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1];
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector(`label[for="${toggle.id}"]`)?.textContent).toContain('意外退出时自动重启');
    await act(async () => toggle.click());
    expect(setAutoRestart).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
  test('opens and changes the data directory through the desktop host bridge', async () => {
    const showDataDirectory = vi.fn().mockResolvedValue(undefined);
    const selectDataDirectory = vi.fn().mockResolvedValue('/data/new');
    vi.mocked(getAdminConfig).mockResolvedValue(null as never);
    vi.mocked(updateAdminConfig).mockResolvedValue(true);
    globalThis.xpodDesktop = {
      setIdentity: vi.fn(), platform: 'darwin', deviceRuntime: {
        getRuntimeSettings: vi.fn().mockResolvedValue({ state: 'running', ownership: 'desktop', launchAtLogin: false, autoRestart: false, dataDirectory: '/data/xpod' }),
        setAutoRestart: vi.fn(), setLaunchAtLogin: vi.fn(), runtimeAction: vi.fn(), showDataDirectory, selectDataDirectory,
      },
    };
    await render(<DeviceRuntimePage />);
    expect(container.textContent).toContain('/data/xpod');
    const button = (label: string) => Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label) as HTMLButtonElement;
    await act(async () => button('在访达中显示').click());
    expect(showDataDirectory).toHaveBeenCalledTimes(1);
    await act(async () => button('更改').click());
    expect(selectDataDirectory).toHaveBeenCalledTimes(1);
    expect(updateAdminConfig).toHaveBeenCalledWith({ CSS_ROOT_FILE_PATH: '/data/new' });
    expect(container.textContent).toContain('已保存，重启后使用新位置；原有数据不会自动迁移。');
    expect(container.textContent).toContain('/data/new');
  });
  test('exposes all four log filters and keeps log content as text', async () => {
    vi.mocked(getLogs).mockResolvedValue([{ timestamp: new Date().toISOString(), source: 'api', level: 'error', message: '<script>bad()</script>' }]);
    await render(<DeviceLogsPage />);
    expect(container.querySelectorAll('select')).toHaveLength(3);
    expect(container.querySelector('input[type="search"]')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>bad()</script>');
    const [source, level] = container.querySelectorAll('select');
    await act(async () => { source.value = 'css'; source.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(getLogs).toHaveBeenLastCalledWith({ source: 'css', level: 'all', limit: 500 });
    await act(async () => { level.value = 'warn'; level.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(getLogs).toHaveBeenLastCalledWith({ source: 'css', level: 'warn', limit: 500 });
  });
  test('network body does not nest shell navigation or assert unprobed public reachability', async () => {
    vi.mocked(fetchNetworkSettingsStatus).mockResolvedValue({ endpoint: 'https://pod.example', addresses: { local: ['http://localhost:4567'], lan: [], public: ['https://pod.example'] }, actions: { diagnose: true, renewCertificate: false }, tls: { supported: false, status: 'unsupported' }, dns: { supported: false, status: 'unsupported' }, tunnel: { supported: false, status: 'unsupported' } });
    await render(<DeviceNetworkPage />);
    expect(container.querySelector('[data-workspace-layout]')).toBeNull();
    expect(container.textContent).toContain('这台电脑'); expect(container.textContent).toContain('其他网络');
    expect(container.textContent).toContain('http://localhost:4567');
    expect(container.textContent).not.toContain('本机检测通过');
  });
});
