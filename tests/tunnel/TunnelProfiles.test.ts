import { describe, expect, it } from 'vitest';
import {
  resolveTunnelProfileState,
  selectActiveTunnelProfile,
  type TunnelProfile,
} from '../../src/tunnel/TunnelProfiles';

describe('TunnelProfiles', () => {
  it('records multiple tunnel profiles and selects exactly one active profile', () => {
    const profiles: TunnelProfile[] = [
      {
        id: 'ngrok-dev',
        provider: 'ngrok',
        label: 'ngrok dev',
        publicUrl: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
        credentialEnvKey: 'NGROK_AUTHTOKEN',
        credentialConfigured: true,
      },
      {
        id: 'cloudflare-home',
        provider: 'cloudflare',
        label: 'home cloudflare',
        publicUrl: 'https://home-tunnel.example.com/',
        credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
        credentialConfigured: true,
      },
    ];

    const state = selectActiveTunnelProfile(profiles, 'cloudflare-home');

    expect(state.profiles.map((profile) => profile.id)).toEqual(['ngrok-dev', 'cloudflare-home']);
    expect(state.activeProfile?.id).toBe('cloudflare-home');
    expect(state.activeProvider).toBe('cloudflare');
    expect(state.inactiveProfiles.map((profile) => profile.id)).toEqual(['ngrok-dev']);
  });

  it('does not activate a profile whose required credential is missing', () => {
    const state = selectActiveTunnelProfile([
      {
        id: 'cloudflare-home',
        provider: 'cloudflare',
        label: 'home cloudflare',
        publicUrl: 'https://home-tunnel.example.com/',
        credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
        credentialConfigured: false,
      },
    ], 'cloudflare-home');

    expect(state.activeProvider).toBe('none');
    expect(state.activeProfile).toBeUndefined();
    expect(state.inactiveProfiles).toHaveLength(1);
  });

  it('parses JSON profiles while keeping secret values out of the profile record', () => {
    const state = resolveTunnelProfileState({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        {
          id: 'ngrok-dev',
          provider: 'ngrok',
          label: 'ngrok dev',
          publicUrl: 'https://ravioli-basics-throbbing.ngrok-free.dev',
          credentialEnvKey: 'NGROK_AUTHTOKEN',
        },
        {
          id: 'cloudflare-home',
          provider: 'cloudflare',
          label: 'home cloudflare',
          publicUrl: 'https://home-tunnel.example.com',
          credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
        },
      ]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'ngrok-dev',
      NGROK_AUTHTOKEN: 'secret-ngrok-token',
      CLOUDFLARE_TUNNEL_TOKEN: 'secret-cf-token',
    });

    expect(state.profiles).toHaveLength(2);
    expect(state.activeProfile).toMatchObject({
      id: 'ngrok-dev',
      provider: 'ngrok',
      publicUrl: 'https://ravioli-basics-throbbing.ngrok-free.dev/',
      credentialEnvKey: 'NGROK_AUTHTOKEN',
      credentialConfigured: true,
    });
    expect(JSON.stringify(state.profiles)).not.toContain('secret-ngrok-token');
    expect(JSON.stringify(state.profiles)).not.toContain('secret-cf-token');
  });


  it('treats an explicitly empty profile list as authoritative', () => {
    // Deleting every profile must not resurrect one from the credentials left behind.
    const state = resolveTunnelProfileState({
      XPOD_TUNNEL_PROFILES: '[]',
      NGROK_AUTHTOKEN: 'leftover-ngrok-token',
      NGROK_URL: 'https://native.ngrok-free.dev',
      CLOUDFLARE_TUNNEL_TOKEN: 'leftover-cf-token',
    });

    expect(state.profiles).toEqual([]);
    expect(state.activeProvider).toBe('none');
    expect(state.activeProfile).toBeUndefined();
  });

  it('treats an explicit active profile id of none or empty as authoritative off', () => {
    const profiles = JSON.stringify([
      { id: 'ngrok-dev', provider: 'ngrok', label: 'ngrok dev' },
    ]);

    for (const explicitOff of [ 'none', '' ]) {
      const state = resolveTunnelProfileState({
        XPOD_TUNNEL_PROFILES: profiles,
        XPOD_TUNNEL_ACTIVE_PROFILE_ID: explicitOff,
        NGROK_AUTHTOKEN: 'ngrok-token',
        XPOD_TUNNEL_PROVIDER: 'ngrok',
      });

      expect(state.profiles).toHaveLength(1);
      expect(state.activeProvider).toBe('none');
      expect(state.activeProfile).toBeUndefined();
      expect(state.inactiveProfiles.map((profile) => profile.id)).toEqual([ 'ngrok-dev' ]);
    }
  });

  it('resolves a credential per profile instead of one shared provider key', () => {
    const state = resolveTunnelProfileState({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        { id: 'account-a', provider: 'ngrok', label: 'account A' },
        { id: 'account-b', provider: 'ngrok', label: 'account B' },
      ]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'account-a',
      XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN: 'token-for-a',
      XPOD_TUNNEL_PROFILE_ACCOUNT_B_TOKEN: 'token-for-b',
    });

    expect(state.activeProfile).toMatchObject({
      id: 'account-a',
      credentialEnvKey: 'XPOD_TUNNEL_PROFILE_ACCOUNT_A_TOKEN',
      credentialConfigured: true,
    });
    expect(state.profiles.find((profile) => profile.id === 'account-b')).toMatchObject({
      credentialEnvKey: 'XPOD_TUNNEL_PROFILE_ACCOUNT_B_TOKEN',
      credentialConfigured: true,
    });
    expect(JSON.stringify(state.profiles)).not.toContain('token-for-a');
    expect(JSON.stringify(state.profiles)).not.toContain('token-for-b');
  });

  it('does not activate a provider the local runtime cannot start', () => {
    const state = selectActiveTunnelProfile([
      { id: 'generic-frp', provider: 'frp', label: 'generic frp', credentialEnvKey: 'FRP_TUNNEL_TOKEN', credentialConfigured: true },
    ], 'generic-frp');

    expect(state.activeProvider).toBe('none');
    expect(state.activeProfile).toBeUndefined();
    expect(state.activationError).toContain('no local runtime implementation');
  });

  it('accepts a sakura profile and reads the settings page publicEndpoint field', () => {
    const state = resolveTunnelProfileState({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        { id: 'sakura-home', provider: 'sakura_frp', label: 'sakura', publicEndpoint: 'https://sakura.example.com' },
      ]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'sakura-home',
      XPOD_TUNNEL_PROFILE_SAKURA_HOME_TOKEN: 'sakura-token',
    });

    expect(state.activeProfile).toMatchObject({
      id: 'sakura-home',
      provider: 'sakura_frp',
      publicUrl: 'https://sakura.example.com/',
      credentialConfigured: true,
    });
  });

  it('keeps legacy auto priority when only old provider env values exist', () => {
    const state = resolveTunnelProfileState({
      NGROK_URL: 'https://native.ngrok-free.dev',
      CLOUDFLARE_TUNNEL_TOKEN: 'cf-token',
      CLOUDFLARE_TUNNEL_URL: 'https://home-tunnel.example.com',
    });

    expect(state.profiles.map((profile) => profile.id)).toEqual(['ngrok', 'cloudflare']);
    expect(state.activeProvider).toBe('ngrok');
    expect(state.activeProfile).toMatchObject({
      id: 'ngrok',
      provider: 'ngrok',
      publicUrl: 'https://native.ngrok-free.dev/',
    });
  });

  it('keeps legacy env behavior as generated default profiles', () => {
    const state = resolveTunnelProfileState({
      XPOD_TUNNEL_PROVIDER: 'ngrok',
      NGROK_URL: 'https://native.ngrok-free.dev',
    });

    expect(state.activeProvider).toBe('ngrok');
    expect(state.activeProfile).toMatchObject({
      id: 'ngrok',
      provider: 'ngrok',
      publicUrl: 'https://native.ngrok-free.dev/',
    });
  });
});
