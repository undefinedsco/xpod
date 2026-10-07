import { useCallback, useEffect, useState } from 'react';
import type { DesktopRuntimeSettings } from '@undefineds.co/extension-sdk';
import { Button, ListRow, ListSurface, NativeSelect, SearchInput, SectionHeader, SwitchSettingRow } from '@undefineds.co/shared-ui';
import { fetchServicesStatusSnapshot, getAdminConfig, getLogs, triggerRestart, updateAdminConfig, type LogEntry, type ServicesStatusSnapshot } from '../../api/admin';
import { fetchTunnelClients, type TunnelClientInspection } from '../../api/network-settings';
import NetworkPage from '../settings/NetworkPage';

export function DeviceNetworkPage() { return <NetworkPage embedded />; }

const coreServices = [['gateway', '入口网关'], ['css', 'Solid 服务'], ['api', 'API 服务'], ['qlever', '查询引擎（QLever）'], ['inngest', '任务调度（Inngest）']] as const;
const serviceStates: Record<string, string> = { running: '运行中', stopped: '已停止', starting: '启动中', crashed: '运行异常', failed: '运行异常' };

export function DeviceServicesPage() {
  const [snapshot, setSnapshot] = useState<ServicesStatusSnapshot>();
  const [clients, setClients] = useState<TunnelClientInspection[]>([]);
  const [runtime, setRuntime] = useState<{ state: string; ownership: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [services, optional, host] = await Promise.all([fetchServicesStatusSnapshot(), fetchTunnelClients({ fetchImpl: fetch }).catch(() => undefined), globalThis.xpodDesktop?.deviceRuntime?.getRuntimeSettings?.()]);
      setSnapshot(services); setClients(optional?.clients ?? []); setRuntime(host);
      if (!services.adminData && !host) setError('暂时无法读取设备状态，请重试。');
    } catch { setError('暂时无法读取设备状态，请重试。'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void load(); }); return () => { active = false; }; }, [load]);
  const action = async (operation: 'start' | 'stop' | 'restart') => {
    if (operation !== 'start' && !window.confirm(`${operation === 'stop' ? '停止' : '重启'}这台设备上的 Xpod？正在进行的请求会中断。`)) return;
    setBusy(true); setError('');
    try {
      if (globalThis.xpodDesktop?.deviceRuntime?.runtimeAction) await globalThis.xpodDesktop.deviceRuntime.runtimeAction(operation);
      else if (operation !== 'restart' || !await triggerRestart()) throw new Error();
      await load();
    } catch { setError('操作未完成，请重试。'); }
    finally { setBusy(false); }
  };
  const components = Array.from(new Map(clients.map(client => [client.binary, client])).values());
  const stopped = runtime?.state === 'stopped' || runtime?.state === 'failed';
  return <section className="space-y-6 p-6">
    <div className="flex flex-wrap gap-2">{stopped ? <Button className="h-auto min-h-9 py-1 leading-normal" disabled={busy} onClick={() => void action('start')}>启动 Xpod</Button> : <><Button className="h-auto min-h-9 py-1 leading-normal" variant="outline" disabled={busy} onClick={() => void action('restart')}>重启 Xpod</Button><Button className="h-auto min-h-9 py-1 leading-normal" variant="outline" disabled={busy || runtime?.ownership !== 'desktop'} onClick={() => void action('stop')}>停止 Xpod</Button></>}<Button className="h-auto min-h-9 py-1 leading-normal" variant="ghost" disabled={busy} onClick={load}>刷新</Button></div>
    {error && <p role="alert" className="text-sm leading-normal text-destructive">{error}</p>}
    <section><SectionHeader level={2} title="核心服务" className="mb-2" titleClassName="text-muted-foreground" /><ListSurface>{coreServices.map(([id, label]) => {
      const status = snapshot?.servicesData?.find((service) => service.name === id)?.status ?? (id === 'gateway' && snapshot?.adminData ? 'running' : undefined);
      return <ListRow key={id} title={label} trailing={<span className={status === 'running' ? 'text-success' : 'text-muted-foreground'}>{status ? serviceStates[status] : '未报告'}</span>} />;
    })}</ListSurface></section>
    <section><SectionHeader level={2} title="可选组件" className="mb-2" titleClassName="text-muted-foreground" /><ListSurface>{components.map((client) => <ListRow key={client.binary} title={client.binary} trailing={<span>{client.state === 'missing' ? '未安装' : snapshot?.servicesData?.some((service) => service.name === client.binary && service.status === 'running') ? '运行中' : '未使用'}</span>}>{client.state === 'missing' && <details><summary className="cursor-pointer text-primary">安装方法</summary><p className="mt-2 break-words text-xs leading-normal text-muted-foreground">{client.installHint}</p></details>}</ListRow>)}{!components.length && <p className="p-4 text-sm leading-normal text-muted-foreground">暂未读取到可选组件状态</p>}</ListSurface></section>
    <p className="text-xs leading-normal text-muted-foreground">停止只影响这台设备；Xpod 云端和其他设备上的 Pod 不受影响。</p>
  </section>;
}

export function DeviceRuntimePage() {
  const [settings, setSettings] = useState<DesktopRuntimeSettings>();
  const [directory, setDirectory] = useState('');
  const [edition, setEdition] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void Promise.all([globalThis.xpodDesktop?.deviceRuntime?.getRuntimeSettings?.(), getAdminConfig()]).then(([host, config]) => { setSettings(host); setDirectory(host?.dataDirectory ?? config?.env.CSS_ROOT_FILE_PATH ?? ''); setEdition(config?.env.XPOD_EDITION ?? ''); }).catch(() => setError('无法读取运行设置，请重试。')); }, []);
  const changeDirectory = async () => {
    setError('');
    try {
      const selected = await globalThis.xpodDesktop?.deviceRuntime?.selectDataDirectory?.();
      if (!selected) return;
      if (!await updateAdminConfig({ CSS_ROOT_FILE_PATH: selected })) throw new Error();
      setDirectory(selected); setNotice('已保存，重启后使用新位置；原有数据不会自动迁移。');
    } catch { setError('无法更改数据位置，请重试。'); }
  };
  return <section className="space-y-5 p-6 text-sm leading-normal">
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
    <SwitchSettingRow label="开机时启动 Xpod" checked={settings?.launchAtLogin ?? false} disabled={!settings || !globalThis.xpodDesktop?.deviceRuntime?.setLaunchAtLogin} onCheckedChange={async (value) => { try { await globalThis.xpodDesktop?.deviceRuntime?.setLaunchAtLogin?.(value); setSettings((current) => current ? { ...current, launchAtLogin: value } : current); } catch { setError('无法保存开机启动设置。'); } }} />
    <SwitchSettingRow label="意外退出时自动重启" description="你手动停止的不会被重启" checked={settings?.autoRestart ?? false} disabled={!settings || !globalThis.xpodDesktop?.deviceRuntime?.setAutoRestart} onCheckedChange={async (value) => { try { await globalThis.xpodDesktop?.deviceRuntime?.setAutoRestart(value); setSettings((current) => current ? { ...current, autoRestart: value } : current); } catch { setError('无法保存自动重启设置。'); } }} />
    <div className="space-y-2"><div>数据位置</div><p className="break-all text-muted-foreground">{directory || '未报告'}</p><div className="flex flex-wrap gap-2"><Button className="h-auto min-h-9 py-1 leading-normal" variant="outline" disabled={!globalThis.xpodDesktop?.deviceRuntime?.showDataDirectory} onClick={() => void globalThis.xpodDesktop?.deviceRuntime?.showDataDirectory?.().catch(() => setError('无法打开数据位置。'))}>在{globalThis.xpodDesktop?.platform === 'darwin' ? '访达' : '文件管理器'}中显示</Button><Button className="h-auto min-h-9 py-1 leading-normal" variant="outline" disabled={!globalThis.xpodDesktop?.deviceRuntime?.selectDataDirectory} onClick={() => void changeDirectory()}>更改</Button></div></div>
    <div className="flex justify-between border-t border-border pt-4"><span>运行方式</span><span>{edition === 'cloud' ? 'Xpod 云端' : edition === 'local' ? '这台设备' : edition === 'standalone' ? 'Xpod 独立运行' : '未报告'}</span></div>
    <details><summary className="cursor-pointer text-muted-foreground">开发者模式</summary><dl className="mt-3 space-y-2"><div>访问地址：{window.location.origin}</div><div>端口：{window.location.port || (window.location.protocol === 'https:' ? '443' : '80')}</div></dl></details>
  </section>;
}

export function DeviceLogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [source, setSource] = useState(() => new URLSearchParams(window.location.search).get('source') ?? 'all');
  const [level, setLevel] = useState('all');
  const [period, setPeriod] = useState('all');
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setEntries(await getLogs({ source, level, limit: 500 })); setCheckedAt(Date.now()); } finally { setLoading(false); } }, [source, level]);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void load(); }); return () => { active = false; }; }, [load]);
  const visible = entries.filter((entry) => (period === 'all' || new Date(entry.timestamp).getTime() >= checkedAt - Number(period)) && `${entry.source} ${entry.message}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-4 p-6"><div className="flex flex-wrap gap-3 text-sm leading-normal">
    <label className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:w-auto">来源<NativeSelect value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option>{coreServices.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</NativeSelect></label>
    <label className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:w-auto">级别<NativeSelect value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></NativeSelect></label>
    <label className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:w-auto">时间<NativeSelect value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">全部时间</option><option value="3600000">最近一小时</option><option value="86400000">最近一天</option><option value="604800000">最近七天</option></NativeSelect></label>
    <SearchInput aria-label="搜索日志" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志" /><Button className="h-auto min-h-9 py-1 leading-normal" variant="outline" disabled={loading} onClick={load}>刷新</Button>
  </div><ListSurface>{visible.map((entry, index) => <div key={`${entry.timestamp}-${index}`} className="p-3 text-xs leading-normal"><div className="text-muted-foreground">{new Date(entry.timestamp).toLocaleString()} · {entry.source} · {entry.level}</div><pre className="mt-1 whitespace-pre-wrap break-words font-mono leading-normal">{entry.message}</pre></div>)}{!visible.length && <p className="p-4 text-sm leading-normal text-muted-foreground">{loading ? '正在读取日志…' : '没有匹配的日志'}</p>}</ListSurface><p className="text-xs leading-normal text-muted-foreground">显示最近 500 条日志中的匹配结果</p></section>;
}
