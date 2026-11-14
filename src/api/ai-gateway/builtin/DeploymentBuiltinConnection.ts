import type { AuthContext } from '../../auth/AuthContext';
import { getWebId } from '../../auth/AuthContext';
import { CloudGatewayModelsClient } from '../CloudGatewayModelsClient';
import type { GatewayModelProjection } from '../routing/ModelRouter';

/** Provider id reported for the deployment built-in connection. */
export const DEPLOYMENT_BUILTIN_CONNECTION_ID = 'xpod-builtin';
/** The platform entry models every Cloud deployment offers. */
export const DEPLOYMENT_BUILTIN_MODEL_IDS = ['linx', 'linx-lite'] as const;

export interface DeploymentBuiltinConnectionConfig {
  /** Upstream OpenAI-compatible base, for example `http://ai-gateway/v1`. */
  apiBase: string;
  /** Deployment-owned key; sent upstream only, never returned or logged. */
  apiKey: string;
  /** Public model id -> upstream model id. Defaults to identity. */
  modelMap: Readonly<Record<string, string>>;
}

/**
 * Reads the built-in connection from deployment env. It exists only on Cloud and only when both
 * `DEFAULT_API_BASE` and `DEFAULT_API_KEY` are set; `DEFAULT_API_MODEL_MAP` (JSON object) may
 * remap public ids (`linx`, `linx-lite`) to the ids the upstream ai-gateway expects.
 */
export function resolveDeploymentBuiltinConfig(
  edition: string,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentBuiltinConnectionConfig | undefined {
  if (edition !== 'cloud') {
    return undefined;
  }
  const apiBase = env.DEFAULT_API_BASE?.trim();
  const apiKey = env.DEFAULT_API_KEY?.trim();
  if (!apiBase || !apiKey) {
    return undefined;
  }
  return { apiBase, apiKey, modelMap: parseModelMap(env.DEFAULT_API_MODEL_MAP) };
}

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((DEPLOYMENT_BUILTIN_MODEL_IDS as readonly string[]).includes(key)
        && typeof value === 'string' && value.trim()) {
        map[key] = value.trim();
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * First-class AI Connection owned by the deployment (not by any Pod): exposes `linx` and
 * `linx-lite` to every verified Solid caller, routed through the deployment's ai-gateway with the
 * deployment key. The caller is authenticated by identity only, so no Pod access is involved.
 */
export class DeploymentBuiltinConnection {
  public readonly id = DEPLOYMENT_BUILTIN_CONNECTION_ID;
  public readonly label = 'Xpod';
  private readonly client: CloudGatewayModelsClient;
  private readonly modelMap: Readonly<Record<string, string>>;

  public constructor(config: DeploymentBuiltinConnectionConfig, options: { fetch?: typeof fetch } = {}) {
    this.modelMap = config.modelMap;
    const apiKey = config.apiKey;
    this.client = new CloudGatewayModelsClient({
      cloudGatewayOrigin: new URL(config.apiBase).origin,
      apiBaseUrl: config.apiBase,
      deploymentOwned: true,
      fetch: options.fetch,
      authorize: (auth) => (getWebId(auth) ? `Bearer ${apiKey}` : undefined),
      rewriteBody: (body, auth) => this.rewrite(body, auth),
    });
  }

  public get modelIds(): readonly string[] {
    return DEPLOYMENT_BUILTIN_MODEL_IDS;
  }

  public owns(model: string | undefined): boolean {
    return typeof model === 'string'
      && (DEPLOYMENT_BUILTIN_MODEL_IDS as readonly string[]).includes(model.trim());
  }

  /** Static projection: listing never depends on upstream reachability or the caller's Pod. */
  public listModels(): GatewayModelProjection[] {
    return DEPLOYMENT_BUILTIN_MODEL_IDS.map((id) => ({
      id,
      object: 'model' as const,
      owned_by: this.id,
      display_name: id,
      protocols: ['chatCompletions' as const, 'responses' as const],
    }));
  }

  public completeJson(input: Parameters<CloudGatewayModelsClient['completeJson']>[0]): ReturnType<CloudGatewayModelsClient['completeJson']> {
    return this.client.completeJson(input);
  }

  public executeStream(input: Parameters<CloudGatewayModelsClient['executeStream']>[0]): ReturnType<CloudGatewayModelsClient['executeStream']> {
    return this.client.executeStream(input);
  }

  private rewrite(body: unknown, auth: AuthContext): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const record = { ...(body as Record<string, unknown>) };
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    record.model = this.modelMap[model] ?? model;
    // Attribution for the ai-gateway (LiteLLM treats `user` as the end user): the verified WebID.
    const webId = getWebId(auth);
    if (webId) record.user = webId;
    return record;
  }
}
