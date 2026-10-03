import { describe, expect, test } from 'vitest';
import { aggregateTrayStatus, buildTrayMenuModel, normalizeTrayAttention, normalizeTrayIdentity, type TrayServiceSnapshot } from '../src/tray-menu.js';
const healthy: TrayServiceSnapshot[] = ['gateway', 'css', 'api'].map((name) => ({ name, status: 'running' }));

describe('tray status', () => {
  test('requires the three runtime services and preserves failure precedence', () => {
    expect(aggregateTrayStatus(healthy)).toEqual({ state: 'healthy', running: 3, total: 3 });
    expect(aggregateTrayStatus(healthy.slice(1)).state).toBe('degraded');
    expect(aggregateTrayStatus([{ name: 'api', status: 'crashed' }]).state).toBe('failed');
    expect(aggregateTrayStatus([{ name: 'api', status: 'starting' }]).state).toBe('starting');
    expect(aggregateTrayStatus([]).state).toBe('stopped');
  });
  test('identity comes first and copies WebID; lifecycle and updates remain available', () => {
    const model = buildTrayMenuModel({ services: healthy, identity: { label: '小林', webId: 'http://localhost/profile#me' }, update: { status: 'idle' } });
    expect(model.items[0].action).toEqual({ type: 'copy-webid' });
    expect(model.items[1].label).toBe('运行中');
    expect(model.items.map((item) => item.action?.type)).toEqual(expect.arrayContaining(['stop', 'check-update', 'about', 'quit']));
    expect(model.items.some((item) => item.action?.type === 'toggle-launch-at-login')).toBe(false);
    expect(buildTrayMenuModel({ services: [] }).items.some((item) => item.action?.type === 'start')).toBe(true);
    expect(buildTrayMenuModel({ services: healthy, localOnly: true }).items[1].label).toBe('仅本机可用');
  });
  test('projects only three attention pointers and long-running work from shared snapshot', () => {
    const attention = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `待处理 ${i}`, href: `/tasks/${i}` }));
    const model = buildTrayMenuModel({ services: healthy, attention, inProgress: [{ id: 'index', title: '索引重建', href: '/pod/indexing' }] });
    expect(model.items.filter((item) => item.label?.startsWith('待处理'))).toHaveLength(3);
    expect(model.items.find((item) => item.label === '待处理 0')?.action).toEqual({ type: 'open-route', route: '/tasks/0' });
    expect(model.items.map((item) => item.label)).toEqual(expect.arrayContaining(['需要你处理', '全部查看 ›', '进行中', '索引重建']));
    expect(buildTrayMenuModel({ services: healthy }).items.some((item) => item.label === '进行中')).toBe(false);
  });
  test('approval submenu carries the original object and real decision action', () => {
    const snapshot = normalizeTrayAttention({ attention: [{ id: 'a', kind: 'approval', approvalId: 'https://pod.example/approval#1', title: '访问申请', href: '/tasks?approval=1' }] });
    const submenu = buildTrayMenuModel({ services: healthy, ...snapshot }).items.find((item) => item.label === '访问申请')?.submenu;
    expect(submenu?.find((item) => item.label === '允许')?.action).toEqual({ type: 'decide-approval', approvalId: 'https://pod.example/approval#1', decision: 'approved', route: '/tasks?approval=1' });
    expect(submenu?.find((item) => item.label === '拒绝')?.action).toEqual({ type: 'decide-approval', approvalId: 'https://pod.example/approval#1', decision: 'rejected', route: '/tasks?approval=1' });
    expect(snapshot.attention).toHaveLength(1);
  });
  test('retains released download progress and staged-package recovery in the new tray', () => {
    const downloading = buildTrayMenuModel({ services: healthy, update: { status: 'downloading', version: '0.4.20', progress: { transferred: 512, total: 1024, percent: 50, bytesPerSecond: 256 } } });
    expect(downloading.items.some((item) => item.label?.includes('50%') && item.label.includes('/s'))).toBe(true);
    for (const status of ['downloaded', 'error'] as const) {
      const items = buildTrayMenuModel({ services: healthy, update: { status, downloadPath: '/updates/staged/Xpod.app' } }).items;
      expect(items.find((item) => item.label === '显示更新包…')?.action).toEqual({ type: 'reveal-update' });
    }
  });
  test('update failures stay concise, with recovery actions', () => {
    const items = buildTrayMenuModel({ services: healthy, update: { status: 'error', message: 'internal error' } }).items;
    expect(items.find((item) => item.label === '更新失败')?.enabled).toBe(false);
    expect(items.some((item) => item.action?.type === 'open-release-download')).toBe(true);
    expect(buildTrayMenuModel({ services: healthy, update: { status: 'downloaded', version: '1.0' } }).items.some((item) => item.action?.type === 'install-update')).toBe(true);
  });
});
describe('native menu input boundaries', () => {
  test('sanitizes labels and accepts cross-origin Solid identity without URL credentials', () => {
    expect(normalizeTrayIdentity({ label: '  Alice\u0000 Admin ', webId: 'http://localhost:3000/profile#me' }, 'http://localhost:3000')).toEqual({ label: 'Alice Admin', webId: 'http://localhost:3000/profile#me' });
    expect(normalizeTrayIdentity({ label: 'Alice', webId: 'https://other.example/profile#me' }, 'http://localhost:3000')?.webId).toBe('https://other.example/profile#me');
    expect(normalizeTrayIdentity({ label: 'Mallory', podUrl: 'https://user:secret@other.example/pod/' })).toBeUndefined();
    expect(normalizeTrayIdentity({ label: 'Mallory', webId: 'https://other.example/\nprofile' })).toBeUndefined();
  });
  test('rejects external and malformed attention destinations', () => {
    expect(normalizeTrayAttention({ attention: [
      { id: '1', title: 'Hi\nthere', href: '/tasks/1' },
      { id: '2', title: 'bad', href: '//evil.example' },
      { id: '3', title: 'bad', href: '/\\evil.example' },
      { id: '4', title: 'bad', href: 'javascript:alert(1)' },
    ] })).toEqual({ attention: [{ id: '1', title: 'Hi there', href: '/tasks/1' }], inProgress: [] });
  });
});
