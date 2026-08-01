function createMockSolidSession(snapshot, fetcher) {
    return {
        fetch: fetcher,
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
    };
}
function createSolidCapability() {
    return {
        session: createMockSolidSession({ status: 'anonymous' }, globalThis.fetch),
        pod: { status: 'unavailable' },
        requireLogin: async () => undefined,
    };
}
export function createMockWebExtensionHost(overrides = {}) {
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
