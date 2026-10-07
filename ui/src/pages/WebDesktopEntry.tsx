import { useEffect, useState } from 'react';
import { Button, XpodMark } from '@undefineds.co/shared-ui';
import { AuthProvider } from '../context/AuthContext';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { accountOverviewHref } from '../utils/account-overview-href';
import {
  confirmConsentInteractionAtAuthority, consumeConfirmedConsentContinuation, consumeManagementContinuation,
  readConfirmedConsentContinuation, readManagementContinuation,
  resolveAuthoritativeAccountId, type ConsentContinuation, type ManagementContinuation,
} from '../utils/safe-continuation';

type ReturnTask = { record: ConsentContinuation | ManagementContinuation; assertCurrent: () => void };

export function DesktopEntryContent() {
  const account = useAuth();
  const accountId = resolveAuthoritativeAccountId(account.controls, account.identity);
  const accountHref = accountOverviewHref(account.idpIndex);
  const [task, setTask] = useState<ReturnTask | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const bind = account.bindAccountCapability;
  const activeTask = task?.record.accountId === accountId ? task : null;

  useEffect(() => {
    document.title = 'Xpod · 桌面管理';
    if (!accountId || !bind) return;
    let active = true;
    const assertCurrent = bind();
    void (async () => {
      const consent = await readConfirmedConsentContinuation({ accountId }, {
        assertCurrent, headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
      });
      if (!active) return;
      try {
        assertCurrent();
        const record = consent ?? readManagementContinuation({ accountId });
        setTask(record ? { record, assertCurrent } : null);
      } catch { setTask(null); }
    })();
    return () => { active = false; };
  }, [accountId, bind]);

  const returnToTask = async () => {
    if (!activeTask || pending) return;
    setPending(true); setError('');
    const { record, assertCurrent } = activeTask;
    try {
      assertCurrent();
      if (record.kind === 'consent') {
        const live = await confirmConsentInteractionAtAuthority(record, {
          assertCurrent, headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        });
        if (!live || !consumeConfirmedConsentContinuation(record, { accountId: record.accountId }, { assertCurrent })) throw new Error('expired-task');
      } else {
        const current = readManagementContinuation({ accountId: record.accountId });
        if (!current || current.createdAt !== record.createdAt || current.returnTo !== record.returnTo) throw new Error('expired-task');
        if (!consumeManagementContinuation({ accountId: record.accountId })) throw new Error('expired-task');
      }
      assertCurrent();
      window.location.assign(record.returnTo);
    } catch {
      setTask(null); setPending(false);
      setError('原任务已失效，请回到账号或应用重新发起。');
    }
  };

  return <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-6 py-12">
    <XpodMark size={56} />
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">在桌面 Xpod 中管理</h1>
      <p className="text-muted-foreground">Web 提供登录、应用授权、账号管理和快速创建 Pod。管理自己的部署、AI 连接和系统设置，请使用桌面 Xpod。</p>
    </div>
    <div className="flex flex-wrap gap-3">
      <Button asChild><a href="https://github.com/undefinedsco/xpod/releases/latest" target="_blank" rel="noopener noreferrer">下载桌面 Xpod</a></Button>
      {accountHref
        ? <Button asChild variant="outline"><a href={accountHref}>账号页面</a></Button>
        : <Button variant="outline" disabled>账号页面</Button>}
    </div>
    <p className="text-sm text-muted-foreground">已安装？打开桌面 Xpod，在其中管理本机部署。</p>
    {activeTask ? <section aria-label="原任务" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <p>当前任务保留在这个浏览器标签页中。完成桌面操作后，回到这里继续。</p>
      <p className="text-sm text-muted-foreground">{activeTask.record.kind === 'consent' ? '返回授权后重新选择 Pod，再确认授权；也可以在那里取消本次请求。' : '返回原来的账号页面查看 Pod。'}</p>
      <Button variant="outline" disabled={pending} onClick={() => void returnToTask()}>{pending ? '正在确认…' : activeTask.record.kind === 'consent' ? '回到授权' : '返回账号'}</Button>
    </section> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </main>;
}

export default function WebDesktopEntry() {
  return <AuthProvider><DesktopEntryContent /></AuthProvider>;
}
