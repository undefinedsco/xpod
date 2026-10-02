import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { lazy, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { PodSection } from '@undefineds.co/pod-settings';
import { RouteLoadingBoundary } from './layout/RouteLoadingBoundary';
import { ShellHeaderControls } from './shell/ShellHeaderControls';
import { useXpodSolidRuntime } from './solid/useXpodSolidRuntime';
import { useXpodTheme } from './theme/xpod-theme-context';

const PodPage = lazy(() => import('./pages/pod/PodPage'));
interface WorkspaceItem { path: string; label: string }
const deviceItems: WorkspaceItem[] = [
  { path: '/device/network', label: '网络访问' }, { path: '/device/services', label: '服务状态' },
  { path: '/device/runtime', label: '运行设置' }, { path: '/device/logs', label: '查看日志' },
];
const podItems: WorkspaceItem[] = [
  { path: '/pod/models', label: '模型设置' }, { path: '/pod/search', label: '检索与索引' },
  { path: '/pod/apps', label: '授权应用' }, { path: '/pod/data', label: '数据管理' },
];
const settingsItems: WorkspaceItem[] = [{ path: '/settings/appearance', label: '外观' }];

export function SubjectWorkspace({ subject }: { subject: 'device' | 'pod' | 'settings' }) {
  const location = useLocation();
  const items = subject === 'device' ? deviceItems : subject === 'pod' ? podItems : settingsItems;
  const [query, setQuery] = useState('');
  const selected = items.find(item => item.path === location.pathname) ?? items[0];
  return <TwoPaneLayout mode="auto"
    listHeader={<label className="flex h-full items-center gap-2 px-4"><Search size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input aria-label="搜索页面" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索" className="min-w-0 w-full bg-transparent text-sm leading-normal outline-none" /></label>}
    list={<nav aria-label={subject === 'device' ? '这台设备' : subject === 'pod' ? 'Pod' : '设置'} className="p-2">{items.filter(item => item.label.includes(query.trim())).map(item => <NavLink key={item.path} to={item.path} className={({ isActive }) => `flex min-h-11 items-center rounded-lg px-3 text-sm leading-normal ${isActive ? 'bg-accent font-medium text-primary' : 'hover:bg-muted'}`}>{item.label}</NavLink>)}</nav>}
    mainHeader={<WorkspaceHeader title={selected.label} />}
    main={<Outlet />}
  />;
}
export function WorkspaceHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="flex h-full min-w-0 items-center justify-between gap-2 px-4"><h1 className="min-w-0 truncate text-sm leading-normal font-semibold">{title}</h1><div className="flex shrink-0 items-center gap-2">{children}<ShellHeaderControls /></div></div>;
}
/** A single 48px content header over a scrollable body; no object column and no second title. */
export function WorkspacePage({ title, children }: { title: string; children: ReactNode }) {
  return <TwoPaneLayout className="workspace-page" pageType="collection" hasObjectCollection={false}
    listHeader={null} list={null}
    mainHeader={<WorkspaceHeader title={title} />}
    main={<div className="p-6">{children}</div>} />;
}
export function PodSectionPage({ section }: { section: PodSection }) {
  const navigate = useNavigate();
  const runtime = useXpodSolidRuntime();
  const accountUrl = runtime.issuer ? new URL('/.account/account/', runtime.issuer).toString() : undefined;
  return <RouteLoadingBoundary><PodPage section={section} onSection={next => navigate(`/pod/${next}`)} accountUrl={accountUrl} /></RouteLoadingBoundary>;
}
export function AppearancePage() {
  const theme = useXpodTheme();
  return <section className="p-6 text-sm leading-normal"><label className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">主题<select aria-label="主题" className="h-auto min-h-9 rounded-md border bg-background px-3 py-1 leading-normal" value={theme.preference} onChange={event => theme.setPreference(event.target.value as 'system' | 'light' | 'dark')}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></section>;
}
