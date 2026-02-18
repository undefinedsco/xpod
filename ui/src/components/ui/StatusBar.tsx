import { clsx } from 'clsx';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { Button } from './Button';
import type { ServiceState } from '@/api/admin';

export function StatusBar(props: {
  services: ServiceState[] | null;
  onRestart: () => void | Promise<void>;
  restarting: boolean;
}) {
  const { services, onRestart, restarting } = props;

  const css = services?.find((s) => s.name === 'css');
  const api = services?.find((s) => s.name === 'api');
  const cssOk = css?.status === 'running';
  const apiOk = api?.status === 'running';
  const ok = Boolean(cssOk && apiOk);

  const openPod = () => {
    window.open(window.location.origin, '_blank');
  };

  return (
    <header className="h-14 bg-layout-sidebar border-b border-border flex items-center px-4 gap-3 min-w-0">
      <div className={clsx('flex items-center gap-2 text-sm font-medium shrink-0', ok ? 'text-green-500' : 'text-destructive')}>
        <span className={clsx('w-2 h-2 rounded-full shrink-0', ok ? 'bg-green-500' : 'bg-destructive')} />
        <span className="hidden sm:inline">{ok ? '运行中' : '服务异常'}</span>
      </div>

      <div className="hidden md:flex items-center gap-3 text-sm text-muted-foreground">
        <span className={clsx(cssOk ? 'text-foreground' : 'text-destructive')}>CSS: {cssOk ? '正常' : '停止'}</span>
        <span className={clsx(apiOk ? 'text-foreground' : 'text-destructive')}>API: {apiOk ? '正常' : '停止'}</span>
      </div>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="sm" onClick={onRestart} disabled={restarting} className="gap-1.5">
          <RefreshCw className={clsx('w-4 h-4', restarting && 'animate-spin')} />
          <span className="hidden sm:inline">{restarting ? '重启中...' : '重启'}</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={openPod} disabled={!ok} className="gap-1.5">
          <ExternalLink className="w-4 h-4" />
          <span className="hidden sm:inline">打开 Pod</span>
        </Button>
      </div>
    </header>
  );
}
