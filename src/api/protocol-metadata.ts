export type ProtocolMetadata = Record<string, unknown>;

const PROTOCOL_METADATA_KEY = 'protocols';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definedEntries(values: ProtocolMetadata): ProtocolMetadata {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

export function getProtocolMetadata(
  metadata: ProtocolMetadata | null | undefined,
  namespace: string,
): ProtocolMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const protocols = metadata[PROTOCOL_METADATA_KEY];
  if (!isRecord(protocols)) {
    return undefined;
  }

  const namespaced = protocols[namespace];
  return isRecord(namespaced) ? namespaced : undefined;
}

export function withProtocolMetadata(
  metadata: ProtocolMetadata | null | undefined,
  namespace: string,
  values: ProtocolMetadata,
): ProtocolMetadata {
  const base = metadata ?? {};
  const protocols = isRecord(base[PROTOCOL_METADATA_KEY])
    ? base[PROTOCOL_METADATA_KEY] as ProtocolMetadata
    : {};
  const current = isRecord(protocols[namespace])
    ? protocols[namespace] as ProtocolMetadata
    : {};
  const next = definedEntries(values);

  return {
    ...base,
    [PROTOCOL_METADATA_KEY]: {
      ...protocols,
      [namespace]: {
        ...current,
        ...next,
      },
    },
  };
}

export function withoutProtocolProjectionKeys(
  metadata: ProtocolMetadata | null | undefined,
  keys: readonly string[],
): ProtocolMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const result = { ...metadata };
  for (const key of keys) {
    delete result[key];
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
