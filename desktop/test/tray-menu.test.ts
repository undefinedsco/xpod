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

    expect(model.tooltip).toBe('Xpod · 3/3 services running');
    expect(labels).toEqual(expect.arrayContaining([
      '● Xpod healthy',
      '● Gateway — Running',
      '● Solid Server — Running',
      '● API Server — Running',
      'Open Xpod',
      'Open Pod',
      'Status',
      'Network',
      'AI Config',
      'Settings',
      'Check Status Again',
      'Restart Xpod…',
      'Signed in as Alice',
      'Account…',
      'Launch at Login',
      'About Xpod',
      'Quit Xpod',
    ]));
    expect(model.items.find((item) => item.label === 'Launch at Login')?.checked).toBe(true);
    expect(model.items.find((item) => item.label === 'Signed in as Alice')?.enabled).toBe(false);
    expect(model.items.find((item) => item.label === '● Gateway — Running')?.action).toEqual({
      type: 'open-route',
      route: '/status/services/gateway',
    });
    expect(model.items.find((item) => item.label === 'Status')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview',
    });
    expect(model.items.find((item) => item.label === 'Account…')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview?account=open',
    });
    expect(model.items.some((item) => item.action?.type === 'open-route' && item.action.route.startsWith('/.account'))).toBe(false);
  });

  test('offers Start Xpod when all services are stopped', () => {
    const model = buildTrayMenuModel({ services: [], launchAtLogin: false });
    expect(model.items.find((item) => item.label === 'Start Xpod')?.action).toEqual({ type: 'start' });
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
  });

  test('keeps the in-shell Account entry available while anonymous', () => {
    const model = buildTrayMenuModel({ services: healthy, launchAtLogin: false });

    expect(model.items.find((item) => item.label === 'Account…')?.action).toEqual({
      type: 'open-route',
      route: '/status/overview?account=open',
    });
    expect(model.items.some((item) => item.label?.startsWith('Signed in as '))).toBe(false);
    expect(model.items.some((item) => item.label === 'Open Pod')).toBe(false);
  });

  test('adds a contextual log action for a crashed service', () => {
    const model = buildTrayMenuModel({
      services: [healthy[0], healthy[1], { name: 'api', status: 'crashed' }],
      launchAtLogin: false,
    });

    expect(model.items.map((item) => item.label)).toContain('Open API Server Logs');
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
