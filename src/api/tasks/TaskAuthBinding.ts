import { randomUUID } from 'node:crypto';
import type { StoreContext } from '../chatkit/store';
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
}

export class TaskAuthBindingService<TContext extends StoreContext = StoreContext> {
  private readonly repository: TaskAuthBindingRepository<TContext>;
  private readonly buildContext: (binding: TaskAuthBindingSnapshot, clientSecret: string, context: TContext) => TContext;

  public constructor(options: TaskAuthBindingServiceOptions<TContext>) {
    this.repository = options.repository;
    this.buildContext = options.buildContext ?? this.defaultBuildContext;
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

  public async resolveRunContext(bindingId: string, context: TContext): Promise<TContext | undefined> {
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
