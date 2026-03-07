import { Agent } from 'undici';

interface SocketFetchEntry {
  dispatcher: Agent;
}

const originalFetch = globalThis.fetch.bind(globalThis);
const registry = new Map<string, SocketFetchEntry>();
let patched = false;
const debugSocketFetch = process.env.XPOD_DEBUG_SOCKET_FETCH === 'true';

function resolveOrigin(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') {
    return new URL(input).origin;
  }
  if (input instanceof URL) {
    return input.origin;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return new URL(input.url).origin;
  }
  return undefined;
}

function ensurePatched(): void {
  if (patched) {
    return;
  }

  globalThis.fetch = (async(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const origin = resolveOrigin(input);
    const entry = origin ? registry.get(origin) : undefined;

    if (debugSocketFetch && origin) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
      console.log(`[socket-fetch] ${entry ? 'rewrite' : 'passthrough'} ${url}`);
    }

    if (!entry) {
      return originalFetch(input as any, init as any);
    }

    return originalFetch(input as any, {
      ...(init ?? {}),
      dispatcher: entry.dispatcher,
    } as any);
  }) as typeof fetch;

  patched = true;
}

async function maybeRestoreOriginalFetch(): Promise<void> {
  if (registry.size > 0 || !patched) {
    return;
  }

  globalThis.fetch = originalFetch as typeof fetch;
  patched = false;
}

export function registerSocketFetchOrigin(origin: string, socketPath: string): () => Promise<void> {
  const normalizedOrigin = new URL(origin).origin;
  const existing = registry.get(normalizedOrigin);
  if (!existing) {
    registry.set(normalizedOrigin, {
      dispatcher: new Agent({
        connect: {
          socketPath,
        },
      }),
    });
  }

  ensurePatched();

  return async(): Promise<void> => {
    const entry = registry.get(normalizedOrigin);
    if (!entry) {
      return;
    }

    registry.delete(normalizedOrigin);
    await entry.dispatcher.close();
    await maybeRestoreOriginalFetch();
  };
}
