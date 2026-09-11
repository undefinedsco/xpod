import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Configuration } from 'oidc-provider';
import { SessionBoundIdentityProviderFactory } from '../../../src/identity/oidc/SessionBoundIdentityProviderFactory';
import { XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';

// Exercise CSS's real configuration-cloning boundary: a hook lost here silently
// reverts issuance to offline_access-only when the provider is constructed.
async function configuration(config: Configuration = {}): Promise<Configuration> {
  const factory = new SessionBoundIdentityProviderFactory(config, {
    storage: { get: vi.fn().mockResolvedValue(['test-cookie-key']) },
    adapterFactory: {},
  } as any);
  return (factory as any).initConfig({ alg: 'RS256' });
}

function authorization(clientId: string, offline = false, bound = true, allowed = true): any[] {
  return [{}, { clientId, grantTypeAllowed: vi.fn(() => allowed) }, {
    scopes: new Set(offline ? ['openid', 'offline_access'] : ['openid']),
    expiresWithSession: bound,
  }];
}

async function issue(config: Configuration, args: any[]): Promise<boolean> {
  return (config.issueRefreshToken as any)(...args);
}

describe('SessionBoundIdentityProviderFactory', () => {
  it('preserves the online refresh hook through the CSS configuration clone', async () => {
    const config = await configuration({ ttl: { AccessToken: 3600, Session: 1209600 } });
    expect(await issue(config, authorization(XPOD_DESKTOP_CLIENT_ID))).toBe(true);
    expect(config.ttl).toEqual({ AccessToken: 3600, Session: 1209600 });
    expect(config).not.toHaveProperty('expiresWithSession');
  });

  it.each([
    ['another client', 'https://another.example/client', false, true, true],
    ['unbound desktop code', XPOD_DESKTOP_CLIENT_ID, false, false, true],
    ['desktop without refresh grant', XPOD_DESKTOP_CLIENT_ID, false, true, false],
    ['offline without refresh grant', XPOD_DESKTOP_CLIENT_ID, true, false, false],
  ])('rejects %s', async (_name, clientId, offline, bound, allowed) => {
    expect(await issue(await configuration(), authorization(clientId, offline, bound, allowed))).toBe(false);
  });

  it('rejects online codes without an explicit session binding', async () => {
    const args = authorization(XPOD_DESKTOP_CLIENT_ID);
    delete args[2].expiresWithSession;
    expect(await issue(await configuration(), args)).toBe(false);
  });

  it('preserves default offline refresh for other clients', async () => {
    expect(await issue(await configuration(), authorization('https://another.example/client', true, false))).toBe(true);
  });

  it('does not override an explicit custom issuance policy', async () => {
    const issueRefreshToken = vi.fn(async () => false);
    const config = await configuration({ issueRefreshToken });
    const args = authorization(XPOD_DESKTOP_CLIENT_ID);
    expect(await issue(config, args)).toBe(false);
    expect(issueRefreshToken).toHaveBeenCalledWith(...args);
    expect(config.issueRefreshToken).toBe(issueRefreshToken);
  });
});

describe('SessionBoundIdentityProviderFactory DI configuration', () => {
  it.each(['local', 'cloud'])('preserves the provider configuration in %s mode', async (mode) => {
    const { ComponentsManager } = await import('componentsjs');
    const { DataFactory } = await import('rdf-data-factory');
    const manager = await ComponentsManager.build({
      mainModulePath: process.cwd(), logLevel: 'error', typeChecking: false,
    });
    const { createCssChildRuntimeConfig } = await import('../../../src/runtime/css-process');
    const temporaryParent = path.resolve('.test-data/session-bound-provider-config');
    fs.mkdirSync(temporaryParent, { recursive: true });
    const runtimeRoot = fs.mkdtempSync(path.join(temporaryParent, `${mode}-`));
    try {
      const runtimeConfig = createCssChildRuntimeConfig({
        configPath: path.resolve(`config/${mode}.json`), runtimeRoot, authMode: 'acp',
      });
      await manager.configRegistry.register(runtimeConfig.configPath);
      const resource = manager.configRegistry.getInstantiatedResource(
        new DataFactory().namedNode('urn:solid-server:default:IdentityProviderFactory'),
      );
      expect(resource).toBeDefined();
      const raw = (manager.configConstructorPool as any).getRawConfig(resource);
      const args = raw.properties['https://linkedsoftwaredependencies.org/vocabularies/object-oriented#arguments'][0].list;
      expect(resource!.property.type.value).toContain('#SessionBoundIdentityProviderFactory');
      const config = JSON.parse(args[0].value);
      expect(config.ttl.AccessToken).toBe(3600);
      expect(config.scopes).toContain('offline_access');
      const prefix = `${resource!.property.type.value}_args_`;
      for (const name of ['promptFactory', 'adapterFactory', 'baseUrl', 'oidcPath', 'clientCredentialsStore',
        'storage', 'jwkGenerator', 'showStackTrace', 'errorHandler', 'responseWriter', 'interactionRoute']) {
        expect(resource!.properties[`${prefix}${name}`], name).toHaveLength(1);
      }
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
