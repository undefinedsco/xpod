import { describe, expect, it } from 'vitest';
import { SakuraFrpTunnelProvider } from '../../src/tunnel/SakuraFrpTunnelProvider';

describe('SakuraFrpTunnelProvider', () => {
  it('uses the active profile public endpoint in setup status', async () => {
    const provider = new SakuraFrpTunnelProvider({
      token: 'sakura-token',
      publicUrl: 'https://sakura.example.com',
    });

    const config = await provider.setup({
      subdomain: 'local',
      localPort: 5737,
    });

    expect(config.endpoint).toBe('https://sakura.example.com/');
    expect(provider.getEndpoint()).toBe('https://sakura.example.com/');
  });
});
