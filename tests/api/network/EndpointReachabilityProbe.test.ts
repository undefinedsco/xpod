import { describe, expect, it, vi } from 'vitest';
import { probeEndpointReachability } from '../../../src/api/network/EndpointReachabilityProbe';
import type { HeadProbeRequest } from '../../../src/edge/ProbeTargetGuard';

/**
 * N12：诊断里的"可达"以前只是"地址配了"。现在操作者点按钮时会真的去请求入口，但探测本身
 * 必须窄：只允许 https、只对公网地址发、每一跳重定向重新校验、连接钉在已校验的地址上，
 * 结论也只能说"从这个节点可达"。
 */
// A real public address: the guard deliberately blocks the documentation ranges
// (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), so a TEST-NET address would be refused.
const PUBLIC_IP = '93.184.216.34';
const resolveTo = (address: string) => async (): Promise<string[]> => [ address ];

describe('probeEndpointReachability (N12)', () => {
  it('reports reachability from this node with the measured status and time', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
      now: () => new Date('2026-09-23T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      verdict: 'reachable-from-this-node',
      httpStatus: 200,
      checkedAt: '2026-09-23T00:00:00.000Z',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // 结论必须限定"从这个节点"，并说明回环网络可能不成立。
    expect(result.detail).toContain('reachable from this node');
    expect(result.detail).toContain('不代表外部用户可达');
    // 连接钉在已校验的地址上，而不是再解析一次。
    expect(headRequest).toHaveBeenCalledTimes(1);
    expect(headRequest.mock.calls[0][1]).toMatchObject({ address: PUBLIC_IP });
  });

  it('treats an entry that answers 403 as serving, not as unreachable', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 403 }));

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
    });

    expect(result).toMatchObject({ verdict: 'reachable-from-this-node', httpStatus: 403 });
  });

  it('refuses to probe a plaintext entry and sends nothing', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('http://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
    });

    expect(result).toMatchObject({ verdict: 'blocked', reason: 'insecure-scheme:http:' });
    expect(headRequest).not.toHaveBeenCalled();
  });

  it('refuses a target that resolves into a private address', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('https://internal.example/', {
      headRequest,
      resolveAddresses: resolveTo('10.0.0.5'),
    });

    expect(result.verdict).toBe('blocked');
    expect(result.reason).toContain('non-public-address:10.0.0.5');
    expect(headRequest).not.toHaveBeenCalled();
  });

  it('refuses the cloud metadata address', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('https://metadata.example/', {
      headRequest,
      resolveAddresses: resolveTo('169.254.169.254'),
    });

    expect(result.verdict).toBe('blocked');
    expect(headRequest).not.toHaveBeenCalled();
  });

  it('refuses a hostname that mixes public and private answers', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('https://mixed.example/', {
      headRequest,
      resolveAddresses: async () => [ PUBLIC_IP, '192.168.1.10' ],
    });

    expect(result.verdict).toBe('blocked');
    expect(headRequest).not.toHaveBeenCalled();
  });

  it('re-validates every redirect hop and refuses one that lands in private space', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async (url: URL) => {
      if (url.hostname === 'node-1.pods.example') {
        return { status: 302, location: 'https://internal.example/' };
      }
      return { status: 200 };
    });
    const resolveAddresses = vi.fn(async (hostname: string) => hostname === 'node-1.pods.example'
      ? [ PUBLIC_IP ]
      : [ '127.0.0.1' ]);

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses,
    });

    expect(result.verdict).toBe('blocked');
    expect(result.reason).toContain('non-public-address:127.0.0.1');
    expect(headRequest).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect and reports the final status', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async (url: URL) => url.hostname === 'node-1.pods.example'
      ? { status: 301, location: 'https://entry.pods.example/' }
      : { status: 204 });

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
    });

    expect(result).toMatchObject({ verdict: 'reachable-from-this-node', httpStatus: 204 });
    expect(headRequest).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout as unreachable from this node', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => {
      throw new Error('socket timed out');
    });

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
      timeoutMs: 10,
    });

    expect(result).toMatchObject({ verdict: 'unreachable', reason: 'timeout' });
    expect(result.detail).toContain('unreachable from this node');
  });

  it('reports a refused connection as unreachable with the reason', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const result = await probeEndpointReachability('https://node-1.pods.example/', {
      headRequest,
      resolveAddresses: resolveTo(PUBLIC_IP),
    });

    expect(result.verdict).toBe('unreachable');
    expect(result.reason).toContain('connection-error');
  });

  it('reports an unusable address as blocked instead of guessing a URL', async () => {
    const headRequest: HeadProbeRequest = vi.fn(async () => ({ status: 200 }));

    const result = await probeEndpointReachability('   ', { headRequest });

    expect(result).toMatchObject({ verdict: 'blocked', reason: 'invalid-url' });
    expect(headRequest).not.toHaveBeenCalled();
  });
});
