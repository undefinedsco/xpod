import { useId, type ReactNode } from 'react';
import { IdpChrome, PodSignInFrame, ScreenLayout } from '@undefineds.co/shared-ui';

/**
 * CSS Account documents share the Pod sign-in frame and tokens. The sign-in
 * service bar names Xpod and its host (the anti-phishing row); the title is the
 * screen's only heading. `bare` lets a body that brings its own bar and heading
 * (the B-group views) use just the frame.
 *
 * The frame decides `window` vs `page` from the host: the desktop auth window
 * fills 360×540, a browser document is a two-column page. `intro` is the page
 * frame's left column and is supplied by the host (the account service adapter),
 * so the shared library never hardcodes a service name.
 */
export function WebAccountLayout({ title, description, children, host = 'document', bare = false, intro, serviceIcon }: {
  title: string;
  description?: string;
  children: ReactNode;
  /** Kept for source compatibility: the frame now derives its presentation from `host`. */
  presentation?: 'standard' | 'compact';
  host?: 'document' | 'window';
  bare?: boolean;
  /** `page` only: the left introduction column. */
  intro?: ReactNode;
  /** Logo and optional info supplied by the account-service adapter. */
  serviceIcon?: ReactNode;
}) {
  const titleId = useId();
  const windowFrame = host === 'window';
  const layout = windowFrame ? 'window' : 'page';
  return (
    <main data-testid="web-account-page" className={windowFrame ? 'h-dvh w-full overflow-hidden' : undefined}>
      <PodSignInFrame
        presentation={windowFrame ? 'window' : 'page'}
        ariaLabel={title}
        appIntro={intro}
        dataAttributes={{ 'data-web-account-layout': layout, 'data-web-account-host': windowFrame ? 'window' : 'document' }}
      >
        <div
          data-testid="web-account-panel"
          data-web-account-layout={layout}
          data-web-account-host={windowFrame ? 'window' : 'document'}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {bare ? children : (
            <ScreenLayout chrome={<IdpChrome serviceName="Xpod" serviceHost={window.location.host} icon={serviceIcon} />}>
              <header className="flex flex-col gap-1">
                <h1 id={titleId} className="text-[17px] font-semibold text-foreground">{title}</h1>
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
