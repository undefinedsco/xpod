/**
 * Dashboard 页面 - 服务监控
 */

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { getGatewayStatus, getAdminStatus, type ServiceState, type AdminStatus } from '@/api/admin';
import { ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';

export function DashboardPage() {
  const [services, setServices] = useState<ServiceState[] | null>(null);
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      const [servicesData, statusData] = await Promise.all([
        getGatewayStatus(),
        getAdminStatus(),
      ]);
      setServices(servicesData);
      setAdminStatus(statusData);
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  const cssService = services?.find(s => s.name === 'css');
  const apiService = services?.find(s => s.name === 'api');
  const cssRunning = cssService?.status === 'running';
  const apiRunning = apiService?.status === 'running';
  const allRunning = cssRunning && apiRunning;
  // Use current window location as the Gateway URL (not CSS internal URL)
  const baseUrl = window.location.origin;

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  return (
    <div className="p-8">
      <h1 className="type-h1 mb-8">服务监控</h1>

      {/* Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        <Card variant="bordered">
          <CardContent>
            <div className="text-muted-foreground text-sm mb-2">CSS 服务</div>
            <div className={clsx('text-xl font-bold', cssRunning ? 'text-green-500' : 'text-destructive')}>
              {cssRunning ? '运行中' : '已停止'}
            </div>
            {cssService?.uptime && (
              <div className="text-sm text-muted-foreground mt-1">
                运行时间: {formatUptime(cssService.uptime)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardContent>
            <div className="text-muted-foreground text-sm mb-2">API 服务</div>
            <div className={clsx('text-xl font-bold', apiRunning ? 'text-green-500' : 'text-destructive')}>
              {apiRunning ? '运行中' : '已停止'}
            </div>
            {apiService?.uptime && (
              <div className="text-sm text-muted-foreground mt-1">
                运行时间: {formatUptime(apiService.uptime)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardContent>
            <div className="text-muted-foreground text-sm mb-2">访问地址</div>
            <div className="text-sm font-medium text-primary truncate">
              {baseUrl}
            </div>
          </CardContent>
        </Card>

        <Card variant="bordered">
          <CardContent>
            <div className="text-muted-foreground text-sm mb-2">整体状态</div>
            <div className={clsx('text-xl font-bold', allRunning ? 'text-green-500' : 'text-destructive')}>
              {allRunning ? '正常' : '异常'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* System Info */}
      {adminStatus && (
        <>
          <h2 className="type-h2 mb-5">系统信息</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
            <Card variant="bordered">
              <CardContent>
                <div className="text-muted-foreground text-sm mb-2">进程 ID</div>
                <div className="text-lg font-mono">{adminStatus.pid}</div>
              </CardContent>
            </Card>
            <Card variant="bordered">
              <CardContent>
                <div className="text-muted-foreground text-sm mb-2">运行模式</div>
                <div className="text-lg">{adminStatus.env.CSS_EDITION || 'local'}</div>
              </CardContent>
            </Card>
            <Card variant="bordered">
              <CardContent>
                <div className="text-muted-foreground text-sm mb-2">API 运行时间</div>
                <div className="text-lg">{formatUptime(adminStatus.uptime * 1000)}</div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Quick Actions */}
      <h2 className="type-h2 mb-5">快捷操作</h2>
      <div className="flex gap-3">
        <Button
          onClick={() => window.open(baseUrl, '_blank')}
          disabled={!allRunning}
          className="gap-2"
        >
          <ExternalLink className="w-4 h-4" />
          打开 Xpod
        </Button>
      </div>
    </div>
  );
}
