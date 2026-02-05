/**
 * Admin Layout - 管理界面布局
 */

import { useState, useEffect } from 'react';
import { Sidebar, type AdminPage } from '@/components/ui/Sidebar';
import { StatusBar } from '@/components/ui/StatusBar';
import { DashboardPage, SettingsPage, LogsPage } from '@/pages/admin';
import { getGatewayStatus, triggerRestart, type ServiceState } from '@/api/admin';

export function AdminLayout() {
  const [currentPage, setCurrentPage] = useState<AdminPage>('dashboard');
  const [services, setServices] = useState<ServiceState[] | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const fetchStatus = async () => {
      const data = await getGatewayStatus();
      setServices(data);
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    await triggerRestart();
    // 等待服务重启
    setTimeout(() => {
      setRestarting(false);
    }, 5000);
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <StatusBar
        services={services}
        onRestart={handleRestart}
        restarting={restarting}
      />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="flex-1 overflow-auto bg-layout-content">
          {currentPage === 'dashboard' && <DashboardPage />}
          {currentPage === 'settings' && <SettingsPage />}
          {currentPage === 'logs' && <LogsPage />}
        </main>
      </div>
    </div>
  );
}
