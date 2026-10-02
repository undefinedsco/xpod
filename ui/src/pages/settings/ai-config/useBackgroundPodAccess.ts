import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  activeTaskCredential,
  fetchTaskCredentials,
  grantTaskCredential,
  revokeTaskCredential,
  type TaskCredentialSummary,
} from '../../../api/task-credentials';
import { useXpodSolidRuntime } from '../../../solid/useXpodSolidRuntime';

export interface BackgroundPodAccessState {
  credential?: TaskCredentialSummary;
  loading: boolean;
  working: boolean;
  error?: string;
  grant(): Promise<void>;
  revoke(): Promise<void>;
  reload(): Promise<void>;
}

/** Background Pod access belongs to one identity: its WebID plus the issuer that signed it in. */
function podAccessScope(webId: string | undefined, issuer: string | undefined): string | undefined {
  return webId ? `${webId}\u0000${issuer ?? ''}` : undefined;
}

function scopeFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

interface BackgroundPodAccessEntry {
  credential?: TaskCredentialSummary;
  /** The read for this session has settled; until then the panel treats it as loading. */
  loaded: boolean;
  /** A grant or revoke for this session is running. */
  working: boolean;
  error?: string;
}

interface BackgroundPodAccessSlot {
  /** The identity the slot answers, or undefined while nobody is signed in. */
  scope: string | undefined;
  /** Which sign-in this is; a re-login is a new one even for the same WebID. */
  generation: number;
  entry?: BackgroundPodAccessEntry;
}

const emptyEntry = (): BackgroundPodAccessEntry => ({ loaded: false, working: false });

/**
 * The grant that lets background work open this user's Pod.
 *
 * Held here rather than in the credential UI of an applet: the work it authorizes - index
 * maintenance and embeddings - is configured in this settings area, and this is where a user can
 * tell whether it may run while they are away.
 */
export function useBackgroundPodAccess(): BackgroundPodAccessState {
  const runtime = useXpodSolidRuntime();
  const { fetch: runtimeFetch, issuer, requestPodApiKey, webId } = runtime;
  const scope = podAccessScope(webId, issuer);

  // One slot, and only the current sign-in may read or write it. A logout, an account switch, or
  // the same WebID signing back in all advance the generation, so the answer a previous session
  // left behind is discarded instead of being reused by the next one.
  const [slot, setSlot] = useState<BackgroundPodAccessSlot>(() => ({ scope, generation: 0 }));
  // Store-previous-render: start a new identity from an empty slot in the render React commits,
  // rather than showing the previous identity's grant until an effect clears it.
  if (slot.scope !== scope) {
    setSlot({ scope, generation: slot.generation + 1 });
  }
  const { generation } = slot;

  // Async work compares the generation it started under with the one in flight. The ref is kept in
  // step within the same commit as the identity, so a `grant` that finishes preparing its key amid
  // a switch can see that the session it was asked for is gone.
  const generationRef = useRef(generation);
  useLayoutEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  const current = slot.scope === scope ? slot.entry : undefined;

  const write = useCallback((
    captured: number,
    change: (entry: BackgroundPodAccessEntry) => BackgroundPodAccessEntry,
  ) => {
    setSlot((previous) => (previous.generation === captured
      ? { ...previous, entry: change(previous.entry ?? emptyEntry()) }
      : previous));
  }, []);

  const load = useCallback((captured: number) => fetchTaskCredentials({ fetch: runtimeFetch })
    .then((credentials) => {
      write(captured, (entry) => ({
        ...entry,
        credential: activeTaskCredential(credentials, issuer),
        loaded: true,
        error: undefined,
      }));
    })
    .catch((reason: unknown) => {
      // An unconfigured store is a state of this deployment, not a page failure.
      write(captured, (entry) => ({ ...entry, loaded: true, error: scopeFailure(reason) }));
    }), [issuer, runtimeFetch, write]);

  useEffect(() => {
    // Without a WebID there is nothing to read; the empty slot derives the unconfigured view.
    if (scope === undefined) return;
    void load(generation);
  }, [generation, load, scope]);

  const reload = useCallback(async () => {
    if (scope === undefined) return;
    await load(generation);
  }, [generation, load, scope]);

  const grant = useCallback(async () => {
    if (scope === undefined) return;
    const captured = generation;
    write(captured, (entry) => ({ ...entry, working: true, error: undefined }));
    try {
      const apiKey = await requestPodApiKey?.();
      if (!apiKey) {
        throw new Error('当前会话无法准备凭据');
      }
      // The key is prepared asynchronously: if the sign-in ended meanwhile, its grant must not be
      // handed to whatever session holds the provider now.
      if (generationRef.current !== captured) {
        throw new Error('会话已改变，本次授权已取消');
      }
      const granted = await grantTaskCredential({ fetch: runtimeFetch, apiKey, name: 'Xpod 后台任务' });
      write(captured, (entry) => ({ ...entry, credential: granted, loaded: true, working: false, error: undefined }));
    } catch (reason) {
      write(captured, (entry) => ({ ...entry, loaded: true, working: false, error: scopeFailure(reason) }));
      throw reason;
    }
  }, [generation, requestPodApiKey, runtimeFetch, scope, write]);

  const revoke = useCallback(async () => {
    // Only the current sign-in's own grant may be revoked, so a switch can never revoke with the
    // previous identity's reference.
    if (scope === undefined || !current?.credential) return;
    const captured = generation;
    const credentialRef = current.credential.credentialRef;
    write(captured, (entry) => ({ ...entry, working: true, error: undefined }));
    try {
      await revokeTaskCredential({ fetch: runtimeFetch, credentialRef });
      write(captured, (entry) => ({ ...entry, credential: undefined, loaded: true, working: false, error: undefined }));
    } catch (reason) {
      write(captured, (entry) => ({ ...entry, loaded: true, working: false, error: scopeFailure(reason) }));
      throw reason;
    }
  }, [current, generation, runtimeFetch, scope, write]);

  return {
    ...(current?.credential ? { credential: current.credential } : {}),
    loading: scope !== undefined && current?.loaded !== true,
    working: current?.working === true,
    ...(current?.error ? { error: current.error } : {}),
    grant,
    revoke,
    reload,
  };
}

export function describeGrant(credential: TaskCredentialSummary): string {
  const parts = [`已授权 · v${credential.version}`];
  if (credential.lastUsedAt) {
    parts.push(`最近使用 ${new Date(credential.lastUsedAt).toLocaleString()}`);
  }
  if (credential.expiresAt) {
    parts.push(`${new Date(credential.expiresAt).toLocaleDateString()} 到期`);
  }
  return parts.join(' · ');
}
