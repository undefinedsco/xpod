import { useId, type ReactNode } from 'react';
import { IdpChrome, PodSignInFrame, ScreenLayout } from '@undefineds.co/shared-ui';

/**
 * CSS Account documents share the Pod sign-in frame and tokens. The sign-in
 * service bar names Xpod and its host (the anti-phishing row); the title is the
 * screen's only heading. `bare` lets a body that brings its own bar and heading
 * (the B-group views) use just the frame.
 */
export function WebAccountLayout({ title, description, children, host = 'document', bare = false }: {
  title: string;
  description?: string;
  children: ReactNode;
  /** Kept for source compatibility: every presentation now shares one layout. */
  presentation?: 'standard' | 'compact';
  host?: 'document' | 'window';
  bare?: boolean;
}) {
  const titleId = useId();
  const windowFrame = host === 'window';
  return (
    <main data-testid="web-account-page" className={windowFrame ? 'h-dvh w-full overflow-hidden' : undefined}>
      <PodSignInFrame
        presentation={windowFrame ? 'window' : 'page'}
        ariaLabel={title}
        dataAttributes={{ 'data-web-account-layout': 'compact', 'data-web-account-host': windowFrame ? 'window' : 'document' }}
      >
        <div
          data-testid="web-account-panel"
          data-web-account-layout="compact"
          data-web-account-host={windowFrame ? 'window' : 'document'}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {bare ? children : (
            <ScreenLayout chrome={<IdpChrome serviceName="Xpod" serviceHost={window.location.host} />}>
              <header className="flex flex-col gap-1">
                <h1 id={titleId} className="text-xl font-semibold text-foreground">{title}</h1>
                {description ? <p className="text-sm leading-[22px] text-muted-foreground">{description}</p> : null}
              </header>
              {children}
            </ScreenLayout>
          )}
        </div>
      </PodSignInFrame>
    </main>
  );
}
