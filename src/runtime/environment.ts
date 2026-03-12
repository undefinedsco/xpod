import { applyEnv, loadEnvFile } from './env-utils';
import { buildRuntimeEnv, buildRuntimeShorthand, type RuntimeBootstrapState } from './bootstrap';
import type { XpodRuntimeOptions } from './runtime-types';

export interface RuntimeEnvironmentSession {
  env: Record<string, string | undefined>;
  shorthand: Record<string, string | number | boolean>;
  restore: () => void;
}

export function createRuntimeEnvironmentSession(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
): RuntimeEnvironmentSession {
  const envFromFile = state.envFilePath ? loadEnvFile(state.envFilePath) : {};
  const env = buildRuntimeEnv(state, options, envFromFile);
  const restoreEnv = applyEnv(env);
  const shorthand = buildRuntimeShorthand(env, options, state);

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
