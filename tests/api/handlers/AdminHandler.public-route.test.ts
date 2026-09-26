import { describe, expect, it } from 'vitest';
import { describeUnservedPublicRoute } from '../../../src/api/handlers/AdminHandler';

function ddns(state: { mode: 'unknown' | 'direct' | 'tunnel'; tunnelProvider: string }) {
  return { getStatus: () => ({ allocated: false, ...state }) };
}

describe('public route verdict', () => {
  it('reports a coordinated domain nothing publishes as unserved', () => {
    // The runtime asked the cluster for a tunnel route and runs none, so the
    // issued domain cannot be served even though it resolves in DNS.
    expect(describeUnservedPublicRoute(ddns({ mode: 'tunnel', tunnelProvider: 'none' })))
      .toBe('域名由隧道模式协调，但当前没有配置任何隧道提供商，公网入口无法提供服务。');
  });

  it('leaves a running tunnel to the external check it cannot replace', () => {
    expect(describeUnservedPublicRoute(ddns({ mode: 'tunnel', tunnelProvider: 'ngrok' }))).toBeNull();
    expect(describeUnservedPublicRoute(ddns({ mode: 'direct', tunnelProvider: 'none' }))).toBeNull();
  });

  it('claims nothing when the node coordinates no domain at all', () => {
    expect(describeUnservedPublicRoute(undefined)).toBeNull();
    expect(describeUnservedPublicRoute({ getStatus: () => { throw new Error('unavailable'); } })).toBeNull();
  });
});
