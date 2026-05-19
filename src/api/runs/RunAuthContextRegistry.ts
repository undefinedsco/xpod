import type { StoreContext } from '../chatkit/store';

export type RunAuthContextLookup = {
  webId?: string;
  userId?: string;
};

/**
 * Process-local bridge from durable queue payloads back to server-side auth
 * context. Queue events carry only stable identity such as webId; credentials
 * remain in the service process/session layer.
 */
export class RunAuthContextRegistry<TContext extends StoreContext = StoreContext> {
  private readonly byWebId = new Map<string, TContext>();
  private readonly byUserId = new Map<string, TContext>();

  public remember(context: TContext | undefined): void {
    if (!context) {
      return;
    }

    const webId = this.webIdFromContext(context);
    if (webId) {
      this.byWebId.set(webId, context);
    }

    const userId = this.userIdFromContext(context);
    if (userId) {
      this.byUserId.set(userId, context);
    }
  }

  public resolve(lookup: RunAuthContextLookup | undefined): TContext | undefined {
    if (!lookup) {
      return undefined;
    }
    if (lookup.webId) {
      const context = this.byWebId.get(lookup.webId);
      if (context) {
        return context;
      }
    }
    return lookup.userId ? this.byUserId.get(lookup.userId) : undefined;
  }

  public list(): TContext[] {
    const seen = new Set<TContext>();
    const contexts: TContext[] = [];
    for (const context of [...this.byWebId.values(), ...this.byUserId.values()]) {
      if (!seen.has(context)) {
        seen.add(context);
        contexts.push(context);
      }
    }
    return contexts;
  }

  private webIdFromContext(context: TContext): string | undefined {
    const auth = context.auth as { type?: unknown; webId?: unknown } | undefined;
    return auth?.type === 'solid' && typeof auth.webId === 'string' ? auth.webId : undefined;
  }

  private userIdFromContext(context: TContext): string | undefined {
    return typeof context.userId === 'string' ? context.userId : undefined;
  }
}
