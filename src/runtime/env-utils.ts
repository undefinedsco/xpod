import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';

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
