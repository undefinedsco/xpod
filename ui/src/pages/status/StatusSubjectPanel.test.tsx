// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ServiceStatusPanel } from './StatusSubjectPanel';

/**
 * The service panels are the surfaces the desktop tray opens for an anonymous
 * visitor, so their evidence must come from the local runtime endpoints alone:
 * no Account cookie, no Authorization header, no WebID session.
 */
const services = [
  { name: 'gateway', status: 'running', pid: 4242, uptime: 90_000, restartCount: 0 },
  { name: 'css', status: 'running', pid: 4243, uptime: 88_000, restartCount: 1 },
  { name: 'api', status: 'running', pid: 4244, uptime: 87_000, restartCount: 0 },
];

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function installAnonymousLocalRuntime(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/service/status') return json(services);
    if (url === '/api/admin/status') {
      return json({ status: 'running', pid: 4242, ppid: 1, uptime: 90, env: { CSS_PORT: '3000' }, configs: [] });
    }
    if (url === '/api/admin/config') {
      return json({ env: { CSS_PORT: '3000', API_PORT: '3001' }, configFiles: [] });
    }
    if (url === '/api/admin/ddns') {
      return json({
        enabled: false, allocated: false, fqdn: null, baseUrl: 'http://localhost:3000/',
        mode: 'direct', tunnelProvider: 'none', ipv4: null, ipv6: null, detail: 'direct',
      });
    }
    if (url.startsWith('/api/admin/public-ip')) {
      return json({ status: 'pass', publicIp: '203.0.113.10', baseUrl: 'http://localhost:3000/', detail: 'reachable' });
    }
    if (url.startsWith('/api/admin/logs')) {
      return json([{
        timestamp: '2026-09-28T10:00:00.000Z', level: 'error', source: 'gateway',
        message: 'supervisor observed a failed child start',
      }]);
    }
    throw new Error(`The anonymous service panel requested ${url}`);
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ServiceStatusPanel without any session', () => {
  test('renders the local runtime evidence for the anonymous Gateway surface', async () => {
    installAnonymousLocalRuntime();
    render(<ServiceStatusPanel serviceId="gateway" title="Gateway" />);

    expect(await screen.findByText('4242')).toBeTruthy();
    expect(screen.getByText('1m 30s')).toBeTruthy();
    expect(screen.getByText('GET /service/status')).toBeTruthy();
    expect(await screen.findByText('supervisor observed a failed child start')).toBeTruthy();
    expect(screen.queryByText('邮箱')).toBeNull();
  });

  test('reads only loopback runtime endpoints, without sending session credentials', async () => {
    const calls = installAnonymousLocalRuntime();
    render(<ServiceStatusPanel serviceId="css" title="Solid Server" />);

    expect(await screen.findByText('4243')).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/admin/logs'))).toBe(true));

    const allowed = ['/service/status', '/api/admin/status', '/api/admin/config', '/api/admin/ddns',
      '/api/admin/logs', '/api/admin/public-ip'];
    for (const call of calls) {
      expect(allowed.some((prefix) => call.url.startsWith(prefix)), call.url).toBe(true);
      expect(call.init?.credentials, call.url).toBeUndefined();
      expect(new Headers(call.init?.headers).has('authorization'), call.url).toBe(false);
    }
  });
});
