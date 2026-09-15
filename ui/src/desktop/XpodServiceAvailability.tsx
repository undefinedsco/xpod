import { useEffect, useRef, useState, type ReactNode } from 'react';

/** One shell-owned connectivity check; authentication remains owned by the Solid runtime. */
export function XpodServiceAvailability({ children }: { children: ReactNode }) {
  const [unavailable, setUnavailable] = useState(false);
  const retry = useRef<() => void>(() => {});
  const retryButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!unavailable) return;
    const previousFocus = document.activeElement;
    retryButton.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [unavailable]);

  useEffect(() => {
    let disposed = false;
    let pending: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    async function check() {
      if (disposed || pending) return;
      clearTimeout(timer);
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000);
      let available = true;
      try {
        const response = await fetch('/service/status', { cache: 'no-store', signal: controller.signal });
        available = response.status < 500;
        if (response.ok) {
          // Some web hosts do not expose Gateway status (HTML fallback or 404).
          // Only the known status payload can establish a stopped child service.
          const services: unknown = await response.json().catch(() => null);
          if (Array.isArray(services)) {
            available = !services.some((service) => service
              && ['css', 'api'].includes(service.name)
              && typeof service.status === 'string' && service.status !== 'running');
          }
          if (controller.signal.aborted) available = false;
        } else {
          await response.body?.cancel();
        }
      } catch {
        available = false;
      } finally {
        clearTimeout(timeout);
        pending = undefined;
      }
      if (disposed) return;
      failures = available ? 0 : failures + 1;
      setUnavailable(!available);
      timer = setTimeout(() => {
        if (document.visibilityState !== 'hidden') void check();
      }, available ? 10_000 : Math.min(2_000 * 2 ** Math.min(failures - 1, 4), 30_000));
    }

    const resume = () => { if (document.visibilityState !== 'hidden') void check(); };
    retry.current = () => { void check(); };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
      pending?.abort();
      retry.current = () => {};
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  return <>
    <div style={{ display: 'contents' }} inert={unavailable || undefined}>{children}</div>
    {unavailable && <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm">
      <section role="alertdialog" aria-modal="true" aria-labelledby="xpod-connection-title" aria-describedby="xpod-connection-description"
        className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-lg">
        <h2 id="xpod-connection-title" className="text-lg font-semibold">Xpod 连接中断</h2>
        <p id="xpod-connection-description" className="mt-3 text-sm text-muted-foreground">暂时无法连接 Xpod，正在自动重连。登录状态和当前页面已保留，恢复后即可继续。</p>
        <p className="mt-2 text-sm text-muted-foreground">刚才未完成的操作不会自动重试，请在连接恢复后确认结果。</p>
        <button ref={retryButton} type="button" onKeyDown={(event) => {
          if (event.key === 'Tab') event.preventDefault();
        }} onClick={() => retry.current()} className="mt-5 w-full rounded-lg bg-primary px-4 py-2 text-primary-foreground">立即重试</button>
      </section>
    </div>}
  </>;
}
