import { applyEnv, loadEnvFile } from './env-utils';
import { buildRuntimeEnv, buildRuntimeShorthand, type RuntimeBootstrapState } from './bootstrap';
import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';
import type { XpodRuntimeOptions } from './runtime-types';

export interface RuntimeEnvironmentSession {
  env: Record<string, string | undefined>;
  shorthand: Record<string, string | number | boolean>;
  restore: () => void;
}

export function createRuntimeEnvironmentSession(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
  platform: RuntimePlatform = nodeRuntimePlatform,
): RuntimeEnvironmentSession {
  const envFromFile = state.envFilePath ? loadEnvFile(state.envFilePath, platform) : {};
  const env = buildRuntimeEnv(state, options, envFromFile);
  const restoreEnv = applyEnv(env, platform);
  const shorthand = buildRuntimeShorthand(env, options, state, platform.baseEnv);

  let restored = false;

  return {
    env,
    shorthand,
    restore: (): void => {
      if (restored) {
        return;
      }
      restored = true;
      restoreEnv();
    },
  };
}
