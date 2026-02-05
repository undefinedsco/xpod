// Dashboard - Service monitoring page
import { useEffect, useState } from 'react';
import type { ServiceStatus } from '../api';

interface Props {
  status: ServiceStatus | null;
}

interface Stats {
  cpu: number;
  memory: number;
  disk: number;
  requests: number;
}

export function Dashboard({ status }: Props) {
  const [stats, setStats] = useState<Stats>({
    cpu: 0,
    memory: 0,
    disk: 0,
    requests: 0,
  });

  // Mock stats update - replace with real data later
  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        cpu: Math.random() * 30 + 10,
        memory: Math.random() * 200 + 100,
        disk: 2.3,
        requests: Math.floor(Math.random() * 100),
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const cssRunning = status?.css?.running ?? false;
  const apiRunning = status?.api?.running ?? false;
  const allRunning = cssRunning && apiRunning;
  const baseUrl = status?.orchestrator?.baseUrl || window.location.origin;

  const StatCard = ({ title, value, unit, color }: { title: string; value: number; unit: string; color: string }) => (
    <div className="bg-card border border-border rounded-lg p-5 min-w-[150px]">
      <div className="text-muted-foreground text-sm mb-2">{title}</div>
      <div className="text-2xl font-bold" style={{ color }}>
        {value.toFixed(1)}
        <span className="text-sm ml-1 text-muted-foreground">{unit}</span>
      </div>
    </div>
  );

  return (
    <div className="p-8">
      <h1 className="type-h1 mb-8">服务监控</h1>

      {/* Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-muted-foreground text-sm mb-2">CSS 服务</div>
          <div className={`text-xl font-bold ${cssRunning ? 'text-green-500' : 'text-red-500'}`}>
            {cssRunning ? '运行中' : '已停止'}
          </div>
          {status?.css?.port && (
            <div className="text-sm text-muted-foreground mt-1">端口: {status.css.port}</div>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-muted-foreground text-sm mb-2">API 服务</div>
          <div className={`text-xl font-bold ${apiRunning ? 'text-green-500' : 'text-red-500'}`}>
            {apiRunning ? '运行中' : '已停止'}
          </div>
          {status?.api?.port && (
            <div className="text-sm text-muted-foreground mt-1">端口: {status.api.port}</div>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-muted-foreground text-sm mb-2">中控地址</div>
          <div className="text-sm font-bold text-primary truncate">
            {baseUrl}
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <div className="text-muted-foreground text-sm mb-2">整体状态</div>
          <div className={`text-xl font-bold ${allRunning ? 'text-green-500' : 'text-red-500'}`}>
            {allRunning ? '正常' : '异常'}
          </div>
        </div>
      </div>

      {/* Resource Stats */}
      <h2 className="type-h2 mb-5">资源使用</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-8">
        <StatCard title="CPU" value={stats.cpu} unit="%" color="#4ecdc4" />
        <StatCard title="内存" value={stats.memory} unit="MB" color="#95e1d3" />
        <StatCard title="磁盘" value={stats.disk} unit="GB" color="#f38181" />
        <StatCard title="请求/分" value={stats.requests} unit="" color="#aa96da" />
      </div>

      {/* Quick Actions */}
      <h2 className="type-h2 mb-5">快捷操作</h2>
      <div className="flex gap-3">
        <button
          onClick={() => window.open(baseUrl, '_blank')}
          disabled={!allRunning}
          className="btn-warm disabled:opacity-50"
        >
          打开 Pod 管理页
        </button>
        <button
          onClick={() => window.open(`${baseUrl}/.account/`, '_blank')}
          disabled={!allRunning}
          className="px-6 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          账户管理
        </button>
      </div>
    </div>
  );
}
