type SocketOriginEntry = {
  socketPath: string;
  refCount: number;
};

const registry = new Map<string, SocketOriginEntry>();

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

export function getSocketPathForOrigin(origin: string): string | undefined {
  return registry.get(normalizeOrigin(origin))?.socketPath;
}

export function registerSocketOrigin(origin: string, socketPath: string): () => void {
  const normalizedOrigin = normalizeOrigin(origin);
  const existing = registry.get(normalizedOrigin);

  if (existing) {
    if (existing.socketPath !== socketPath) {
      throw new Error(
        `Conflicting socket registration for ${normalizedOrigin}: ` +
        `${existing.socketPath} !== ${socketPath}`,
      );
    }
    existing.refCount += 1;
  } else {
    registry.set(normalizedOrigin, {
      socketPath,
      refCount: 1,
    });
  }

  let cleanedUp = false;
  return (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    const entry = registry.get(normalizedOrigin);
    if (!entry) {
      return;
    }

    if (entry.refCount <= 1) {
      registry.delete(normalizedOrigin);
      return;
    }

    entry.refCount -= 1;
  };
}
