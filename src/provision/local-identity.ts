import {
  readLocalProvisionState,
  resolveLocalSetupPath,
  resolveLocalSetupProviderId,
  type LocalProvisionState,
} from './LocalProvisionState';
import { loadOrGenerateDeviceId } from './device-id';

/**
 * Everything about *this device's* Local identity, read from the ONE existing
 * authority: the process environment, then the provider-scoped setup record.
 *
 * The API container, the legacy CLI and the modular launcher all resolve the
 * same values here, so a launcher can no longer start CSS with a different
 * node identity or setup record than the API child it is about to create.
 */
export interface RuntimeIdentity {
  /** Root the children receive as CSS_ROOT_FILE_PATH. */
  rootDir: string;
  /** Absolute, provider-scoped registration file. */
  localSetupPath: string;
  localSetupProviderId: string;
  /** Local-edition registration state, or undefined for cloud/standalone. */
  localSetupState?: LocalProvisionState;
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  provisionCode?: string;
  publicUrl?: string;
  spDomain?: string;
}

export function loadRuntimeIdentity(
  env: Record<string, string | undefined>,
  edition: 'local' | 'cloud',
  rootDir = env.CSS_ROOT_FILE_PATH || './data',
): RuntimeIdentity {
  const localSetupPath = resolveLocalSetupPath(env.XPOD_LOCAL_SETUP_PATH, rootDir);
  const localSetupProviderId = resolveLocalSetupProviderId(env.XPOD_PROVIDER_ID);
  const localSetupState = edition === 'local'
    ? readLocalProvisionState(localSetupPath, localSetupProviderId)
    : undefined;

  return {
    rootDir,
    localSetupPath,
    localSetupProviderId,
    localSetupState,
    // A stable device id is generated under the SAME data root the children use.
    nodeId: loadOrGenerateDeviceId(env.XPOD_NODE_ID ?? localSetupState?.nodeId, rootDir),
    nodeToken: env.XPOD_NODE_TOKEN ?? localSetupState?.nodeToken,
    serviceToken: env.XPOD_SERVICE_TOKEN ?? localSetupState?.serviceToken,
    provisionCode: env.XPOD_PROVISION_CODE ?? localSetupState?.provisionCode,
    publicUrl: env.XPOD_PUBLIC_URL ?? localSetupState?.publicUrl,
    spDomain: env.XPOD_SP_DOMAIN ?? localSetupState?.spDomain,
  };
}

/** The fields a provisioned identity exports to child processes. */
export interface ProvisionedRuntimeIdentity {
  oidcIssuer?: string;
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  provisionCode?: string;
  publicUrl?: string;
  spDomain?: string;
  localSetupPath?: string;
  localSetupProviderId?: string;
}

/**
 * The ONE field list that carries a provisioned identity into a child runtime.
 *
 * XpodRuntime and the modular launcher both spread this instead of each
 * maintaining its own copy, so a new identity field cannot reach one host and
 * silently miss the other.
 */
export function provisionedRuntimeEnv(
  identity: ProvisionedRuntimeIdentity,
): Record<string, string | undefined> {
  return {
    SOLID_OIDC_ISSUER: identity.oidcIssuer,
    XPOD_NODE_ID: identity.nodeId,
    XPOD_NODE_TOKEN: identity.nodeToken,
    XPOD_SERVICE_TOKEN: identity.serviceToken,
    XPOD_PROVISION_CODE: identity.provisionCode,
    XPOD_PUBLIC_URL: identity.publicUrl,
    XPOD_SP_DOMAIN: identity.spDomain,
    XPOD_LOCAL_SETUP_PATH: identity.localSetupPath,
    XPOD_PROVIDER_ID: identity.localSetupProviderId,
  };
}
