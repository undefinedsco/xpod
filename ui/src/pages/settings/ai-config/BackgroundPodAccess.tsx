import type { ReactNode } from 'react';

import { describeGrant, useBackgroundPodAccess } from './useBackgroundPodAccess';

export interface BackgroundPodAccessProps {
  /** Called after a successful grant, so a blocked action can continue where it stopped. */
  onGranted?(): void | Promise<void>;
  /** Extra line shown when this panel is the answer to a refused action. */
  notice?: ReactNode;
}

/**
 * Whether background work may open this user's Pod.
 *
 * Index maintenance runs while nobody is watching, so it needs a credential on file; this panel is
 * both the place to check that and the button that creates it.
 */
export function BackgroundPodAccess({ onGranted, notice }: BackgroundPodAccessProps) {
  const access = useBackgroundPodAccess();

  const grant = async () => {
    try {
      await access.grant();
      await onGranted?.();
    } catch {
      // The hook keeps the message.
    }
  };

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Background Pod access</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Lets index maintenance and embeddings read this Pod while you are not signed in.
          </p>
        </div>
        {access.credential
          ? (
            <button
              type="button"
              disabled={access.working}
              onClick={() => void access.revoke().catch(() => undefined)}
              className="h-9 rounded-md border border-input px-3 text-sm font-medium disabled:opacity-50"
            >
              {access.working ? '正在撤销…' : '撤销授权'}
            </button>
          )
          : (
            <button
              type="button"
              disabled={access.working || access.loading}
              onClick={() => void grant()}
              className="h-9 rounded-md border border-input px-3 text-sm font-medium disabled:opacity-50"
            >
              {access.working ? '正在授权…' : '授权后台任务访问'}
            </button>
          )}
      </div>
      {notice ? <p className="mt-3 text-sm text-destructive">{notice}</p> : null}
      <p className="mt-3 text-sm">
        {access.credential ? describeGrant(access.credential) : '未授权：后台任务在你不在时无法读取这个 Pod。'}
      </p>
      {access.error ? <p className="mt-2 text-xs text-destructive">{access.error}</p> : null}
    </section>
  );
}
