import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createTasksClient } from '@undefineds.co/tasks';
import { ShellContext, type ShellResumeFailure } from './useShellState';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';
import { fetchPodSettingsStatus } from '../api/pod-settings';
import { getPublicIpCheck } from '../api/admin';
import { decideApproval, emptyShellSnapshot, markActivitiesRead, readShellSnapshot } from './shell-state';

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const runtime = useXpodSolidRuntime();
  return <IdentityShellStateProvider key={`${runtime.state.status}|${runtime.webId || ''}|${runtime.currentPod?.podUrl || ''}`} runtime={runtime}>{children}</IdentityShellStateProvider>;
}
function IdentityShellStateProvider({ children, runtime }: { children: ReactNode; runtime: XpodSolidRuntimeValue }) {
  const tasksClient = useMemo(() => createTasksClient({ fetch: runtime.fetch, baseUrl: window.location.origin }), [runtime.fetch]);
  const [snapshot, setSnapshot] = useState(emptyShellSnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [resumeFailures, setResumeFailures] = useState<ShellResumeFailure[]>([]);
  const resumeInFlight = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  const readIds = useRef(new Set<string>());
  const mounted = useRef(true);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      setLoading(true);
      try {
        const [pod, network, usage] = await Promise.allSettled([
          runtime.state.status === 'authenticated' && runtime.currentPod ? readShellSnapshot(runtime.currentPod.database) : Promise.resolve(emptyShellSnapshot()),
          getPublicIpCheck(),
          runtime.state.status === 'authenticated' && runtime.webId && runtime.currentPod ? fetchPodSettingsStatus({ webId: runtime.webId, podUrl: runtime.currentPod.podUrl, authenticatedFetch: runtime.fetch }) : Promise.resolve(null),
        ]);
        const next = pod.status === 'fulfilled' ? pod.value : emptyShellSnapshot();
        if (network.status === 'fulfilled' && network.value?.status === 'fail') next.attention.push({ id: 'device:network', kind: 'network', title: '设备网络需要检查', href: '/device/network' });
        if (usage.status === 'fulfilled' && usage.value?.storage.status === 'available') {
          const storage = usage.value.storage;
          if (storage.limits.storageLimitBytes && storage.usage.storageBytes / storage.limits.storageLimitBytes >= 0.8) next.attention.push({ id: 'pod:storage', kind: 'quota', title: 'Pod 空间快到上限', href: '/pod/data' });
        }
        if (active) {
          setSnapshot(previous => {
            const source = pod.status === 'fulfilled' ? next : {
              ...previous,
              attention: [...previous.attention.filter(item => item.kind !== 'network' && item.kind !== 'quota'), ...next.attention],
            };
            return { ...source, activity: source.activity.map(item => ({ ...item, read: readIds.current.has(item.id) })) };
          });
          setError(pod.status === 'rejected' ? 'Pod 通知读取失败，请重试' : undefined);
        }
      } catch {
        if (active) setError('通知读取失败，请重试');
      } finally {
        busy = false;
        if (active) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('xpod:pod-changed', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('xpod:pod-changed', refresh); };
  }, [runtime.currentPod, runtime.webId, runtime.fetch, runtime.state.status, revision, refresh]);
  useEffect(() => { globalThis.xpodDesktop?.publishAttention?.(snapshot); }, [snapshot]);
  useEffect(() => () => { globalThis.xpodDesktop?.publishAttention?.(emptyShellSnapshot()); }, []);
  const retryResume = useCallback(async (approvalId: string, run: string) => {
    if (!mounted.current || resumeInFlight.current.has(approvalId)) return;
    resumeInFlight.current.add(approvalId);
    setResumeFailures(items => items.map(item => item.approvalId === approvalId ? { ...item, busy: true } : item));
    try {
      await tasksClient.resumeRun(run, approvalId);
      if (mounted.current) {
        setResumeFailures(items => items.filter(item => item.approvalId !== approvalId));
        refresh();
      }
    } catch {
      if (mounted.current) setResumeFailures(items => [...items.filter(item => item.approvalId !== approvalId), { approvalId, run, message: '决定已保存，运行处理失败，请重试。' }]);
    } finally { resumeInFlight.current.delete(approvalId); }
  }, [tasksClient, refresh]);
  const decide = useCallback(async (iri: string, decision: 'approved' | 'rejected') => {
    if (runtime.state.status !== 'authenticated' || !runtime.currentPod || !runtime.webId) throw new Error('请先登录并打开 Pod。');
    const run = snapshot.attention.find(item => item.approvalId === iri)?.run;
    await decideApproval(runtime.fetch, iri, runtime.webId, decision, () => mounted.current);
    if (!mounted.current) return;
    setSnapshot(value => ({ ...value, attention: value.attention.filter(item => item.approvalId !== iri), inbox: value.inbox.map(item => item.approvalId === iri ? { ...item, approvalId: undefined } : item) }));
    if (run) await retryResume(iri, run);
    refresh();
  }, [runtime.currentPod, runtime.webId, runtime.fetch, runtime.state.status, snapshot.attention, retryResume, refresh]);
  useEffect(() => globalThis.xpodDesktop?.onApprovalDecision?.(({ approvalId, decision }) => {
    void decide(approvalId, decision).catch((reason: unknown) => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '决定保存失败，请重试');
    });
  }), [decide]);
  return <ShellContext.Provider value={{ snapshot, loading, error, refresh, decide, resumeFailures, retryResume, markAllRead() {
    snapshot.activity.forEach(item => readIds.current.add(item.id));
    setSnapshot(markActivitiesRead);
  } }}>{children}</ShellContext.Provider>;
}
