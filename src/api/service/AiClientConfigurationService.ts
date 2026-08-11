import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  AiClientConfigError,
  CodexConfigAdapter,
  ClaudeCodeConfigAdapter,
  CodeBuddyConfigAdapter,
  PiConfigAdapter,
  type AiClientConfigAdapter,
  AiClientConfigPlan,
  AiConnectionsClientProfile,
  ConfigWrite,
  resolveActiveModel,
} from '@undefineds.co/ai-connections/client-config';
import type { AuthContext } from '../auth/AuthContext';

export type AiClientId = 'codex' | 'claude-code' | 'pi' | 'codebuddy';

export interface AiClientConfigurationCapabilityDescriptor {
  available: boolean;
  authority?: 'local-filesystem';
  manualInstructions: string;
}

export interface AiClientConfigurationStatus {
  status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored';
  message?: string;
  installed?: boolean;
  configExists?: boolean;
}

export interface AiClientConfigurationPlan {
  planId: string;
  client: AiClientId;
  changes: AiClientConfigurationChange[];
  conflicts: string[];
  backupLocation: string;
  replacementConfirmationRequired: boolean;
  confirmation?: {
    required: boolean;
    token: string;
    targetHash: string;
    message?: string;
  };
}

export interface AiClientConfigurationChange {
  target: string;
  action: 'update' | 'createOrUpdate' | 'delete';
  backup: boolean;
  current?: string;
  replacement?: string;
}

export interface AiClientConfigurationServiceOptions {
  homeDir?: string;
  backupRoot?: string;
  now?: () => Date;
  verifyGateway?: (input: {
    endpoint: string;
    gatewayKey: string;
    model?: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  fetch?: typeof fetch;
  verificationTimeoutMs?: number;
  /** Current authenticated Gateway projection; never use an unauthenticated HTTP self-fetch. */
  listActiveModels?: (input: {
    webId: string;
    auth: AuthContext;
  }) => Promise<readonly AiClientVisibleModel[]>;
}

export interface AiClientVisibleModel {
  id: string;
  provider?: string;
  owned_by?: string;
  displayName?: string;
  availability?: 'available' | 'unavailable' | 'statusUnknown';
}

export interface PlanInput {
  client: AiClientId;
  endpoint: string;
  model?: string;
  webId?: string;
  auth?: AuthContext;
}

export interface ApplyInput {
  client: AiClientId;
  planId: string;
  gatewayKey: string;
  webId?: string;
  auth?: AuthContext;
  confirmation?: {
    token: string;
    targetHash: string;
  };
}

export interface VerifyInput {
  client: AiClientId;
  planId?: string;
}

interface StoredPlan {
  planId: string;
  client: AiClientId;
  profile: AiConnectionsClientProfile;
  nativePlan: AiClientConfigPlan;
  targets: PlannedTarget[];
  backupDir: string;
  gatewayKey?: string;
  confirmation?: {
    token: string;
    targetHash: string;
  };
}

interface PlannedTarget {
  filePath: string;
  displayPath: string;
  beforeHash: string;
  beforeExists: boolean;
  beforeContent: string;
  plannedContentWithoutSecret: string;
  action: 'update' | 'createOrUpdate' | 'delete';
}

const PLAN_SECRET_PLACEHOLDER = '[redacted]';
const MANUAL_INSTRUCTIONS = 'Manual client setup is available when this host cannot safely write local coding-client files.';

const CLIENT_LABELS: Record<AiClientId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  pi: 'Pi',
  codebuddy: 'CodeBuddy',
};

export class AiClientConfigurationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(code: string, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AiClientConfigurationService {
  private readonly homeDir: string;
  private readonly backupRoot: string;
  private readonly now: () => Date;
  private readonly verifyGateway: NonNullable<AiClientConfigurationServiceOptions['verifyGateway']>;
  private readonly listActiveModels?: AiClientConfigurationServiceOptions['listActiveModels'];
  private readonly plans = new Map<string, StoredPlan>();
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(options: AiClientConfigurationServiceOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? process.cwd());
    this.backupRoot = path.resolve(options.backupRoot ?? path.join(this.homeDir, '.xpod/client-config-backups'));
    this.now = options.now ?? (() => new Date());
    this.verifyGateway = options.verifyGateway ?? createDefaultGatewayVerifier(
      options.fetch ?? fetch,
      options.verificationTimeoutMs ?? 8_000,
    );
    this.listActiveModels = options.listActiveModels;
  }

  public capability(): AiClientConfigurationCapabilityDescriptor {
    return {
      available: true,
      authority: 'local-filesystem',
      manualInstructions: MANUAL_INSTRUCTIONS,
    };
  }

  public async inspect(client: AiClientId): Promise<AiClientConfigurationStatus> {
    const adapter = this.adapterFor(client);
    const detection = await mapAdapterError(() => adapter.detect());
    const inspection = await mapAdapterError(() => adapter.inspect());
    const configured = inspection.ownership === 'owned';
    return {
      status: configured ? 'configured' : 'notConfigured',
      installed: detection.installed,
      configExists: detection.configExists,
      message: configured
        ? `${CLIENT_LABELS[client]} is configured for Xpod.`
        : `${CLIENT_LABELS[client]} is not configured for Xpod.`,
    };
  }

  public async plan(input: PlanInput): Promise<AiClientConfigurationPlan> {
    const client = requireSupportedClient(input.client);
    const webId = input.webId ?? solidWebId(input.auth)
      ?? 'https://xpod.local/.well-known/ai-client-configuration#owner';
    const activeModels = await this.readActiveModels(webId, input.auth);
    const profile = {
      endpoint: normalizeEndpoint(input.endpoint),
      gatewayKey: PLAN_SECRET_PLACEHOLDER,
      webId,
      model: input.model,
      activeModels: activeModels.models,
      catalogVersion: activeModels.version,
    };
    await mapAdapterError(async () => {
      profile.model = resolveActiveModel(profile);
    });
    const adapter = this.adapterFor(client);
    const nativePlan = await mapAdapterError(() => adapter.plan(profile));
    const targets = await this.publicTargets(nativePlan.writes);
    const beforeHash = hash(targets.map((target) => `${target.filePath}:${target.beforeHash}`).join('\n'));
    const plan: StoredPlan = {
      planId: `aicfg_${randomUUID().replace(/-/gu, '')}`,
      client,
      profile,
      nativePlan,
      targets,
      backupDir: path.join(this.backupRoot, client, timestampForPath(this.now())),
      ...(isReplacementSensitive(client) ? {
        confirmation: {
          token: `confirm-${client}-${beforeHash.slice(0, 12)}`,
          targetHash: beforeHash,
        },
      } : {}),
    };
    this.plans.set(plan.planId, plan);
    return publicPlan(plan, this.homeDir);
  }

  public async apply(input: ApplyInput): Promise<{ applied: true }> {
    const plan = this.requirePlan(input.client, input.planId);
    if (!isSupportedGatewayKey(input.gatewayKey)) {
      throw new AiClientConfigurationError('invalid_gateway_key', 'Gateway key is required.', 400);
    }
    if (plan.confirmation) {
      if (!input.confirmation?.token) {
        throw new AiClientConfigurationError('confirmation_required', 'Replacement confirmation is required.', 409);
      }
      if (input.confirmation.token !== plan.confirmation.token ||
        input.confirmation.targetHash !== plan.confirmation.targetHash) {
        throw new AiClientConfigurationError('confirmation_stale', 'Replacement confirmation is stale.', 409);
      }
    }

    return this.withTargetLocks(plan.nativePlan.writes.map((write) => write.path), async () => {
      for (const target of plan.targets) {
        const current = await readOptional(target.filePath);
        if (hash(current ?? '') !== target.beforeHash) {
          throw new AiClientConfigurationError('configuration_conflict', 'Configuration changed after planning.', 409);
        }
      }

      const currentCatalog = await this.readActiveModels(
        input.webId ?? plan.profile.webId,
        input.auth,
      );
      if (currentCatalog.models.length === 0) {
        throw new AiClientConfigurationError(
          'model_not_available',
          'The planned model is no longer active in the Xpod Gateway.',
          409,
        );
      }
      const profile = {
        ...plan.profile,
        gatewayKey: input.gatewayKey,
        webId: input.webId ?? plan.profile.webId,
        activeModels: currentCatalog.models,
        catalogVersion: currentCatalog.version,
      };
      await mapAdapterError(async () => {
        profile.model = resolveActiveModel(profile);
      });
      const adapter = this.adapterFor(plan.client);
      const nativePlan = await mapAdapterError(() => adapter.plan(profile));
      await mapAdapterError(() => adapter.apply(nativePlan));
      plan.gatewayKey = input.gatewayKey;
      plan.profile = profile;
      plan.nativePlan = nativePlan;

      try {
        await this.verify({ client: plan.client, planId: plan.planId });
      } catch {
        await mapAdapterError(() => adapter.restore(profile.webId));
        throw new AiClientConfigurationError(
          'verification_failed_restored',
          'Gateway verification failed.',
          502,
          { restored: true },
        );
      }
      return { applied: true };
    });
  }

  public async verify(input: VerifyInput): Promise<AiClientConfigurationStatus> {
    const plan = input.planId ? this.requirePlan(input.client, input.planId) : undefined;
    const status = await this.inspect(input.client);
    if (status.status !== 'configured') {
      return status;
    }
    if (!plan?.gatewayKey) {
      return {
        ...status,
        status: 'unverifiable',
        message: 'Gateway key is not recoverable after restart; re-apply the client configuration to verify it.',
      };
    }
    const adapter = this.adapterFor(input.client);
    const projection = await mapAdapterError(() => adapter.verify(plan.profile));
    if (!projection.ok) {
      throw new AiClientConfigurationError('client_projection_drifted', projection.reason ?? 'Client configuration drifted.', 409);
    }
    const controller = new AbortController();
    await this.verifyGateway({
      endpoint: plan.profile.endpoint,
      gatewayKey: plan.gatewayKey,
      model: plan.profile.model,
      signal: controller.signal,
    });
    return { ...status, status: 'configured', message: `${CLIENT_LABELS[input.client]} verified against Xpod Gateway.` };
  }

  public async restore(client: AiClientId, webId?: string): Promise<AiClientConfigurationStatus> {
    const adapter = this.adapterFor(client);
    const owner = webId ?? this.latestPlanFor(client)?.profile.webId;
    if (owner) {
      await this.withTargetLocks(await this.detectLockTargets(adapter), () => mapAdapterError(() => adapter.restore(owner)));
    }
    return this.inspect(client);
  }

  private async readActiveModels(
    webId: string,
    auth: AuthContext | undefined,
  ): Promise<{ version: string; models: AiClientVisibleModel[] }> {
    if (!this.listActiveModels) {
      throw new AiClientConfigurationError(
        'model_catalog_unavailable',
        'Authenticated Gateway model visibility is not configured for client setup.',
        503,
      );
    }
    if (!auth) {
      throw new AiClientConfigurationError('authentication_required', 'Authentication required.', 401);
    }
    try {
      const discovered = await this.listActiveModels({ webId, auth });
      const models = discovered
        .filter((model) => typeof model.id === 'string' && model.id.trim())
        .filter((model) => model.availability === undefined || model.availability === 'available')
        .map((model) => ({
          id: model.id.trim(),
          ...(typeof model.provider === 'string' && model.provider.trim()
            ? { provider: model.provider.trim() }
            : typeof model.owned_by === 'string' && model.owned_by.trim()
              ? { provider: model.owned_by.trim() }
              : {}),
          ...(typeof model.displayName === 'string' && model.displayName.trim()
            ? { displayName: model.displayName.trim() }
            : {}),
          availability: 'available' as const,
        }));
      const version = hash(JSON.stringify(models.map((model) => ({
        id: model.id,
        provider: model.provider,
      })).sort((left, right) => `${left.provider ?? ''}/${left.id}`.localeCompare(`${right.provider ?? ''}/${right.id}`))));
      return { version, models };
    } catch (error) {
      if (error instanceof AiClientConfigurationError) throw error;
      throw new AiClientConfigurationError(
        'model_catalog_unavailable',
        'Authenticated Gateway model visibility could not be read.',
        503,
      );
    }
  }

  private adapterFor(client: AiClientId): AiClientConfigAdapter {
    requireSupportedClient(client);
    if (client === 'codex') return new CodexConfigAdapter({ homeDir: this.homeDir });
    if (client === 'claude-code') return new ClaudeCodeConfigAdapter({ homeDir: this.homeDir });
    if (client === 'pi') return new PiConfigAdapter({ homeDir: this.homeDir });
    return new CodeBuddyConfigAdapter({ homeDir: this.homeDir });
  }

  private async publicTargets(writes: ConfigWrite[]): Promise<PlannedTarget[]> {
    const targets: PlannedTarget[] = [];
    for (const write of writes.filter((candidate) => !isStateWrite(candidate))) {
      if (!isPathInside(this.homeDir, path.resolve(write.path))) {
        throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target is outside the owner home directory.', 400);
      }
      const before = await readOptional(write.path);
      targets.push({
        filePath: write.path,
        displayPath: displayPath(this.homeDir, write.path),
        beforeHash: hash(before ?? ''),
        beforeExists: before !== undefined,
        beforeContent: before ?? '',
        plannedContentWithoutSecret: write.content ?? '',
        action: write.content === null ? 'delete' : before === undefined ? 'createOrUpdate' : 'update',
      });
    }
    return targets;
  }

  private async detectLockTargets(adapter: AiClientConfigAdapter): Promise<string[]> {
    const detection = await mapAdapterError(() => adapter.detect());
    return detection.configPaths;
  }

  private requirePlan(client: AiClientId, planId: string): StoredPlan {
    const plan = this.plans.get(planId);
    if (!plan || plan.client !== client) {
      throw new AiClientConfigurationError('plan_not_found', 'Configuration plan was not found.', 404);
    }
    return plan;
  }

  private latestPlanFor(client: AiClientId): StoredPlan | undefined {
    return [...this.plans.values()].reverse().find((plan) => plan.client === client);
  }

  private async withTargetLocks<T>(targets: string[], action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(targets.map((target) => path.resolve(target)))].sort();
    const previous = Promise.all(sorted.map((target) => this.locks.get(target))).then(() => undefined);
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    for (const target of sorted) {
      this.locks.set(target, current);
    }
    await previous;
    try {
      return await action();
    } finally {
      release();
      for (const target of sorted) {
        if (this.locks.get(target) === current) {
          this.locks.delete(target);
        }
      }
    }
  }
}

function publicPlan(plan: StoredPlan, homeDir: string): AiClientConfigurationPlan {
  return {
    planId: plan.planId,
    client: plan.client,
    changes: plan.targets.map((target) => ({
      target: target.displayPath,
      action: target.action,
      backup: target.beforeExists,
      current: redactSecretText(target.beforeContent),
      replacement: redactSecretText(target.plannedContentWithoutSecret),
    })),
    conflicts: [],
    backupLocation: displayPath(homeDir, plan.backupDir),
    replacementConfirmationRequired: isReplacementSensitive(plan.client),
    ...(plan.confirmation ? {
      confirmation: {
        required: true,
        token: plan.confirmation.token,
        targetHash: plan.confirmation.targetHash,
        message: 'This client may replace the active default model. Re-enter the confirmation token before applying.',
      },
    } : {}),
  };
}

async function mapAdapterError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AiClientConfigurationError) throw error;
    if (error instanceof AiClientConfigError) {
      const status = error.code === 'model_not_available' || error.code === 'model_catalog_empty' ? 409 : 400;
      throw new AiClientConfigurationError(error.code, error.code, status);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('symbolic link') || message.includes('outside the owner home') || message.includes('not a regular file')) {
      throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target is unsafe.', 400);
    }
    if (message.includes('invalid JSON') || message.includes('root must be a JSON object')) {
      throw new AiClientConfigurationError('invalid_config', 'Configuration file must contain a JSON object.', 400);
    }
    throw error;
  }
}

function solidWebId(auth: AuthContext | undefined): string | undefined {
  return auth?.type === 'solid' ? auth.webId : undefined;
}

function requireSupportedClient(client: AiClientId): AiClientId {
  if (client === 'codex' || client === 'claude-code' || client === 'pi' || client === 'codebuddy') {
    return client;
  }
  throw new AiClientConfigurationError('unsupported_client', 'Unsupported AI client.', 404);
}

function isSupportedGatewayKey(value: string | undefined): value is string {
  if (!value) return false;
  if (value.startsWith('xpod_')) return true;
  if (!value.startsWith('sk-')) return false;

  const encoded = value.slice(3);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  const padding = encoded.match(/=+$/u)?.[0].length ?? 0;
  const unpaddedLength = encoded.length - padding;
  if (unpaddedLength % 4 === 1 || (padding > 0 && (encoded.length % 4) !== 0)) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }

  const canonical = Buffer.from(decoded, 'utf8').toString('base64');
  if (canonical.replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) return false;

  const separator = decoded.indexOf(':');
  return separator > 0 && separator < decoded.length - 1;
}

function isReplacementSensitive(client: AiClientId): boolean {
  return client === 'pi';
}

function isStateWrite(write: ConfigWrite): boolean {
  return path.basename(write.path).startsWith('.xpod-ai-connections-');
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function createDefaultGatewayVerifier(fetchImpl: typeof fetch, timeoutMs: number): NonNullable<AiClientConfigurationServiceOptions['verifyGateway']> {
  return async ({ endpoint, gatewayKey, model, signal }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const linked = mergeSignals(signal, timeout);
    const base = endpoint.replace(/\/+$/u, '');
    const modelsPayload = await checkedGatewayJson(fetchImpl, `${base}/v1/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${gatewayKey}` },
      signal: linked,
    });
    const verificationModel = model ?? firstGatewayModelId(modelsPayload);
    if (!verificationModel) {
      throw new Error('Gateway verification failed: no available models');
    }
    await checkedGatewayFetch(fetchImpl, `${base}/v1/responses`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: verificationModel,
        input: 'ping',
        max_output_tokens: 1,
      }),
      signal: linked,
    });
  };
}

async function checkedGatewayJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Gateway verification failed: ${response.status}`);
  }
  return response.json();
}

function firstGatewayModelId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
  }
  return undefined;
}

async function checkedGatewayFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<void> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Gateway verification failed: ${response.status}`);
  }
  await response.arrayBuffer();
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const abort = () => controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('bad protocol');
    }
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    throw new AiClientConfigurationError('invalid_endpoint', 'Endpoint must be an HTTP(S) URL.', 400);
  }
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function displayPath(homeDir: string, filePath: string): string {
  const relative = path.relative(homeDir, filePath);
  return relative.startsWith('..') ? filePath : `~/${relative}`;
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function redactSecretText(input: string): string {
  return input
    .replace(/\/(?:Users|var|tmp|private|home)\/[^\s"',)]+/gu, '[path]')
    .replace(/xpod_[A-Za-z0-9._-]+/gu, '[redacted]')
    .replace(/sk-[A-Za-z0-9._+/=-]+/gu, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._+/=-]+/giu, 'Bearer [redacted]');
}

export function unavailableAiClientConfigurationCapability(): AiClientConfigurationCapabilityDescriptor {
  return {
    available: false,
    manualInstructions: MANUAL_INSTRUCTIONS,
  };
}
