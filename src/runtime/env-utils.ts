import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';

const legacyEnvAliases = [
  [ 'CSS_EDITION', 'XPOD_EDITION' ],
  [ 'XPOD_MODE', 'XPOD_EDITION' ],
  [ 'CSS_NODE_ID', 'XPOD_NODE_ID' ],
  [ 'CSS_NODE_TOKEN', 'XPOD_NODE_TOKEN' ],
  [ 'CSS_SIGNAL_ENDPOINT', 'XPOD_SIGNAL_ENDPOINT' ],
] as const;

const legacyCssChildEnvKeys = [
  'CSS_EDITION',
  'CSS_EDGE_AGENT_ENABLED',
  'CSS_SIGNAL_ENDPOINT',
  'CSS_NODE_TOKEN',
  'CSS_NODE_PUBLIC_ADDRESS',
] as const;

export function loadEnvFile(
  envPath: string,
  platform: Pick<RuntimePlatform, 'fileExists' | 'readTextFile'> = nodeRuntimePlatform,
): Record<string, string> {
  if (!platform.fileExists(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }

  const values: Record<string, string> = {};
  const content = platform.readTextFile(envPath);
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function applyEnv(
  overrides: Record<string, string | undefined>,
  platform: Pick<RuntimePlatform, 'getEnv' | 'setEnv'> = nodeRuntimePlatform,
): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [ key, value ] of Object.entries(overrides)) {
    previous.set(key, platform.getEnv(key));
    platform.setEnv(key, value);
  }

  return (): void => {
    for (const [ key, value ] of previous.entries()) {
      platform.setEnv(key, value);
    }
  };
}

export function normalizeLegacyRuntimeEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...baseEnv };

  for (const [ legacyKey, targetKey ] of legacyEnvAliases) {
    if (!normalized[targetKey] && normalized[legacyKey]) {
      normalized[targetKey] = normalized[legacyKey];
    }
  }

  return normalized;
}

export function getLegacyCssEnvKeys(
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return legacyCssChildEnvKeys.filter((key) => Boolean(baseEnv[key]));
}

export function createCssChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const normalized = normalizeLegacyRuntimeEnv(baseEnv);

  for (const key of legacyCssChildEnvKeys) {
    delete normalized[key];
  }

  return normalized;
}
