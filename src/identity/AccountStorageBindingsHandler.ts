import { assertAccountId, JsonInteractionHandler, type PodStore } from '@solid/community-server';
import type {
  Json,
  JsonInteractionHandlerInput,
  JsonRepresentation,
  JsonView,
} from '@solid/community-server';

export interface AccountStorageBindingsHandlerOptions {
  podStore: PodStore;
  /** The current Xpod storage root. Bindings outside this root are hidden. */
  storageBaseUrl?: string;
}

export interface AccountStorageBinding {
  [key: string]: Json | undefined;
  storageUrl: string;
  webId: string;
}

/**
 * Exposes the exact WebID/storage pairs owned by an authenticated Account.
 *
 * Account Pod and WebID controls are deliberately separate in CSS. Pairing
 * those arrays in the browser loses ownership information, so this handler
 * derives each pair directly from PodStore ownership facts and filters it to
 * the storage root served by this Xpod instance.
 */
export class AccountStorageBindingsHandler
  extends JsonInteractionHandler
  implements JsonView {
  private readonly podStore: PodStore;
  private readonly storageRoot?: URL;

  public constructor(options: AccountStorageBindingsHandlerOptions) {
    super();
    this.podStore = options.podStore;
    this.storageRoot = parseStorageRoot(options.storageBaseUrl);
  }

  public async getView({ accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const bindings = await this.findBindings(accountId);
    return { json: { bindings } };
  }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    return this.getView(input);
  }

  private async findBindings(accountId: string): Promise<AccountStorageBinding[]> {
    if (!this.storageRoot) {
      return [];
    }

    const pods = await this.podStore.findPods(accountId);
    const bindings: AccountStorageBinding[] = [];
    const seen = new Set<string>();

    for (const pod of pods) {
      const storageUrl = normalizeStorageUrl(pod.baseUrl, this.storageRoot);
      if (!storageUrl) {
        continue;
      }

      const owners = await this.podStore.getOwners(pod.id) ?? [];
      for (const owner of owners) {
        const webId = normalizeWebId(owner.webId);
        if (!webId) {
          continue;
        }
        const key = `${webId}\n${storageUrl}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        bindings.push({ webId, storageUrl });
      }
    }

    return bindings;
  }
}

function parseStorageRoot(value: string | undefined): URL | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    url.pathname = ensureTrailingSlash(url.pathname);
    return url;
  } catch {
    return undefined;
  }
}

function normalizeStorageUrl(value: unknown, root: URL): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    url.pathname = ensureTrailingSlash(url.pathname);
    if (belongsToRoot(url.href, root)) {
      return url.href;
    }
    if (isLoopbackUrl(url) && !isLoopbackUrl(root)) {
      const rewritten = new URL(url.pathname.replace(/^\/+/u, ''), root);
      rewritten.pathname = ensureTrailingSlash(rewritten.pathname);
      if (belongsToRoot(rewritten.href, root)) {
        return rewritten.href;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeWebId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function belongsToRoot(storageUrl: string, root: URL): boolean {
  const storage = new URL(storageUrl);
  if (storage.origin !== root.origin) {
    return false;
  }
  const rootPath = ensureTrailingSlash(root.pathname);
  return storage.pathname === rootPath || storage.pathname.startsWith(rootPath);
}

function isLoopbackUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

function ensureTrailingSlash(value: string): string {
  if (!value || value === '/') {
    return '/';
  }
  return value.endsWith('/') ? value : `${value}/`;
}
