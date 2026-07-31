import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export type AiClientId = 'codex' | 'claude-code' | 'pi' | 'codebuddy';

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
}

export interface PlanInput {
  client: AiClientId;
  endpoint: string;
  model?: string;
  webId?: string;
}

export interface ApplyInput {
  client: AiClientId;
  planId: string;
  gatewayKey: string;
  webId?: string;
  confirmation?: {
    token: string;
    targetHash: string;
  };
}

export interface VerifyInput {
  client: AiClientId;
  planId?: string;
}

type ClientFormat = 'tomlBlock' | 'jsonField';

interface ClientAdapter {
  client: AiClientId;
  label: string;
  relativePath: string;
  format: ClientFormat;
  replacementConfirmationRequired: boolean;
}

interface StoredPlan {
  planId: string;
  client: AiClientId;
  endpoint: string;
  model?: string;
  webId?: string;
  backupDir: string;
  targets: PlannedTarget[];
  gatewayKey?: string;
  confirmation?: {
    token: string;
    targetHash: string;
  };
}

interface PlannedTarget {
  adapter: ClientAdapter;
  filePath: string;
  displayPath: string;
  beforeHash: string;
  beforeExists: boolean;
  beforeContent: string;
  plannedContentWithoutSecret: string;
  action: 'update' | 'createOrUpdate';
}

interface SnapshotFile {
  version: 1;
  client: AiClientId;
  webId?: string;
  createdAt: string;
  targets: Array<{
    filePath: string;
    format: ClientFormat;
    beforeExists: boolean;
    beforeContent: string;
    afterHash: string;
    managedContent: string;
  }>;
}

const MANAGED_BY = 'xpod-ai-connection';
const TOML_START = '# >>> xpod-ai-connection';
const TOML_END = '# <<< xpod-ai-connection';
const PLAN_SECRET_PLACEHOLDER = '[redacted]';

const CLIENT_ADAPTERS: Record<AiClientId, ClientAdapter> = {
  codex: {
    client: 'codex',
    label: 'Codex',
    relativePath: '.codex/config.toml',
    format: 'tomlBlock',
    replacementConfirmationRequired: false,
  },
  'claude-code': {
    client: 'claude-code',
    label: 'Claude Code',
    relativePath: '.claude/settings.json',
    format: 'jsonField',
    replacementConfirmationRequired: false,
  },
  pi: {
    client: 'pi',
    label: 'Pi',
    relativePath: '.config/pi/settings.json',
    format: 'jsonField',
    replacementConfirmationRequired: true,
  },
  codebuddy: {
    client: 'codebuddy',
    label: 'CodeBuddy',
    relativePath: '.codebuddy/config.json',
    format: 'jsonField',
    replacementConfirmationRequired: false,
  },
};

export class AiClientConfigurationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AiClientConfigurationService {
  private readonly homeDir: string;
  private readonly backupRoot: string;
  private readonly now: () => Date;
  private readonly verifyGateway: NonNullable<AiClientConfigurationServiceOptions['verifyGateway']>;
  private readonly plans = new Map<string, StoredPlan>();
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(options: AiClientConfigurationServiceOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? osHomeFallback());
    this.backupRoot = path.resolve(options.backupRoot ?? path.join(this.homeDir, '.xpod/client-config-backups'));
    this.now = options.now ?? (() => new Date());
    this.verifyGateway = options.verifyGateway ?? createDefaultGatewayVerifier(
      options.fetch ?? fetch,
      options.verificationTimeoutMs ?? 8_000,
    );
  }

  public async inspect(client: AiClientId): Promise<AiClientConfigurationStatus> {
    const adapter = adapterFor(client);
    const filePath = this.resolveTarget(adapter);
    const state = await this.readTarget(adapter, filePath);
    if (!state.exists) {
      return { status: 'notConfigured', installed: false, configExists: false };
    }
    const configured = containsManagedConfiguration(adapter, state.content);
    return {
      status: configured ? 'configured' : 'notConfigured',
      installed: true,
      configExists: true,
      message: configured ? `${adapter.label} is configured for Xpod.` : `${adapter.label} is installed but not configured for Xpod.`,
    };
  }

  public async plan(input: PlanInput): Promise<AiClientConfigurationPlan> {
    const adapter = adapterFor(input.client);
    const endpoint = normalizeEndpoint(input.endpoint);
    const filePath = this.resolveTarget(adapter);
    const state = await this.readTarget(adapter, filePath);
    const backupDir = path.join(this.backupRoot, input.client, timestampForPath(this.now()));
    const plannedContentWithoutSecret = renderManagedConfiguration(adapter, {
      endpoint,
      gatewayKey: PLAN_SECRET_PLACEHOLDER,
      model: input.model,
      webId: input.webId,
    }, state.content);
    const target: PlannedTarget = {
      adapter,
      filePath,
      displayPath: displayPath(this.homeDir, filePath),
      beforeHash: hash(state.content),
      beforeExists: state.exists,
      beforeContent: state.content,
      plannedContentWithoutSecret,
      action: state.exists ? 'update' : 'createOrUpdate',
    };
    const plan: StoredPlan = {
      planId: `aicfg_${randomUUID().replace(/-/gu, '')}`,
      client: input.client,
      endpoint,
      model: input.model,
      webId: input.webId,
      backupDir,
      targets: [target],
      ...(adapter.replacementConfirmationRequired ? {
        confirmation: {
          token: `confirm-${input.client}-${target.beforeHash.slice(0, 12)}`,
          targetHash: target.beforeHash,
        },
      } : {}),
    };
    this.plans.set(plan.planId, plan);
    return publicPlan(plan, this.homeDir);
  }

  public async apply(input: ApplyInput): Promise<{ applied: true }> {
    const plan = this.requirePlan(input.client, input.planId);
    if (!input.gatewayKey?.startsWith('xpod_')) {
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
    return this.withTargetLocks(plan.targets.map((target) => target.filePath), async () => {
      for (const target of plan.targets) {
        const current = await this.readTarget(target.adapter, target.filePath);
        if (hash(current.content) !== target.beforeHash) {
          throw new AiClientConfigurationError('configuration_conflict', 'Configuration changed after planning.', 409);
        }
      }
      await fs.mkdir(plan.backupDir, { recursive: true, mode: 0o700 });
      const snapshots: SnapshotFile['targets'] = [];
      for (const target of plan.targets) {
        const current = await this.readTarget(target.adapter, target.filePath);
        const managedContent = renderManagedConfiguration(target.adapter, {
          endpoint: plan.endpoint,
          gatewayKey: input.gatewayKey,
          model: plan.model,
          webId: input.webId ?? plan.webId,
        }, current.content);
        const backupPath = path.join(plan.backupDir, `${path.basename(target.filePath)}.bak`);
        await fs.writeFile(backupPath, current.content, { mode: 0o600 });
        await atomicWriteFile(target.filePath, managedContent, 0o600);
        snapshots.push({
          filePath: target.filePath,
          format: target.adapter.format,
          beforeExists: current.exists,
          beforeContent: current.content,
          afterHash: hash(managedContent),
          managedContent,
        });
      }
      await writeSnapshot(plan.backupDir, {
        version: 1,
        client: plan.client,
        webId: input.webId ?? plan.webId,
        createdAt: this.now().toISOString(),
        targets: snapshots,
      });
      plan.gatewayKey = input.gatewayKey;
      const snapshot: SnapshotFile = {
        version: 1,
        client: plan.client,
        webId: input.webId ?? plan.webId,
        createdAt: this.now().toISOString(),
        targets: snapshots,
      };
      try {
        await this.verify({ client: plan.client, planId: plan.planId });
      } catch (error) {
        await this.restoreSnapshot(plan.client, snapshot);
        throw new AiClientConfigurationError(
          'verification_failed_restored',
          redactSecretText(error instanceof Error ? error.message : 'Gateway verification failed.'),
          502,
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
    const controller = new AbortController();
    await this.verifyGateway({
      endpoint: plan.endpoint,
      gatewayKey: plan.gatewayKey,
      model: plan.model,
      signal: controller.signal,
    });
    return { ...status, status: 'configured', message: `${adapterFor(input.client).label} verified against Xpod Gateway.` };
  }

  public async restore(client: AiClientId): Promise<AiClientConfigurationStatus> {
    const adapter = adapterFor(client);
    const snapshot = await this.readLatestSnapshot(client);
    if (!snapshot) {
      const targetPath = this.resolveTarget(adapter);
      const state = await this.readTarget(adapter, targetPath);
      if (state.exists && containsManagedConfiguration(adapter, state.content)) {
        await atomicWriteFile(targetPath, removeManagedConfiguration(adapter, state.content), 0o600);
      }
      return this.inspect(client);
    }
    return this.withTargetLocks(snapshot.targets.map((target) => target.filePath), () => this.restoreSnapshot(client, snapshot));
  }

  private async restoreSnapshot(client: AiClientId, snapshot: SnapshotFile): Promise<AiClientConfigurationStatus> {
    const adapter = adapterFor(client);
    for (const target of snapshot.targets) {
      const targetAdapter = { ...adapter, format: target.format };
      const state = await this.readTarget(targetAdapter, target.filePath);
      if (!state.exists) {
        continue;
      }
      if (hash(state.content) === target.afterHash) {
        if (target.beforeExists) {
          await atomicWriteFile(target.filePath, target.beforeContent, 0o600);
        } else {
          await fs.rm(target.filePath, { force: true });
        }
        continue;
      }
      const restored = removeManagedConfiguration(targetAdapter, state.content);
      await atomicWriteFile(target.filePath, restored, 0o600);
    }
    return this.inspect(client);
  }

  private requirePlan(client: AiClientId, planId: string): StoredPlan {
    const plan = this.plans.get(planId);
    if (!plan || plan.client !== client) {
      throw new AiClientConfigurationError('plan_not_found', 'Configuration plan was not found.', 404);
    }
    return plan;
  }

  private resolveTarget(adapter: ClientAdapter): string {
    const target = path.resolve(this.homeDir, adapter.relativePath);
    if (!isPathInside(this.homeDir, target)) {
      throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target is outside the owner home directory.', 400);
    }
    return target;
  }

  private async readTarget(adapter: ClientAdapter, filePath: string): Promise<{ exists: boolean; content: string }> {
    await assertSafeTarget(this.homeDir, filePath);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (adapter.format === 'jsonField') {
        parseJsonObject(content);
      }
      return { exists: true, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, content: defaultContent(adapter) };
      }
      if (error instanceof SyntaxError) {
        throw new AiClientConfigurationError('invalid_config', 'Configuration file must contain a JSON object.', 400);
      }
      throw error;
    }
  }

  private async readLatestSnapshot(client: AiClientId): Promise<SnapshotFile | undefined> {
    const dir = path.join(this.backupRoot, client);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    const sorted = entries.sort().reverse();
    for (const entry of sorted) {
      const snapshotPath = path.join(dir, entry, 'snapshot.json');
      try {
        return JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as SnapshotFile;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async withTargetLocks<T>(targets: string[], action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(targets)].sort();
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

function adapterFor(client: AiClientId): ClientAdapter {
  const adapter = CLIENT_ADAPTERS[client];
  if (!adapter) {
    throw new AiClientConfigurationError('unsupported_client', 'Unsupported AI client.', 404);
  }
  return adapter;
}

function publicPlan(plan: StoredPlan, homeDir: string): AiClientConfigurationPlan {
  return {
    planId: plan.planId,
    client: plan.client,
    changes: plan.targets.map((target) => ({
      target: target.displayPath,
      action: target.action,
      backup: true,
      current: redactManagedSecrets(target.beforeContent),
      replacement: redactManagedSecrets(target.plannedContentWithoutSecret),
    })),
    conflicts: [],
    backupLocation: displayPath(homeDir, plan.backupDir),
    replacementConfirmationRequired: adapterFor(plan.client).replacementConfirmationRequired,
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

function renderManagedConfiguration(
  adapter: ClientAdapter,
  input: { endpoint: string; gatewayKey: string; model?: string; webId?: string },
  existing: string,
): string {
  if (adapter.format === 'tomlBlock') {
    const block = [
      TOML_START,
      '[model_providers.xpod]',
      'name = "Xpod"',
      `base_url = "${escapeTomlString(input.endpoint.replace(/\/+$/u, ''))}/v1"`,
      `api_key = "${escapeTomlString(input.gatewayKey)}"`,
      'wire_api = "responses"',
      '',
      '[profiles.xpod]',
      'model_provider = "xpod"',
      `model = "${escapeTomlString(input.model ?? 'xpod/default')}"`,
      `metadata = "${MANAGED_BY}"`,
      TOML_END,
      '',
    ].join('\n');
    const cleaned = removeManagedTomlBlock(existing).replace(/\s*$/u, '\n');
    return `${cleaned}${block}`;
  }
  const parsed = parseJsonObject(existing);
  parsed.xpod = {
    _managedBy: MANAGED_BY,
    endpoint: input.endpoint.replace(/\/+$/u, ''),
    baseUrl: `${input.endpoint.replace(/\/+$/u, '')}/v1`,
    gatewayKey: input.gatewayKey,
    model: input.model ?? 'xpod/default',
    webId: input.webId,
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function removeManagedConfiguration(adapter: Pick<ClientAdapter, 'format'>, content: string): string {
  if (adapter.format === 'tomlBlock') {
    return removeManagedTomlBlock(content);
  }
  const parsed = parseJsonObject(content);
  if (isObject(parsed.xpod) && parsed.xpod._managedBy === MANAGED_BY) {
    delete parsed.xpod;
  }
  stripStaleXpodEnv(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function stripStaleXpodEnv(parsed: Record<string, unknown>): void {
  if (!isObject(parsed.env)) return;
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEBUDDY_BASE_URL', 'CODEBUDDY_API_KEY']) {
    const value = parsed.env[key];
    if (typeof value === 'string' && (value.includes('xpod') || value.includes('/api/ai'))) {
      delete parsed.env[key];
    }
  }
}

function containsManagedConfiguration(adapter: ClientAdapter, content: string): boolean {
  if (adapter.format === 'tomlBlock') {
    return content.includes(TOML_START) && content.includes(TOML_END);
  }
  const parsed = parseJsonObject(content);
  return isObject(parsed.xpod) && parsed.xpod._managedBy === MANAGED_BY;
}

function removeManagedTomlBlock(content: string): string {
  const pattern = new RegExp(`\\n?${escapeRegExp(TOML_START)}[\\s\\S]*?${escapeRegExp(TOML_END)}\\n?`, 'u');
  return content.replace(pattern, '\n').replace(/\n{3,}/gu, '\n\n');
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = content.trim() ? JSON.parse(content) as unknown : {};
  if (!isObject(parsed)) {
    throw new SyntaxError('Expected JSON object');
  }
  return parsed;
}

function defaultContent(adapter: ClientAdapter): string {
  return adapter.format === 'jsonField' ? '{}\n' : '';
}

async function assertSafeTarget(homeDir: string, filePath: string): Promise<void> {
  if (!isPathInside(homeDir, filePath)) {
    throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target is outside the owner home directory.', 400);
  }
  await assertNoSymlinkInPath(homeDir, filePath);
  try {
    const stat = await fs.stat(filePath);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target is owned by another user.', 400);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function assertNoSymlinkInPath(homeDir: string, filePath: string): Promise<void> {
  const relative = path.relative(homeDir, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = homeDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new AiClientConfigurationError('unsafe_config_target', 'Configuration target must not be a symlink.', 400);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, mode);
}

async function writeSnapshot(backupDir: string, snapshot: SnapshotFile): Promise<void> {
  await atomicWriteFile(path.join(backupDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 0o600);
}

function createDefaultGatewayVerifier(fetchImpl: typeof fetch, timeoutMs: number): NonNullable<AiClientConfigurationServiceOptions['verifyGateway']> {
  return async ({ endpoint, gatewayKey, model, signal }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const linked = mergeSignals(signal, timeout);
    const base = endpoint.replace(/\/+$/u, '');
    await checkedGatewayFetch(fetchImpl, `${base}/v1/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${gatewayKey}` },
      signal: linked,
    });
    await checkedGatewayFetch(fetchImpl, `${base}/v1/responses`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayKey}`,
      },
      body: JSON.stringify({
        model: model ?? 'xpod/default',
        input: 'ping',
        max_output_tokens: 1,
      }),
      signal: linked,
    });
  };
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
    .replace(/xpod_[A-Za-z0-9._-]+/gu, '[redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gu, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, 'Bearer [redacted]');
}

function redactManagedSecrets(input: string): string {
  return redactSecretText(input).replace(PLAN_SECRET_PLACEHOLDER, '[redacted]');
}

function escapeTomlString(input: string): string {
  return input.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function osHomeFallback(): string {
  return process.cwd();
}
