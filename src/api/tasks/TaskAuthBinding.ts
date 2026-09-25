import { randomUUID } from 'node:crypto';
import type { StoreContext } from '../chatkit/store';
import type { TaskCredentialSource } from '../ai-gateway/pod/OwnerPodAccess';
import { TASK_CREDENTIAL_REF_PREFIX } from './TaskCredentialStore';
import type { SolidAuthContext } from '../auth/AuthContext';
import { isSolidAuth } from '../auth/AuthContext';

export const TaskAuthBindingKind = {
  SOLID_CLIENT_CREDENTIALS: 'solid-client-credentials',
} as const;

export const TaskAuthBindingStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;

export const TASK_AUTH_CREDENTIAL_SERVICE = 'task-auth';

export type TaskAuthBindingKindType = (typeof TaskAuthBindingKind)[keyof typeof TaskAuthBindingKind];
export type TaskAuthBindingStatusType = (typeof TaskAuthBindingStatus)[keyof typeof TaskAuthBindingStatus];

export interface TaskAuthBindingSnapshot {
  /** Credential resource id understood by the shared Credential model. */
  id: string;
  kind: TaskAuthBindingKindType;
  webId: string;
  clientId: string;
  displayName?: string;
  status: TaskAuthBindingStatusType;
  createdAt: number;
  expiresAt?: number;
}

export interface CreateTaskAuthBindingInput {
  id?: string;
  webId?: string;
  clientId?: string;
  clientSecret?: string;
  displayName?: string;
  expiresAt?: number;
}

export interface TaskAuthCredentialRecord {
  id: string;
  service: string;
  status: string;
  apiKey?: string | null;
  label?: string | null;
  oauthExpiresAt?: string | Date | null;
  createdAt?: string | Date | null;
}

export interface TaskAuthBindingRepository<TContext extends StoreContext = StoreContext> {
  saveTaskAuthCredential(input: {
    id: string;
    apiKey: string;
    displayName?: string;
    expiresAt?: number;
  }, context: TContext): Promise<TaskAuthCredentialRecord>;
  loadTaskAuthCredential(id: string, context: TContext): Promise<TaskAuthCredentialRecord | undefined>;
}

export interface TaskAuthBindingServiceOptions<TContext extends StoreContext = StoreContext> {
  repository: TaskAuthBindingRepository<TContext>;
  buildContext?: (binding: TaskAuthBindingSnapshot, clientSecret: string, context: TContext) => TContext;
  /**
   * The task layer's own credentials. A binding that names one of these grants resolves without
   * reading a secret out of the Pod at all, which is what unattended work should use.
   */
  taskCredentials?: Pick<TaskCredentialSource, 'forRef'>;
}

export class TaskAuthBindingService<TContext extends StoreContext = StoreContext> {
  private readonly repository: TaskAuthBindingRepository<TContext>;
  private readonly buildContext: (binding: TaskAuthBindingSnapshot, clientSecret: string, context: TContext) => TContext;
  private readonly taskCredentials?: Pick<TaskCredentialSource, 'forRef'>;

  public constructor(options: TaskAuthBindingServiceOptions<TContext>) {
    this.repository = options.repository;
    this.buildContext = options.buildContext ?? this.defaultBuildContext;
    this.taskCredentials = options.taskCredentials;
  }

  public async createBinding(input: CreateTaskAuthBindingInput, context: TContext): Promise<TaskAuthBindingSnapshot> {
    const auth = this.solidAuthFromContext(context);
    const webId = input.webId ?? auth?.webId;
    const clientId = input.clientId ?? auth?.clientId;
    const clientSecret = input.clientSecret ?? auth?.clientSecret;

    if (!webId) {
      throw new Error('Task auth credential requires a Solid webId');
    }
    if (auth?.webId && webId !== auth.webId) {
      throw new Error('Task auth credential webId must match the authenticated caller');
    }
    if (!clientId || !clientSecret) {
      throw new Error('Task auth credential creation requires Solid client credentials');
    }

    const credential = await this.repository.saveTaskAuthCredential({
      id: normalizeCredentialId(input.id) ?? `task-auth_${randomUUID()}`,
      apiKey: encodeClientCredentialsApiKey(clientId, clientSecret),
      displayName: input.displayName,
      expiresAt: input.expiresAt,
    }, context);

    return this.snapshotFromCredential(credential, context);
  }

  public async loadBinding(id: string, context: TContext): Promise<TaskAuthBindingSnapshot> {
    const credential = await this.repository.loadTaskAuthCredential(id, context);
    if (!credential) {
      throw new Error(`Task auth credential not found: ${id}`);
    }
    return this.snapshotFromCredential(credential, context);
  }

  /**
   * Restore Pod access for an unattended run.
   *
   * A binding id that names a task-layer grant is resolved from there, so the Pod never has to
   * hold the secret; anything else falls back to the stored credential for the migration period.
   * Either way the run keeps the owner the binding names, not whoever happened to trigger it.
   */
  public async resolveRunContext(bindingId: string, context: TContext): Promise<TContext | undefined> {
    const granted = await this.resolveTaskGrant(bindingId, context);
    if (granted.outcome === 'resolved') {
      return this.buildContext(granted.binding, granted.clientSecret, context);
    }
    if (granted.outcome === 'unusable') {
      // The binding names a task-layer grant that no longer applies. Falling back to a stored
      // credential here would resurrect access the user revoked.
      return undefined;
    }

    const credential = await this.repository.loadTaskAuthCredential(bindingId, context);
    if (!credential) {
      return undefined;
    }
    const snapshot = this.snapshotFromCredential(credential, context);
    if (snapshot.status !== TaskAuthBindingStatus.ACTIVE) {
      return undefined;
    }
    if (snapshot.expiresAt && snapshot.expiresAt <= nowTimestamp()) {
      return undefined;
    }
    const parsed = parseClientCredentialsApiKey(credential.apiKey);
    if (!parsed) {
      return undefined;
    }
    return this.buildContext(snapshot, parsed.clientSecret, context);
  }

  /**
   * A task-layer grant whose reference is the binding id, when this deployment has one.
   *
   * The owner comes from the context the caller restored, never from the binding id, so a forged
   * id cannot point somebody else's grant at this run.
   */
  private async resolveTaskGrant(
    bindingId: string,
    context: TContext,
  ): Promise<
    | { outcome: 'resolved'; binding: TaskAuthBindingSnapshot; clientSecret: string }
    | { outcome: 'unusable' }
    | { outcome: 'not-a-grant' }
  > {
    if (!this.taskCredentials || !bindingId.startsWith(TASK_CREDENTIAL_REF_PREFIX)) {
      return { outcome: 'not-a-grant' };
    }
    const webId = this.ownerFromContext(context);
    if (!webId) {
      return { outcome: 'unusable' };
    }
    const credential = await this.taskCredentials.forRef({ credentialRef: bindingId, ownerWebId: webId });
    if (!credential) {
      return { outcome: 'unusable' };
    }
    return {
      outcome: 'resolved',
      clientSecret: credential.clientSecret,
      binding: {
        id: bindingId,
        kind: TaskAuthBindingKind.SOLID_CLIENT_CREDENTIALS,
        webId,
        clientId: credential.clientId,
        status: TaskAuthBindingStatus.ACTIVE,
        createdAt: nowTimestamp(),
      },
    };
  }

  private ownerFromContext(context: TContext): string | undefined {
    const auth = this.solidAuthFromContext(context);
    if (auth?.webId) {
      return auth.webId;
    }
    const userId = (context as { userId?: unknown }).userId;
    return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
  }

  private snapshotFromCredential(
    credential: TaskAuthCredentialRecord,
    context: TContext,
  ): TaskAuthBindingSnapshot {
    if (credential.service !== TASK_AUTH_CREDENTIAL_SERVICE) {
      throw new Error(`Credential is not a task auth credential: ${credential.id}`);
    }

    const parsed = parseClientCredentialsApiKey(credential.apiKey);
    if (!parsed) {
      throw new Error(`Task auth credential is missing client credentials: ${credential.id}`);
    }

    const auth = this.solidAuthFromContext(context);
    const webId = auth?.webId;
    if (!webId) {
      throw new Error('Task auth credential resolution requires a Solid webId');
    }

    const status = credential.status === 'active'
      ? TaskAuthBindingStatus.ACTIVE
      : TaskAuthBindingStatus.REVOKED;
    const expiresAt = isoToTimestamp(credential.oauthExpiresAt);
    if (expiresAt && expiresAt <= nowTimestamp()) {
      return {
        id: credential.id,
        kind: TaskAuthBindingKind.SOLID_CLIENT_CREDENTIALS,
        webId,
        clientId: parsed.clientId,
        displayName: credential.label ?? undefined,
        status: TaskAuthBindingStatus.REVOKED,
        createdAt: isoToTimestamp(credential.createdAt) ?? nowTimestamp(),
        expiresAt,
      };
    }

    return {
      id: credential.id,
      kind: TaskAuthBindingKind.SOLID_CLIENT_CREDENTIALS,
      webId,
      clientId: parsed.clientId,
      displayName: credential.label ?? undefined,
      status,
      createdAt: isoToTimestamp(credential.createdAt) ?? nowTimestamp(),
      expiresAt,
    };
  }

  private solidAuthFromContext(context: TContext): SolidAuthContext | undefined {
    const auth = context.auth as SolidAuthContext | undefined;
    return auth && isSolidAuth(auth) ? auth : undefined;
  }

  private defaultBuildContext(binding: TaskAuthBindingSnapshot, clientSecret: string, context: TContext): TContext {
    return {
      ...context,
      userId: typeof context.userId === 'string' ? context.userId : binding.webId,
      auth: {
        type: 'solid',
        webId: binding.webId,
        accountId: binding.webId,
        clientId: binding.clientId,
        clientSecret,
        viaApiKey: true,
      },
    } as unknown as TContext;
  }
}

export function encodeClientCredentialsApiKey(clientId: string, clientSecret: string): string {
  return `sk-${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

export function parseClientCredentialsApiKey(value: unknown): { clientId: string; clientSecret: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith('sk-')) {
    return undefined;
  }
  const decoded = Buffer.from(value.slice(3), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function normalizeCredentialId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
}

function isoToTimestamp(value: string | Date | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? undefined : Math.floor(time / 1000);
}

function nowTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
