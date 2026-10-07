import { podMutationLockIdentifier, podMutationNamespaceLockIdentifier } from '../provision/PodMutationLock';
import { randomUUID } from 'node:crypto';
import { BadRequestHttpError, ForbiddenHttpError, NotFoundHttpError, type IndexedStorage, type PodStore, type ExpiringReadWriteLocker } from '@solid/community-server';
import { PodDeletionOperationRepository } from '../identity/drizzle/PodDeletionOperationRepository';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase } from '../identity/drizzle/db';
import type { PodDataDeletionService } from './PodDataDeletionService';

export interface PodDeletionLifecycleOptions {
  podStore: PodStore;
  accountStorage: IndexedStorage<any>;
  dataDeletion: PodDataDeletionService;
  identityDbUrl: string;
  storageBaseUrl: string;
  edition?: string;
  resourceLocker: ExpiringReadWriteLocker;
}

/** Owns account metadata only after the complete Pod data deletion succeeds. */
export class PodDeletionLifecycleService {
  public readonly operations: PodDeletionOperationRepository;
  private readonly nodes: EdgeNodeRepository;
  private readonly root: URL;
  private readonly active = new Map<string, Promise<void>>();

  public constructor(private readonly options: PodDeletionLifecycleOptions) {
    this.operations = new PodDeletionOperationRepository(options.identityDbUrl);
    this.nodes = new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl), { ensureClusterTables: options.edition === 'server' });
    this.root = new URL(options.storageBaseUrl);
  }

  public async whileCreating<T>(name: unknown, create: () => Promise<T>): Promise<T> {
    if (typeof name !== 'string' || !name.trim()) { return create(); }
    const storageUrl = new URL(`${encodeURIComponent(name.trim())}/`, this.root).href;
    const reservationId = randomUUID();
    await this.operations.reserveStorage(storageUrl, reservationId, 'create');
    try { return await create(); } finally { await this.operations.releaseStorage(storageUrl, reservationId); }
  }

  public async canDelete(storageUrl: string, podId?: string): Promise<boolean> {
    if (this.isLocal(storageUrl)) { return true; }
    if (this.options.edition !== 'server') { return false; }
    const node = await this.nodes.findSpNodeByStorageUrl(storageUrl);
    return Boolean(node?.publicUrl && podId && await this.operations.remoteGeneration(podId, node.nodeId, storageUrl));
  }

  public async canAuthorizeDeletion(storageUrl: string, podId: string, accountId: string): Promise<boolean> {
    if (this.options.edition !== 'server' || this.isLocal(storageUrl)) { return false; }
    const pod = await this.options.podStore.get(podId);
    if (!pod || pod.accountId !== accountId || pod.baseUrl !== storageUrl) { return false; }
    const node = await this.nodes.findSpNodeByStorageUrl(storageUrl);
    return Boolean(node && !await this.operations.remoteGeneration(podId, node.nodeId, storageUrl) && !await this.operations.find(accountId, podId));
  }

  public async requestDeletionAuthorization(accountId: string, podId: string) {
    const pod = await this.options.podStore.get(podId);
    if (!pod || pod.accountId !== accountId) { throw new ForbiddenHttpError('POD_DELETE_AUTHORIZATION_INVALID'); }
    if (!await this.canAuthorizeDeletion(pod.baseUrl, podId, accountId)) { throw new BadRequestHttpError('POD_DELETE_AUTHORIZATION_CONFLICT'); }
    const node = (await this.nodes.findSpNodeByStorageUrl(pod.baseUrl))!;
    const { challenge, details } = await this.operations.createAuthorization({ accountId, podId, nodeId: node.nodeId, storageUrl: pod.baseUrl, returnUrl: new URL('.account/account/', this.root).href });
    const podName = new URL(pod.baseUrl).pathname.slice(new URL(node.publicUrl).pathname.replace(/\/?$/u, '/').length).replace(/\/$/u, '');
    const management = new URL('settings/pod', node.publicUrl.replace(/\/?$/u, '/'));
    management.searchParams.set('deletionAuthorization', challenge);
    management.searchParams.set('podName', podName);
    return { challenge, podName, expiresAt: details.expiresAt, localManagementUrl: management.href };
  }

  public async deleteOwned(accountId: string, podId: string): Promise<void> {
    const pod = await this.options.podStore.get(podId);
    if (!pod) {
      const previous = await this.operations.find(accountId, podId);
      if (previous?.state === 'completed') {
        if (this.isLocal(previous.storageUrl)) { await this.operations.releaseStorage(previous.storageUrl, previous.operationId); }
        return;
      }
      if (previous?.plan && this.isLocal(previous.storageUrl)) {
        await this.deleteLocal(previous.storageUrl, previous.operationId);
        return;
      }
      throw new ForbiddenHttpError('Pod deletion requires the creating account');
    }
    if (pod.accountId !== accountId) { throw new ForbiddenHttpError('Pod deletion requires the creating account'); }
    if (this.isLocal(pod.baseUrl)) {
      await this.deleteLocal(pod.baseUrl, undefined, { accountId, podId });
      return;
    }
    if (this.options.edition !== 'server') { throw new BadRequestHttpError('POD_DELETE_UNSUPPORTED_PROVIDER'); }
    const node = await this.nodes.findSpNodeByStorageUrl(pod.baseUrl);
    if (!node?.publicUrl) { throw new BadRequestHttpError('POD_DELETE_UNSUPPORTED_PROVIDER'); }
    const remotePodId = await this.operations.remoteGeneration(podId, node.nodeId, pod.baseUrl);
    if (!remotePodId) { throw new BadRequestHttpError('POD_DELETE_GENERATION_UNVERIFIED'); }
    let operation = await this.operations.find(accountId, podId);
    if (operation?.state === 'completed') {
      await this.removeMetadata(podId, accountId, pod.baseUrl);
      return;
    }
    // Grants are intentionally never persisted in plaintext; retries rotate a pending grant.
    const command = operation
      ? await this.operations.renewGrant(operation.operationId)
      : await this.operations.create({ accountId, podId, storageUrl: pod.baseUrl, nodeId: node.nodeId, remotePodId, ownerWebIds: (await this.options.podStore.getOwners(podId) ?? []).map((owner) => owner.webId) });
    operation = command.operation;
    const publicRoot = new URL(node.publicUrl);
    const storage = new URL(pod.baseUrl);
    if (storage.origin !== publicRoot.origin || !storage.pathname.startsWith(publicRoot.pathname.replace(/\/?$/u, '/'))) {
      throw new BadRequestHttpError('POD_DELETE_UNSUPPORTED_PROVIDER');
    }
    const podName = storage.pathname.slice(publicRoot.pathname.replace(/\/?$/u, '/').length).replace(/\/$/u, '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(podName)) { throw new BadRequestHttpError('POD_DELETE_UNSUPPORTED_PROVIDER'); }
    let response: Response;
    try {
      response = await fetch(new URL(`provision/pods/${encodeURIComponent(podName)}`, publicRoot.href.replace(/\/?$/u, '/')), {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `XpodPodDelete ${command.grant}`, 'X-Xpod-Pod-Deletion-Operation': operation.operationId },
      });
    } catch { throw new BadRequestHttpError('POD_DELETE_NODE_UNAVAILABLE'); }
    if (!response.ok) { throw new BadRequestHttpError('POD_DELETE_NODE_FAILED'); }
    const completed = await this.operations.get(operation.operationId);
    if (completed?.state !== 'completed') { throw new BadRequestHttpError('POD_DELETE_NOT_ACKNOWLEDGED'); }
    await this.removeMetadata(podId, accountId, pod.baseUrl);
  }

  public async deleteLocal(storageUrl: string, operationId?: string, expected?: { accountId?: string; podId?: string; ownerWebIds?: string[] }): Promise<void> {
    if (!this.isLocal(storageUrl)) { throw new ForbiddenHttpError('Pod storage is outside this server'); }
    // A completed command cannot resolve and delete a newly created Pod at the same address.
    if (operationId) {
      const existing = await this.operations.get(operationId);
      if (existing && existing.storageUrl !== storageUrl) { throw new ForbiddenHttpError('Deletion target mismatch'); }
      if (existing?.state === 'completed') {
        await this.operations.releaseStorage(storageUrl, existing.operationId);
        return;
      }
    }
    const previous = this.active.get(storageUrl);
    if (previous) { await previous; return this.deleteLocal(storageUrl, operationId, expected); }
    const pending = this.options.resourceLocker.withWriteLock(podMutationNamespaceLockIdentifier(this.options.storageBaseUrl), async (maintainNamespace = () => undefined) => {
      const namespaceRenewal = setInterval(maintainNamespace, 1_000);
      try {
        await this.options.resourceLocker.withWriteLock(podMutationLockIdentifier(storageUrl), async (maintainLock) => {
          const renewal = typeof maintainLock === 'function' ? setInterval(maintainLock, 1_000) : undefined;
          try { await this.runLocal(storageUrl, operationId, expected); }
          finally { if (renewal) { clearInterval(renewal); } }
        });
      } finally { clearInterval(namespaceRenewal); }
    });
    this.active.set(storageUrl, pending);
    try { await pending; } finally { this.active.delete(storageUrl); }
  }

  private async runLocal(storageUrl: string, operationId?: string, expected?: { accountId?: string; podId?: string; ownerWebIds?: string[] }): Promise<void> {
    const found = await this.options.podStore.findByBaseUrl(storageUrl);
    if (expected && found && (expected.podId && found.id !== expected.podId || expected.accountId && found.accountId !== expected.accountId)) {
      throw new ForbiddenHttpError('Pod incarnation changed');
    }
    if (expected?.ownerWebIds && found) {
      const owners = await this.options.podStore.getOwners(found.id) ?? [];
      if (!expected.ownerWebIds.length || !owners.some((owner) => expected.ownerWebIds!.includes(owner.webId))) {
        throw new ForbiddenHttpError('Pod owner changed');
      }
    }
    let operation = operationId ? await this.operations.get(operationId) : undefined;
    if (!operation && found) {
      const prior = await this.operations.find(found.accountId, found.id);
      if (operationId && prior && prior.operationId !== operationId) {
        throw new ForbiddenHttpError('Pod deletion command differs from the existing operation');
      }
      operation = prior;
    }
    if (!operation) {
      if (!found) { throw new NotFoundHttpError('POD_DELETE_NOT_FOUND'); }
      operation = await this.operations.createLocal({ accountId: found.accountId, podId: found.id, storageUrl, nodeId: 'local' }, operationId ?? randomUUID());
    }
    if (operation.state === 'completed') { return; }
    await this.operations.reserveStorage(storageUrl, operation.operationId, 'delete');
    const current = await this.options.podStore.findByBaseUrl(storageUrl);
    if (current && (current.id !== operation.podId || current.accountId !== operation.accountId)) {
      throw new ForbiddenHttpError('Pod incarnation changed');
    }
    if (found && (found.id !== operation.podId || found.accountId !== operation.accountId)) {
      throw new ForbiddenHttpError('Pod incarnation changed');
    }
    if (!operation.plan) {
      if (!found) { throw new NotFoundHttpError('POD_DELETE_NOT_FOUND'); }
      operation = await this.operations.savePlan(operation.operationId, await this.options.dataDeletion.prepare({ path: storageUrl }));
    }
    await this.options.dataDeletion.deletePodData({ path: storageUrl }, operation.plan);
    await this.removeMetadata(operation.podId, operation.accountId, storageUrl);
    await this.operations.complete(operation.operationId);
    await this.operations.releaseStorage(storageUrl, operation.operationId);
  }

  private async removeMetadata(podId: string, accountId: string, storageUrl: string): Promise<void> {
    const pod = await this.options.podStore.get(podId);
    if (pod && (pod.accountId !== accountId || pod.baseUrl !== storageUrl)) { throw new ForbiddenHttpError('Pod incarnation changed'); }
    const owners = await this.options.accountStorage.find('owner', { podId });
    for (const owner of owners) { await this.options.accountStorage.delete('owner', owner.id); }
    if (pod) { await this.options.accountStorage.delete('pod', podId); }
  }

  private isLocal(storageUrl: string): boolean {
    try {
      const url = new URL(storageUrl);
      return url.href === storageUrl && !url.username && !url.password && !url.search && !url.hash &&
        url.origin === this.root.origin && url.pathname.startsWith(this.root.pathname.replace(/\/?$/u, '/')) &&
        url.pathname !== this.root.pathname && url.pathname.endsWith('/');
    } catch { return false; }
  }
}
