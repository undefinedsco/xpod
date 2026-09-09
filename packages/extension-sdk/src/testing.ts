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
    requireLogin: async () => undefined,
  };
}

export function createMockStorageSolidCapability(
  pod: WebExtensionSolidPod = { status: 'unavailable' },
): WebExtensionSolidCapability {
  return {
    ...createSolidCapability(),
    pod,
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

/**
 * Creates the opt-in storage-capable variant. The default mock host remains
 * identity-only so applet tests do not accidentally depend on a Pod runtime.
 */
export function createMockStorageCapableWebExtensionHost(
  overrides: MockWebExtensionHostOverrides = {},
): WebExtensionHost {
  return createMockWebExtensionHost({
    ...overrides,
    solid: overrides.solid ?? createMockStorageSolidCapability(),
  });
}
