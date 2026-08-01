import { describe, expect, it } from 'vitest';
import { deriveAppletRouteId, validateExtensionManifest } from '../src/manifest';
import { createMockWebExtensionHost } from '../src/testing';

const validManifest = {
  extensionId: 'https://undefineds.co/extensions/ai-connection',
  name: 'AI Connection',
  version: '0.1.0',
  sdkVersion: '1',
  contributes: {
    applets: [{
      appId: 'https://undefineds.co/applets/ai-connection',
      name: 'AI Connection',
      entry: './applet.js',
      commands: [],
      layout: 'single-pane',
    }],
  },
  dataModels: [],
  hostCapabilities: ['navigation.openExternal'],
};

describe('validateExtensionManifest', () => {
  it('derives a safe Host route id from stable Applet identity', () => {
    expect(deriveAppletRouteId(validManifest.contributes.applets[0])).toBe('ai-connection');
    expect(() => deriveAppletRouteId({
      ...validManifest.contributes.applets[0],
      appId: 'https://example.test/applets/Not%20Safe',
    })).toThrow('safe route id');
  });

  it('accepts a valid HTTPS Extension with one Applet contribution', () => {
    expect(validateExtensionManifest(validManifest)).toEqual(validManifest);
  });

  it('rejects duplicate Applet identities', () => {
    expect(() => validateExtensionManifest({
      ...validManifest,
      contributes: {
        applets: [
          validManifest.contributes.applets[0],
          validManifest.contributes.applets[0],
        ],
      },
    })).toThrow(/duplicate appId/);
  });

  it('rejects an Applet without an entry', () => {
    expect(() => validateExtensionManifest({
      ...validManifest,
      contributes: {
        applets: [{
          ...validManifest.contributes.applets[0],
          entry: '',
        }],
      },
    })).toThrow(/entry/);
  });

  it('rejects unknown Host capabilities', () => {
    expect(() => validateExtensionManifest({
      ...validManifest,
      hostCapabilities: ['xpod.internal'],
    })).toThrow(/unknown Host capability/);
  });
});

describe('createMockWebExtensionHost', () => {
  it('creates an isolated anonymous Host and applies explicit Solid overrides', () => {
    const anonymous = createMockWebExtensionHost();
    const authenticated = createMockWebExtensionHost({
      solid: {
        session: {
          fetch: globalThis.fetch,
          getSnapshot: () => ({
            status: 'authenticated',
            webId: 'https://pod.example/alice/profile/card#me',
          }),
          subscribe: () => () => undefined,
        },
        pod: { status: 'unavailable' },
        requireLogin: async () => undefined,
      },
    });

    expect(anonymous.solid.session.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(authenticated.solid.session.getSnapshot()).toEqual({
      status: 'authenticated',
      webId: 'https://pod.example/alice/profile/card#me',
    });
    expect(authenticated).not.toBe(anonymous);
  });
});
