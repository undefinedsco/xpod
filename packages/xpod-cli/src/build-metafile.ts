/** Producer-side deterministic JSON representation of the actual bundler
 * metafile. Arrays retain order; no path, value or evidence is discarded.
 * Callers keep raw invocation bytes separately before publishing this form. */
export function canonicalBuildMetafile(raw: Buffer): Buffer {
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new Error('Build metafile must be UTF-8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.inputs || !value.outputs
    || typeof value.inputs !== 'object' || Array.isArray(value.inputs)
    || typeof value.outputs !== 'object' || Array.isArray(value.outputs)) throw new Error('Complete build metafile required');
  const sorted = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sorted);
    if (node !== null && typeof node === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(node).sort()) result[key] = sorted((node as Record<string, unknown>)[key]);
      return result;
    }
    if (typeof node === 'number' && !Number.isFinite(node)) throw new Error('Finite metafile numbers required');
    return node;
  };
  return Buffer.from(JSON.stringify(sorted(value), null, 2) + '\n');
}

/** Explicit producer schema projection from physical to logical metafile paths.
 * Only the declared key and path locations are touched; this never rewrites
 * arbitrary strings, and a binding may not overwrite an unmapped key. */
export function projectBuildMetafile(
  raw: Buffer,
  bindings: readonly { physicalPath: string; logicalPath: string }[],
): Buffer {
  const targets = validateBindings(bindings);
  const canonical = canonicalBuildMetafile(raw);
  const value: Record<string, unknown> = JSON.parse(canonical.toString('utf8'));
  if (!isRecord(value.inputs) || !isRecord(value.outputs)) {
    throw new Error('Complete build metafile required');
  }

  const mapPath = (path: string): string => targets.get(path) ?? path;

  const projectImports = (imports: unknown): unknown => {
    if (!Array.isArray(imports)) return imports;
    return imports.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== 'string' || !targets.has(entry.path)) return entry;
      const projected: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(entry)) {
        projected[key] = key === 'path' ? mapPath(entry.path) : field;
      }
      return projected;
    });
  };

  const projectKeys = (
    source: Record<string, unknown>,
    location: string,
    projectValue: (entry: unknown) => unknown,
  ): Record<string, unknown> => {
    const projected: Record<string, unknown> = Object.create(null);
    const produced = new Set<string>();
    for (const [key, entry] of Object.entries(source)) {
      const target = mapPath(key);
      if (produced.has(target)) {
        throw new Error(`Build metafile binding collides with existing ${location} key: ${JSON.stringify(target)}`);
      }
      produced.add(target);
      projected[target] = projectValue(entry);
    }
    return projected;
  };

  const projectInput = (entry: unknown): unknown => {
    if (!isRecord(entry)) return entry;
    const projected: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(entry)) {
      projected[key] = key === 'imports' ? projectImports(field) : field;
    }
    return projected;
  };

  const projectOutput = (entry: unknown): unknown => {
    if (!isRecord(entry)) return entry;
    const projected: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(entry)) {
      if (key === 'imports') projected[key] = projectImports(field);
      else if (key === 'entryPoint') {
        projected[key] = typeof field === 'string' && targets.has(field) ? mapPath(field) : field;
      } else if (key === 'inputs' && isRecord(field)) {
        projected[key] = projectKeys(field, 'output.inputs', (nested) => nested);
      } else projected[key] = field;
    }
    return projected;
  };

  const result: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'inputs') result[key] = projectKeys(value.inputs, 'inputs', projectInput);
    else if (key === 'outputs') result[key] = projectKeys(value.outputs, 'outputs', projectOutput);
    else result[key] = field;
  }
  return canonicalBuildMetafile(Buffer.from(JSON.stringify(result)));
}

function validateBindings(
  bindings: readonly { physicalPath: string; logicalPath: string }[],
): Map<string, string> {
  if (!Array.isArray(bindings)) throw new Error('Build metafile bindings must be an array');
  const targets = new Map<string, string>();
  const logicalPaths = new Set<string>();
  for (const candidate of bindings as readonly unknown[]) {
    if (!isRecord(candidate)) throw new Error('Build metafile bindings must be objects');
    const { physicalPath, logicalPath } = candidate;
    if (typeof physicalPath !== 'string' || physicalPath.length === 0) {
      throw new Error('Build metafile binding physicalPath must be a non-empty string');
    }
    if (typeof logicalPath !== 'string') throw new Error('Build metafile binding logicalPath must be a string');
    assertLogicalPath(logicalPath);
    if (targets.has(physicalPath)) {
      throw new Error(`Duplicate build metafile physicalPath: ${JSON.stringify(physicalPath)}`);
    }
    if (logicalPaths.has(logicalPath)) {
      throw new Error(`Duplicate build metafile logicalPath: ${JSON.stringify(logicalPath)}`);
    }
    targets.set(physicalPath, logicalPath);
    logicalPaths.add(logicalPath);
  }
  return targets;
}

function assertLogicalPath(logicalPath: string): void {
  if (logicalPath.length === 0 || logicalPath.startsWith('/') || logicalPath.includes('\\')
    || /\p{Cc}/u.test(logicalPath)) {
    throw new Error(`Invalid build metafile logicalPath: ${JSON.stringify(logicalPath)}`);
  }
  for (const segment of logicalPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid build metafile logicalPath: ${JSON.stringify(logicalPath)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
