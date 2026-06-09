const CONFIG_ASSET_KEYS = new Set([
  'filePath',
  'htmlFile',
  'template',
  'templateFolder',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRelativeAssetPath(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../');
}

export function rewriteConfigAssetPaths(
  parsed: Record<string, unknown>,
  sourceConfigPath: string,
  resolveAssetPath: (sourceConfigPath: string, assetPath: string) => string,
): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      if (CONFIG_ASSET_KEYS.has(key) && typeof entry === 'string' && isRelativeAssetPath(entry)) {
        value[key] = resolveAssetPath(sourceConfigPath, entry);
        continue;
      }
      visit(entry);
    }
  };

  visit(parsed);
}
