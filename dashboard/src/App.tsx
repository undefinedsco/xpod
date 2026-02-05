// Dashboard - Service Management UI
import { useEffect, useState } from 'react';
import { SetupWizard } from './pages/SetupWizard';
import { Dashboard } from './pages/Dashboard';
import { Logs } from './pages/Logs';
import { Settings } from './pages/Settings';
import { StatusBar } from './components/StatusBar';
import { Sidebar } from './components/Sidebar';
import type { ServiceStatus } from './api';

type Page = 'dashboard' | 'logs' | 'settings';

// 使用 HTTP API 替代 Tauri invoke
import { getServiceStatus } from './api';

async function fetchStatus(): Promise<ServiceStatus | null> {
  return await getServiceStatus();
}

async function checkIsFirstTime(): Promise<boolean> {
  // 检查是否首次运行（可以通过 API 或 localStorage）
  const configured = localStorage.getItem('xpod_configured');
  return !configured;
}

export function App() {
  const [firstTime, setFirstTime] = useState<boolean | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [status, setStatus] = useState<ServiceStatus | null>(null);

  useEffect(() => {
    checkFirstTime();
  }, []);

  const checkFirstTime = async () => {
    try {
      const isFirst = await checkIsFirstTime();
      setFirstTime(isFirst);
      if (!isFirst) {
        startPolling();
      }
    } catch (e) {
      console.error('Failed to check first time:', e);
      setFirstTime(false);
    }
  };

  const startPolling = () => {
    const poll = async () => {
      const s = await fetchStatus();
      setStatus(s);
    };
    poll();
    const interval = setInterval(poll, 3000);
    return interval;
  };

  const handleWizardComplete = () => {
    localStorage.setItem('xpod_configured', 'true');
    setFirstTime(false);
    startPolling();
  };

  if (firstTime === null) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-foreground">
        加载中...
      </div>
    );
  }

  if (firstTime) {
    return <SetupWizard onComplete={handleWizardComplete} />;
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <StatusBar status={status} />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="flex-1 overflow-auto bg-layout-content">
          {currentPage === 'dashboard' && <Dashboard status={status} />}
          {currentPage === 'logs' && <Logs />}
          {currentPage === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  );
}
