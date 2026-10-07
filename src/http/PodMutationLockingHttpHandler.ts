import {
  BadRequestHttpError, ConflictHttpError, HttpHandler,
  type ExpiringReadWriteLocker, type HttpHandlerInput, type PodStore, type ResourceIdentifier,
} from '@solid/community-server';
import { PodDeletionOperationRepository } from '../identity/drizzle/PodDeletionOperationRepository';
import { podMutationLockIdentifier, podMutationNamespaceLockIdentifier } from '../provision/PodMutationLock';

/** Keeps the complete Pod mutation pipeline inside the Pod deletion barrier. */
export class PodMutationLockingHttpHandler extends HttpHandler {
  private readonly operations: PodDeletionOperationRepository;
  private readonly root: URL;

  public constructor(
    private readonly source: HttpHandler,
    private readonly podStore: PodStore,
    private readonly resourceLocker: ExpiringReadWriteLocker,
    identityDbUrl: string,
    baseUrl: string,
  ) {
    super();
    this.operations = new PodDeletionOperationRepository(identityDbUrl);
    this.root = new URL(baseUrl.replace(/\/?$/u, '/'));
  }

  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: HttpHandlerInput): Promise<void> {
    if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(input.request.method ?? '')) {
      return this.source.handleSafe(input);
    }
    // Request Host is deliberately ignored; absolute-form URLs cannot change
    // which registered Pod is protected by this instance's canonical gate.
    const target = new URL(input.request.url ?? '/', this.root);
    if (target.origin !== this.root.origin || target.username || target.password || target.hash ||
      !target.pathname.startsWith(this.root.pathname)) {
      throw new BadRequestHttpError('Invalid Pod mutation target');
    }
    const relative = target.pathname.slice(this.root.pathname.length);
    if (/^(?:\.account|provision)(?:\/|$)/u.test(relative)) {
      return this.source.handleSafe(input);
    }
    target.search = '';
    const found = await this.findPod(target);
    // A server-root registration still covers every descendant Pod.
    const expected = found?.baseUrl === this.root.href ? undefined : found;
    const revision = expected ? undefined : await this.operations.namespaceDeletionRevision(this.root.href);
    await this.withReadLock(podMutationNamespaceLockIdentifier(this.root.href), async () => {
      if (!expected) {
        if (await this.operations.blocksNamespaceMutation(this.root.href)) {
          throw new ConflictHttpError('POD_DELETE_IN_PROGRESS');
        }
        if (revision !== await this.operations.namespaceDeletionRevision(this.root.href)) {
          throw new ConflictHttpError('POD_NAMESPACE_CHANGED');
        }
        await this.source.handleSafe(input);
        return;
      }
      await this.withReadLock(podMutationLockIdentifier(expected.baseUrl), async () => {
        const current = await this.podStore.findByBaseUrl(expected.baseUrl);
        if (!current || current.id !== expected.id || current.accountId !== expected.accountId) {
          throw new ConflictHttpError('POD_INCARNATION_CHANGED');
        }
        if (await this.operations.blocksMutation(expected.baseUrl)) {
          throw new ConflictHttpError('POD_DELETE_IN_PROGRESS');
        }
        await this.source.handleSafe(input);
      });
    });
  }

  private async withReadLock(identifier: ResourceIdentifier, action: () => Promise<void>): Promise<void> {
    await this.resourceLocker.withReadLock(identifier, async (maintainLock) => {
      const renewal = typeof maintainLock === 'function' ? setInterval(maintainLock, 1_000) : undefined;
      try { await action(); } finally { if (renewal) { clearInterval(renewal); } }
    });
  }

  private async findPod(target: URL): Promise<{ baseUrl: string; id: string; accountId: string } | undefined> {
    let pathname = target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`;
    while (pathname.startsWith(this.root.pathname)) {
      const baseUrl = new URL(pathname, this.root).href;
      const pod = await this.podStore.findByBaseUrl(baseUrl);
      if (pod) { return { baseUrl, ...pod }; }
      if (pathname === this.root.pathname) { break; }
      pathname = pathname.slice(0, pathname.slice(0, -1).lastIndexOf('/') + 1);
    }
    return undefined;
  }
}
