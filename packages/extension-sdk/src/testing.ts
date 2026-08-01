import type { SolidSessionSnapshot } from '@undefineds.co/solid-sdk';
import type {
  WebExtensionHost,
  WebExtensionSolidCapability,
  WebExtensionSolidPod,
  WebExtensionSolidSession,
} from './web';

export interface MockWebExtensionHostOverrides {
  solid?: WebExtensionSolidCapability;
  navigation?: Partial<WebExtensionHost['navigation']>;
  capabilities?: WebExtensionHost['capabilities'];
}

function createMockSolidSession(
  snapshot: SolidSessionSnapshot,
  fetcher: typeof fetch,
): WebExtensionSolidSession {
  return {
    fetch: fetcher,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  };
}

function createSolidCapability(): WebExtensionSolidCapability {
  return {
    session: createMockSolidSession({ status: 'anonymous' }, globalThis.fetch),
    pod: { status: 'unavailable' },
    requireLogin: async () => undefined,
  };
}

export function createMockWebExtensionHost(
  overrides: MockWebExtensionHostOverrides = {},
): WebExtensionHost {
  const solid = overrides.solid ?? createSolidCapability();

  return {
    solid,
    navigation: {
      openExternal: async () => undefined,
      ...overrides.navigation,
    },
    capabilities: {
      ...overrides.capabilities,
    },
  };
}
