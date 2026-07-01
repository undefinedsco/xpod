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
