const KEY_SEPARATOR = '\u0000';
function normalizeIdentityPart(value) {
    const trimmed = value.trim();
    try {
        return new URL(trimmed).href;
    }
    catch {
        return trimmed;
    }
}
function compositeKey(webId, podUrl) {
    return `${normalizeIdentityPart(webId)}${KEY_SEPARATOR}${normalizeIdentityPart(podUrl)}`;
}
function nextGeneration(generations, webIdKey) {
    const generation = (generations.get(webIdKey) ?? 0) + 1;
    generations.set(webIdKey, generation);
    return generation;
}
function createAbortedOpenError() {
    const error = new Error('Pod open aborted because the runtime identity changed');
    error.name = 'AbortError';
    return error;
}
export function createPodRuntime(options) {
    const { adapter } = options;
    const readyByWebId = new Map();
    const readyByComposite = new Map();
    const pendingByWebId = new Map();
    const generations = new Map();
    const clear = (identity) => {
        if (!identity) {
            readyByWebId.clear();
            readyByComposite.clear();
            for (const pending of pendingByWebId.values()) {
                pending.controller.abort();
            }
            pendingByWebId.clear();
            for (const webIdKey of generations.keys()) {
                nextGeneration(generations, webIdKey);
            }
            return;
        }
        if (typeof identity === 'string') {
            clearWebId(identity);
            return;
        }
        clearWebId(identity.webId, identity.podUrl);
    };
    const clearWebId = (webId, podUrl) => {
        const webIdKey = normalizeIdentityPart(webId);
        nextGeneration(generations, webIdKey);
        pendingByWebId.get(webIdKey)?.controller.abort();
        pendingByWebId.delete(webIdKey);
        if (podUrl) {
            const key = compositeKey(webId, podUrl);
            readyByComposite.delete(key);
            if (normalizeIdentityPart(readyByWebId.get(webIdKey)?.podUrl ?? '') === normalizeIdentityPart(podUrl)) {
                readyByWebId.delete(webIdKey);
            }
            return;
        }
        const existing = readyByWebId.get(webIdKey);
        if (existing) {
            readyByComposite.delete(compositeKey(existing.webId, existing.podUrl));
        }
        readyByWebId.delete(webIdKey);
    };
    return {
        open(args) {
            const webIdKey = normalizeIdentityPart(args.webId);
            const cached = readyByWebId.get(webIdKey);
            if (cached) {
                return Promise.resolve(cached);
            }
            const pending = pendingByWebId.get(webIdKey);
            if (pending) {
                return pending.promise;
            }
            const generation = generations.get(webIdKey) ?? 0;
            generations.set(webIdKey, generation);
            const controller = new AbortController();
            const isCurrent = () => !controller.signal.aborted && (generations.get(webIdKey) ?? 0) === generation;
            const assertCurrent = () => {
                if (!isCurrent()) {
                    throw createAbortedOpenError();
                }
            };
            const promise = (async () => {
                const podUrl = await adapter.discoverPod({
                    webId: args.webId,
                    fetch: args.fetch,
                    signal: controller.signal,
                    isCurrent,
                });
                assertCurrent();
                const key = compositeKey(args.webId, podUrl);
                const existing = readyByComposite.get(key);
                if (existing) {
                    if (isCurrent()) {
                        readyByWebId.set(webIdKey, existing);
                    }
                    return existing;
                }
                const database = await adapter.openDatabase({
                    webId: args.webId,
                    podUrl,
                    fetch: args.fetch,
                    signal: controller.signal,
                    isCurrent,
                });
                assertCurrent();
                await adapter.hydrateCollections({
                    webId: args.webId,
                    podUrl,
                    database,
                    signal: controller.signal,
                    isCurrent,
                });
                assertCurrent();
                const opened = {
                    webId: args.webId,
                    podUrl,
                    database,
                    collections: 'ready',
                };
                if (isCurrent()) {
                    readyByWebId.set(webIdKey, opened);
                    readyByComposite.set(key, opened);
                }
                return opened;
            })();
            pendingByWebId.set(webIdKey, { generation, promise, controller });
            const removePending = () => {
                const pendingOpen = pendingByWebId.get(webIdKey);
                if (pendingOpen?.generation === generation && pendingOpen.promise === promise) {
                    pendingByWebId.delete(webIdKey);
                }
            };
            promise.then(removePending, removePending);
            return promise;
        },
        clear,
        dispose() {
            clear();
        },
    };
}
