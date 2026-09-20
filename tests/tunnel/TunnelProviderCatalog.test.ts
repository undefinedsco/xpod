import { describe, expect, it } from 'vitest';
import {
  TUNNEL_PROVIDERS,
  tunnelProfileCredentialEnvKey,
  tunnelProviderDescriptor,
} from '../../src/tunnel/TunnelProviderCatalog';

describe('tunnel provider catalogue', () => {
  /**
   * Where a public entry comes from is a fact about the provider, and getting it wrong is
   * what makes an operator type an address their provider never asked for.
   */
  it('records who assigns each public entry', () => {
    expect(Object.fromEntries(TUNNEL_PROVIDERS.map((provider) => [ provider.id, provider.endpointSource ]))).toEqual({
      // ngrok's local agent reports the entry; SakuraFrp assigns a node host and remote
      // port (or a bound domain) that are read back through its API.
      ngrok: 'discovered',
      sakura_frp: 'discovered',
      // The Cloudflare dashboard owns the hostname, so it is a console fact.
      cloudflare: 'declared',
      frp: 'declared',
    });
  });

  it('refuses to activate a provider the local runtime cannot start', () => {
    expect(tunnelProviderDescriptor('frp')?.runtimeSupported).toBe(false);
    expect(tunnelProviderDescriptor('sakura_frp')?.runtimeSupported).toBe(true);
  });

  /**
   * A declared parameter is a promise that the runtime will use it. Nothing consumes a
   * parameter today, so a locally runnable provider that declares one would make the
   * settings form collect values with no effect — the drift this audit was about.
   */
  it('declares no parameter that no implementation consumes', () => {
    const declaring = TUNNEL_PROVIDERS.filter((provider) => provider.parameterFields.length > 0);
    expect(declaring.map((provider) => provider.id)).toEqual([ 'frp' ]);
    expect(declaring.every((provider) => !provider.runtimeSupported)).toBe(true);
  });

  it('gives every provider its own credential namespace', () => {
    const keys = TUNNEL_PROVIDERS.map((provider) => tunnelProfileCredentialEnvKey(provider.id));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
