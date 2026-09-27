import { describe, expect, test } from 'vitest';
import {
  aggregateTrayStatus,
  buildTrayMenuModel,
  normalizeTrayIdentity,
  type TrayServiceSnapshot,
} from '../src/tray-menu.js';

const healthy: TrayServiceSnapshot[] = [
  { name: 'gateway', status: 'running' },
  { name: 'css', status: 'running' },
  { name: 'api', status: 'running' },
];

describe('aggregateTrayStatus', () => {
  test('requires exactly the three Xpod runtime services for healthy state', () => {
    expect(aggregateTrayStatus(healthy)).toEqual({ state: 'healthy', running: 3, total: 3 });
    expect(aggregateTrayStatus(healthy.slice(1))).toEqual({ state: 'degraded', running: 2, total: 3 });
  });

  test('prioritizes failed, starting, degraded, and stopped states', () => {
    expect(aggregateTrayStatus([
      healthy[0], healthy[1], { name: 'api', status: 'crashed' },
    ]).state).toBe('failed');
    expect(aggregateTrayStatus([
      healthy[0], { name: 'css', status: 'starting' }, { name: 'api', status: 'stopped' },
    ]).state).toBe('starting');
    expect(aggregateTrayStatus([
      healthy[0], healthy[1], { name: 'api', status: 'stopped' },
    ]).state).toBe('degraded');
    expect(aggregateTrayStatus([
      { name: 'gateway', status: 'stopped' },
      { name: 'css', status: 'stopped' },
      { name: 'api', status: 'stopped' },
    ]).state).toBe('stopped');
  });
});

describe('buildTrayMenuModel', () => {
  test('shows aggregate status, all services, global workspaces, and lifecycle actions', () => {
    const model = buildTrayMenuModel({
      services: healthy,
      launchAtLogin: true,
      identity: { label: 'Alice', podUrl: 'http://127.0.0.1:3000/alice/' },
    });
    const labels = model.items.flatMap((item) => item.label ? [item.label] : []);

    expect(model.tooltip).toBe('Xpod · 3/3 个服务在运行');
    expect(labels).toEqual(expect.arrayContaining([
      '● Xpod 运行正常',
      '● Gateway — Running',
      '● Solid Server — Running',
      '● API Server — Running',
      '打开 Xpod',
      '打开存储空间',
      '概览',
      '访问与连接',
      'AI 用途与模型',
      '存储空间',
      '重新检查状态',
      '重启 Xpod…',
      '已登录：Alice',
      '账号…',
      '开机启动',
      '关于 Xpod',
      '关闭窗口后服务继续运行；退出 Xpod 才会停止服务',
      '退出 Xpod',
    ]));
    expect(model.items.find((item) => item.label === '开机启动')?.checked).toBe(true);
    expect(model.items.find((item) => item.label === '已登录：Alice')?.enabled).toBe(false);
    expect(model.items.find((item) => item.label === '● Gateway — Running')?.action).toEqual({
      type: 'open-route',
      route: '/status/services/gateway',
    });
    expect(model.items.find((item) => item.label === '概览')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview',
    });
    expect(model.items.find((item) => item.label === '账号…')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview?account=open',
    });
    expect(model.items.some((item) => item.action?.type === 'open-route' && item.action.route.startsWith('/.account'))).toBe(false);
  });

  test('offers 启动 Xpod when all services are stopped', () => {
    const model = buildTrayMenuModel({ services: [], launchAtLogin: false });
    expect(model.items.find((item) => item.label === '启动 Xpod')?.action).toEqual({ type: 'start' });
  });

  test('shows update sensing and install actions when an update feed is configured', () => {
    expect(buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'idle' },
    }).items.find((item) => item.label === 'Check for Updates…')?.action).toEqual({ type: 'check-update' });

    expect(buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'checking' },
    }).items.find((item) => item.label === 'Checking for Updates…')?.enabled).toBe(false);

    expect(buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'downloading', version: '0.1.1' },
    }).items.find((item) => item.label === 'Downloading Xpod 0.1.1…')?.enabled).toBe(false);

    expect(buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'downloaded', version: '0.1.1' },
    }).items.find((item) => item.label === 'Restart to Install Xpod 0.1.1')?.action).toEqual({ type: 'install-update' });

    expect(buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'not-available' },
    }).items.find((item) => item.label === 'Check for Updates Again')?.action).toEqual({ type: 'check-update' });

    const updateFailedItems = buildTrayMenuModel({
      services: healthy,
      launchAtLogin: false,
      update: { status: 'error', message: 'Xpod could not check for updates because this app build is not properly signed.' },
    }).items;

    expect(updateFailedItems.find((item) => item.label?.startsWith('Update Failed:'))?.enabled).toBe(false);
    expect(updateFailedItems.find((item) => item.label === 'Download Latest Xpod…')?.action).toEqual({
      type: 'open-release-download',
    });
    expect(updateFailedItems.find((item) => item.label === 'Check for Updates Again')?.action).toEqual({
      type: 'check-update',
    });
  });

  test('keeps the in-shell Account entry available while anonymous', () => {
    const model = buildTrayMenuModel({ services: healthy, launchAtLogin: false });

    expect(model.items.find((item) => item.label === '账号…')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview?account=open',
    });
    expect(model.items.some((item) => item.label?.startsWith('已登录：'))).toBe(false);
    expect(model.items.some((item) => item.label === '打开存储空间')).toBe(false);
  });

  test('adds a contextual log action for a crashed service', () => {
    const model = buildTrayMenuModel({
      services: [healthy[0], healthy[1], { name: 'api', status: 'crashed' }],
      launchAtLogin: false,
    });

    expect(model.items.map((item) => item.label)).toContain('查看 API Server 日志');
  });
});

describe('normalizeTrayIdentity', () => {
  test('accepts only sanitized identity URLs on the desktop Xpod origin', () => {
    expect(normalizeTrayIdentity({
      label: '  Alice\u0000 Admin  ',
      webId: 'http://127.0.0.1:3000/alice/profile/card#me',
      podUrl: 'http://127.0.0.1:3000/alice/',
    }, 'http://127.0.0.1:3000')).toEqual({
      label: 'Alice Admin',
      webId: 'http://127.0.0.1:3000/alice/profile/card#me',
      podUrl: 'http://127.0.0.1:3000/alice/',
    });

    expect(normalizeTrayIdentity({
      label: 'Mallory',
      podUrl: 'https://other-provider.example/pod/',
    }, 'http://127.0.0.1:3000')).toBeUndefined();
  });
});
