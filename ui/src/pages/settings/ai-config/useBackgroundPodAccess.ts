import { useCallback, useEffect, useState } from 'react';

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

/**
 * The grant that lets background work open this user's Pod.
 *
 * Held here rather than in the credential UI of an applet: the work it authorizes - index
 * maintenance and embeddings - is configured in this settings area, and this is where a user can
 * tell whether it may run while they are away.
 */
export function useBackgroundPodAccess(): BackgroundPodAccessState {
  const runtime = useXpodSolidRuntime();
  const [credential, setCredential] = useState<TaskCredentialSummary>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    if (!runtime.webId) {
      setCredential(undefined);
      setLoading(false);
      return;
    }
    try {
      const credentials = await fetchTaskCredentials({ fetch: runtime.fetch });
      setCredential(activeTaskCredential(credentials, runtime.issuer));
      setError(undefined);
    } catch (reason) {
      // An unconfigured store is a state of this deployment, not a page failure.
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [runtime.fetch, runtime.issuer, runtime.webId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grant = useCallback(async () => {
    setWorking(true);
    setError(undefined);
    try {
      const apiKey = await runtime.requestPodApiKey?.();
      if (!apiKey) {
        throw new Error('当前会话无法准备凭据');
      }
      const granted = await grantTaskCredential({ fetch: runtime.fetch, apiKey, name: 'Xpod 后台任务' });
      setCredential(granted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setWorking(false);
    }
  }, [runtime.fetch, runtime.requestPodApiKey]);

  const revoke = useCallback(async () => {
    if (!credential) {
      return;
    }
    setWorking(true);
    setError(undefined);
    try {
      await revokeTaskCredential({ fetch: runtime.fetch, credentialRef: credential.credentialRef });
      setCredential(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setWorking(false);
    }
  }, [credential, runtime.fetch]);

  return {
    ...(credential ? { credential } : {}),
    loading,
    working,
    ...(error ? { error } : {}),
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
