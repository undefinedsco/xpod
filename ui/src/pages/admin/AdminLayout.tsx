/**
 * Admin Layout - runtime console shell
 */

import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { MobileDashboardNav, Sidebar } from '@/components/ui/Sidebar';
import { StatusBar } from '@/components/ui/StatusBar';
import { getGatewayStatus, triggerRestart, type ServiceState } from '@/api/admin';

export function AdminLayout() {
  const [services, setServices] = useState<ServiceState[] | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      const data = await getGatewayStatus();
      if (!cancelled) {
        setServices(data);
        setLastCheckedAt(new Date());
      }
    };

    void fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    await triggerRestart();
    setTimeout(() => {
      setRestarting(false);
    }, 5000);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <StatusBar
        services={services}
        onRestart={handleRestart}
        restarting={restarting}
        lastCheckedAt={lastCheckedAt}
      />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-layout-content">
          <Outlet />
        </main>
      </div>
      <MobileDashboardNav />
    </div>
  );
}
