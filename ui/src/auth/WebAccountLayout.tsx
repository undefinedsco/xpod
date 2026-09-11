import { useId, type ReactNode } from 'react';
import { Clock, Layers, Shield } from 'lucide-react';
import xpodIconUrl from '../assets/xpod-shield.svg';

const features = [
  { icon: Clock, title: 'Your AI Secretary Never Stops', description: 'Runs 24/7, even when you are not talking to it' },
  { icon: Layers, title: 'All Your Pieces, In One Place', description: 'Data, memory, and context come back into one system' },
  { icon: Shield, title: 'One Secretary, Many Agents', description: 'One aligned layer that can direct many agents while keeping privacy and control inside your boundary.' },
];

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <img src={xpodIconUrl} alt="" className="h-12 w-12" />
      <div>
        <p className="text-2xl font-bold leading-tight">Xpod</p>
        <p className="text-xs text-muted-foreground">Personal Messages Platform</p>
      </div>
    </div>
  );
}

/** CSS Account document layout, independent of the host's window geometry. */
export function WebAccountLayout({ title, description, children, presentation = 'standard' }: {
  title: string;
  description?: string;
  children: ReactNode;
  presentation?: 'standard' | 'compact';
}) {
  const titleId = useId();
  if (presentation === 'compact') {
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
  return (
    <main data-testid="web-account-page" className="flex min-h-dvh items-center justify-center bg-muted/30 p-4 text-foreground sm:p-8">
      <div className="grid w-full max-w-6xl items-center gap-8 lg:grid-cols-2 lg:gap-16">
        <aside data-testid="web-account-introduction" aria-label="关于 Xpod" className="hidden px-8 lg:block">
          <Brand />
          <h1 className="mb-4 mt-8 text-3xl font-bold leading-tight">
            Simplify Life with <span className="text-primary">Your AI Secretary</span>
          </h1>
          <p className="mb-10 text-sm leading-relaxed text-muted-foreground">
            An AI that never stops, knows your whole life, works for you—while guarding your privacy.
          </p>
          <div className="space-y-5">
            {features.map(({ icon: Icon, title: featureTitle, description: featureDescription }) => (
              <div key={featureTitle} className="flex gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-card">
                  <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-medium">{featureTitle}</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{featureDescription}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-12 text-xs text-muted-foreground">
            Powered by <a href="https://solidproject.org" target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">Solid Protocol</a>
          </p>
        </aside>
        <section role="region" aria-labelledby={titleId} data-testid="web-account-panel" data-web-account-layout="standard" className="mx-auto w-full min-w-0 max-w-md rounded-3xl border bg-card p-6 shadow-lg shadow-black/5 sm:p-8 lg:mx-0">
          <div className="mb-8 lg:hidden"><Brand /></div>
          <header className="mb-6">
            <h2 id={titleId} className="text-2xl font-bold tracking-tight">{title}</h2>
            {description ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}
