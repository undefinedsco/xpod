import { describe, expect, it } from 'vitest';
import {
  composeSakuraEntry,
  selectSakuraTunnel,
  type SakuraNode,
  type SakuraTunnel,
} from '../../scripts/probe-sakura-clients';

const nodes: Record<string, SakuraNode> = {
  62: { name: '东莞双线PLUS2', host: 'frp-ski.com' },
  99: { name: 'no host node', host: '' },
};

describe('SakuraFrp client probe', () => {
  it('refuses to probe an account without tunnels instead of blaming the client', () => {
    expect(() => selectSakuraTunnel([])).toThrow(/no tunnel/u);
  });

  it('selects the requested tunnel and reports an unknown id', () => {
    const tunnels: SakuraTunnel[] = [ { id: 1 }, { id: 2 } ];
    expect(selectSakuraTunnel(tunnels, 2).id).toBe(2);
    expect(() => selectSakuraTunnel(tunnels, 7)).toThrow(/no tunnel with id 7/u);
    expect(selectSakuraTunnel(tunnels).id).toBe(1);
  });

  it('composes a TCP entry from the node host and the assigned remote port', () => {
    expect(composeSakuraEntry({ id: 1, node: 62, type: 'tcp', remote: '23333' }, nodes))
      .toEqual({ url: 'http://frp-ski.com:23333/' });
    expect(composeSakuraEntry({ id: 1, node: 62, type: 'tcp', remote: '23333', extra: 'auto_https = auto' }, nodes))
      .toEqual({ url: 'https://frp-ski.com:23333/' });
  });

  it('uses the bound domain when the platform assigned one', () => {
    expect(composeSakuraEntry({ id: 1, node: 62, type: 'https', remote: 'xpod.example.com' }, nodes))
      .toEqual({ url: 'https://xpod.example.com/' });
  });

  it('says why no entry can be derived instead of inventing one', () => {
    expect(composeSakuraEntry({ id: 1, node: 99, type: 'tcp', remote: '23333' }, nodes).url).toBeUndefined();
    expect(composeSakuraEntry({ id: 1, node: 99, type: 'tcp', remote: '23333' }, nodes).reason)
      .toMatch(/publishes no host/u);
    expect(composeSakuraEntry({ id: 1, node: 62, type: 'tcp' }, nodes).reason)
      .toMatch(/no assigned remote address/u);
  });
});
