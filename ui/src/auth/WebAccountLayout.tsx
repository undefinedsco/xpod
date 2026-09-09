import { useId, type ReactNode } from 'react';
import xpodIconUrl from '../assets/xpod-shield.svg';

function Brand() {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <img src={xpodIconUrl} alt="" className="h-14 w-14" />
      <div>
        <p className="text-xl font-semibold leading-tight text-foreground">Xpod</p>
        <p className="text-xs text-muted-foreground">Personal Messages Platform</p>
      </div>
    </div>
  );
}

/** CSS Account document layout for login, consent and account-result states. */
export function WebAccountLayout({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <main data-testid="web-account-page" className="flex min-h-dvh items-center justify-center bg-muted/30 p-4 text-foreground sm:p-6">
      <section
        role="region"
        aria-labelledby={titleId}
        data-testid="web-account-panel"
        data-web-account-layout="compact"
        className="mx-auto flex w-full min-w-0 max-w-md flex-col rounded-3xl border bg-card p-6 shadow-lg shadow-black/5 sm:p-8"
      >
        <div className="mb-7"><Brand /></div>
        <header className="mb-6 text-center">
          <h1 id={titleId} className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
        </header>
        {children}
      </section>
    </main>
  );
}
