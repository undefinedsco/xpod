import { applyEnv, loadEnvFile } from './env-utils';
import { buildRuntimeEnv, buildRuntimeShorthand, type RuntimeBootstrapState } from './bootstrap';
import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';
import type { XpodRuntimeOptions } from './runtime-types';
import {
  readLocalProvisionState,
  resolveLocalSetupPath,
  resolveLocalSetupProviderId,
} from '../provision/LocalProvisionState';

export interface RuntimeEnvironmentSession {
  env: Record<string, string | undefined>;
  shorthand: Record<string, string | number | boolean>;
  restore: () => void;
}

/**
 * A registered Local Xpod must resume its managed route without asking the
 * operator to repeat Cloud-owned values as environment variables.
 *
 * Explicit env-file/options values still win over these persisted defaults,
 * so deployments can deliberately disable or override the route when needed.
 */
export function restoreLocalManagedRouteEnv(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
  envFromFile: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (state.mode !== 'local') {
    return envFromFile;
  }

  const configuredEnv = {
    ...envFromFile,
    ...options.env,
  };
  const setupPath = resolveLocalSetupPath(configuredEnv.XPOD_LOCAL_SETUP_PATH, state.rootFilePath);
  const providerId = resolveLocalSetupProviderId(configuredEnv.XPOD_PROVIDER_ID);
  const persisted = readLocalProvisionState(setupPath, providerId);
  if (!persisted?.nodeId || !persisted.nodeToken || !persisted.cloudApiUrl) {
    return envFromFile;
  }

  return {
    oidcIssuer: persisted.cloudIdentityUrl,
    XPOD_NODE_ID: persisted.nodeId,
    XPOD_NODE_TOKEN: persisted.nodeToken,
    XPOD_SERVICE_TOKEN: persisted.serviceToken,
    XPOD_PROVISION_CODE: persisted.provisionCode,
    XPOD_PROVISION_URL: persisted.provisionUrl,
    XPOD_SP_DOMAIN: persisted.spDomain,
    XPOD_PUBLIC_URL: persisted.publicUrl,
    XPOD_CLOUD_API_ENDPOINT: persisted.cloudApiUrl,
    XPOD_EDGE_NODE_AGENT_ENABLED: 'true',
    XPOD_SIGNAL_ENDPOINT: new URL('/v1/signal', persisted.cloudApiUrl).toString(),
    XPOD_P2P_ENABLED: 'true',
    XPOD_P2P_TARGET_BASE_URL: state.baseUrl,
    ...envFromFile,
  };
}

export function createRuntimeEnvironmentSession(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
  platform: RuntimePlatform = nodeRuntimePlatform,
): RuntimeEnvironmentSession {
  const rawEnvFromFile = state.envFilePath ? loadEnvFile(state.envFilePath, platform) : {};
  const envFromFile = restoreLocalManagedRouteEnv(state, options, rawEnvFromFile);
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
