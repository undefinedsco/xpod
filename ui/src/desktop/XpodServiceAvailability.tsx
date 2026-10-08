import { DisclosureSummary } from '@undefineds.co/shared-ui'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** One shell-owned connectivity check; authentication remains owned by the Solid runtime. */
export function XpodServiceAvailability({ children }: { children: ReactNode }) {
  const [unavailable, setUnavailable] = useState(false);
  const retry = useRef<() => void>(() => {});
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

  return <div className="flex h-dvh min-h-0 flex-col" style={{ '--xpod-shell-height': '100%' } as CSSProperties}>
    {unavailable && <section role="alert" aria-label="Xpod 连接中断" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <span className="font-medium">Xpod 连接中断</span>
        <span className="ml-2 text-muted-foreground">正在自动重连；你仍可打开这台设备和设置。</span>
        <details className="text-xs text-muted-foreground"><DisclosureSummary>页面与未完成操作</DisclosureSummary>
          登录状态和当前页面已保留。未完成的操作不会自动重试，请在连接恢复后确认结果。
        </details>
      </div>
      <button type="button" onClick={() => retry.current()} className="shrink-0 rounded-lg bg-primary px-3 py-2 text-primary-foreground">立即重试</button>
    </section>}
    <div className="min-h-0 flex-1">{children}</div>
  </div>;
}
