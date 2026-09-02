import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';

export function RouteLoadingBoundary({ children }: { children: ReactNode }) {
  return (
    <RouteChunkErrorBoundary>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">正在打开…</div>}>
        {children}
      </Suspense>
    </RouteChunkErrorBoundary>
  );
}

class RouteChunkErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  public state: { error?: Error } = {};

  public static getDerivedStateFromError(error: Error) {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route module failed to load', error, info.componentStack);
  }

  public render() {
    if (!this.state.error) return this.props.children;
    const staleChunk = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk .* failed/i.test(this.state.error.message);
    return (
      <div className="mx-auto flex min-h-64 max-w-md flex-col items-start justify-center gap-3 p-6">
        <div className="text-base font-medium">{staleChunk ? '页面已更新' : '页面暂时无法打开'}</div>
        <div className="text-sm text-muted-foreground">
          {staleChunk ? '当前窗口仍在使用旧版页面资源，请重新载入。' : '页面加载遇到了问题，请重试。这不表示登录已失效。'}
        </div>
        {import.meta.env.DEV && (
          <details className="max-w-full text-sm text-muted-foreground">
            <summary>开发诊断</summary>
            <pre className="whitespace-pre-wrap break-words">{this.state.error.message}</pre>
          </details>
        )}
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          onClick={() => window.location.reload()}
        >
          重新载入
        </button>
      </div>
    );
  }
}
