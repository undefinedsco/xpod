import { afterEach, describe, expect, it } from 'vitest';
import {
  createAllowedAdminConfigPatch,
  projectTunnelProfiles,
} from '../../../src/api/handlers/AdminHandler';

const MANAGED_KEYS = [
  'XPOD_TUNNEL_PROFILES',
  'XPOD_TUNNEL_ACTIVE_PROFILE_ID',
  'XPOD_TUNNEL_PROVIDER',
  'NGROK_AUTHTOKEN',
  'CLOUDFLARE_TUNNEL_TOKEN',
  'XPOD_TUNNEL_PROFILE_HOME_TOKEN',
  'XPOD_TUNNEL_PROFILE_OFFICE_TOKEN',
];

const previous = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of MANAGED_KEYS) {
    if (!previous.has(key)) {
      previous.set(key, process.env[key]);
    }
    delete process.env[key];
  }
  for (const [ key, value ] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const [ key, value ] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previous.clear();
});

describe('admin tunnel profile projection', () => {
  it('addresses every profile with its own credential key so one secret cannot serve two profiles', () => {
    setEnv({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        { id: 'home', provider: 'ngrok' },
        { id: 'office', provider: 'ngrok' },
      ]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'home',
      XPOD_TUNNEL_PROFILE_HOME_TOKEN: 'home-secret',
    });

    const profiles = projectTunnelProfiles();

    expect(profiles.map((profile) => [ profile.id, profile.credentialEnvKey ])).toEqual([
      [ 'home', 'XPOD_TUNNEL_PROFILE_HOME_TOKEN' ],
      [ 'office', 'XPOD_TUNNEL_PROFILE_OFFICE_TOKEN' ],
    ]);
    // The configured profile is the active one; the other one is honestly reported as unconfigured.
    expect(profiles.map((profile) => [ profile.id, profile.credentialConfigured, profile.active ])).toEqual([
      [ 'home', true, true ],
      [ 'office', false, false ],
    ]);
  });

  it('keeps a profile-scoped credential writable through the admin config patch', () => {
    const patch = createAllowedAdminConfigPatch({
      XPOD_TUNNEL_PROFILE_OFFICE_TOKEN: 'office-secret',
      XPOD_TUNNEL_PROFILES: JSON.stringify([{ id: 'office', provider: 'ngrok' }]),
    });

    expect(patch.XPOD_TUNNEL_PROFILE_OFFICE_TOKEN).toBe('office-secret');
    expect(patch.XPOD_TUNNEL_PROFILES).toContain('office');
  });

  it('serves profile parameters so the operator console cannot drop them', () => {
    setEnv({
      XPOD_TUNNEL_PROFILES: JSON.stringify([
        { id: 'home', provider: 'ngrok', parameters: { region: 'ap' } },
      ]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'home',
      XPOD_TUNNEL_PROFILE_HOME_TOKEN: 'home-secret',
    });

    expect(projectTunnelProfiles()[0].parameters).toEqual({ region: 'ap' });
  });

  it('reports the legacy provider key only when no profile-scoped credential exists', () => {
    setEnv({
      XPOD_TUNNEL_PROFILES: JSON.stringify([{ id: 'home', provider: 'cloudflare' }]),
      XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'home',
      CLOUDFLARE_TUNNEL_TOKEN: 'legacy-secret',
    });

    expect(projectTunnelProfiles()).toEqual([
      expect.objectContaining({
        id: 'home',
        provider: 'cloudflare',
        credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
        credentialConfigured: true,
        active: true,
      }),
    ]);
  });
});
