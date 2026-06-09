type JsonObject = Record<string, unknown>;

export type ComponentParameterContext = Record<string, {
  '@id'?: string
  '@context'?: Record<string, unknown>
}>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractComponentParameterContext(document: unknown): ComponentParameterContext | undefined {
  if (!isObject(document)) {
    return undefined;
  }

  const result: ComponentParameterContext = {};
  const contexts = Array.isArray(document['@context'])
    ? document['@context']
    : [document['@context']];

  for (const context of contexts) {
    if (!isObject(context)) {
      continue;
    }

    for (const [key, value] of Object.entries(context)) {
      if (isObject(value) && isObject(value['@context'])) {
        result[key] = value as ComponentParameterContext[string];
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeComponentParameterKeys(
  document: unknown,
  componentContext: ComponentParameterContext | undefined,
): void {
  if (!componentContext) {
    return;
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!isObject(value)) {
      return;
    }

    const type = value['@type'];
    if (typeof type === 'string') {
      const typeDefinition = componentContext[type];
      const typeContext = typeDefinition?.['@context'];
      if (typeContext) {
        for (const key of Object.keys(value)) {
          if (
            key.startsWith('@') ||
            key === 'comment'
          ) {
            continue;
          }

          const lookupKey = key.startsWith(`${type}:`)
            ? key.slice(type.length + 1)
            : key.includes(':')
              ? undefined
              : key;
          const normalized = lookupKey
            ? normalizedComponentKey(type, typeDefinition, typeContext, lookupKey)
            : undefined;
          if (!normalized || normalized.key === key) {
            continue;
          }

          if (!(normalized.key in value)) {
            value[normalized.key] = normalizeComponentValue(value[key], normalized.container);
          }
          delete value[key];
        }
      }
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(document);
}

function normalizedComponentKey(
  type: string,
  typeDefinition: ComponentParameterContext[string],
  typeContext: Record<string, unknown>,
  key: string,
): { key: string; container?: unknown } | undefined {
  const termDefinition = typeContext[key];
  if (!isObject(termDefinition)) {
    return undefined;
  }

  const typeId = typeDefinition['@id'];
  const termId = termDefinition['@id'];
  if (typeof typeId !== 'string' || typeof termId !== 'string' || !termId.startsWith(typeId)) {
    return undefined;
  }

  const localName = termId.slice(typeId.length);
  return localName ? {
    key: `${type}:${localName}`,
    container: termDefinition['@container'],
  } : undefined;
}

function normalizeComponentValue(value: unknown, container: unknown): unknown {
  if (
    container === '@list' &&
    Array.isArray(value) &&
    !(value.length === 1 && isObject(value[0]) && '@list' in value[0])
  ) {
    return { '@list': value };
  }
  return value;
}
