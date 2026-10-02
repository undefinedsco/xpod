import { useEffect, useRef, useState } from 'react';
import { Bell, Inbox, RefreshCw, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ShellAttentionItem } from '@undefineds.co/extension-sdk';
import { InlineNotice } from '@undefineds.co/shared-ui';
import { useShellState } from './useShellState';

export function ApprovalCard({ item }: { item: ShellAttentionItem }) {
  const { decide } = useShellState();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function resolve(decision: 'approved' | 'rejected') {
    if (!item.approvalId) return;
    setBusy(true);
    try {
      await decide(item.approvalId, decision);
      setMessage('决定已保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded-md border border-border p-3 text-sm leading-normal">
    <p className="font-medium">{item.title}</p>
    <p className="text-xs leading-normal text-muted-foreground">风险：{({ low: '低', medium: '中', high: '高' } as Record<string, string>)[item.risk || ''] || item.risk || '未说明'}{item.expiresAt ? ` · 有效至 ${new Date(item.expiresAt).toLocaleString('zh-CN')}` : ''}</p>
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={() => void resolve('approved')} className="rounded bg-primary px-2 py-1 text-primary-foreground">只这一次</button>
      <button disabled title="长期授权待接入" className="rounded border px-2 py-1 opacity-50">以后都允许 · 待接入</button>
      <button disabled={busy} onClick={() => void resolve('rejected')} className="rounded border px-2 py-1">拒绝</button>
    </div>
    <p className="text-xs leading-normal text-muted-foreground">这次决定只对当前申请有效。</p>
    {message && <p role="status">{message}</p>}
  </div>;
}
export function ShellDecisionFeedback({ run, recoveryApproval }: { run?: string; recoveryApproval?: string }) {
  const { snapshot, resumeFailures, retryResume } = useShellState();
  const failures = resumeFailures.filter(item => !run || item.run === run);
  const recovery = snapshot.attention.filter(item => item.resumeApproval && item.run && (!run || item.run === run));
  for (const item of recovery) {
    if (!failures.some(failure => failure.approvalId === item.resumeApproval)) failures.push({ approvalId: item.resumeApproval!, run: item.run!, message: '审批决定已保存，可以继续处理这次运行。' });
  }
  if (run && recoveryApproval && !failures.some(item => item.approvalId === recoveryApproval)) {
    failures.push({ approvalId: recoveryApproval, run, message: '审批决定已保存，可以继续处理这次运行。' });
  }
  return <>{failures.map(item => <InlineNotice key={item.approvalId} tone="neutral" role="alert" className="my-2" action={<button disabled={item.busy} className="underline" onClick={() => void retryResume(item.approvalId, item.run)}>{item.busy ? '正在重试…' : '重试处理运行'}</button>}>
    {item.message}
  </InlineNotice>)}</>;
}
export function ShellInboxContent() {
  const { snapshot } = useShellState();
  const [params] = useSearchParams();
  const requestedApproval = snapshot.attention.find(item => item.approvalId === params.get('approval'));
  const standaloneApproval = requestedApproval && !snapshot.inbox.some(item => item.approvalId === requestedApproval.approvalId);
  return <><ShellDecisionFeedback />{standaloneApproval && <div className="mb-4"><ApprovalCard item={requestedApproval} /></div>}{snapshot.inbox.length ? <ul className="space-y-3">{snapshot.inbox.map(item => {
    const approval = snapshot.attention.find(row => row.approvalId === item.approvalId && item.approvalId);
    return <li key={item.id} className="space-y-2 border-b border-border pb-3">
      <p className="break-all text-xs leading-normal text-muted-foreground">{item.actor || '未知发送者'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>
      {approval ? <ApprovalCard item={approval} /> : <a className="break-all text-sm leading-normal underline" href={/^https?:\/\//.test(item.object) ? item.object : undefined} target="_blank" rel="noreferrer">{item.object}</a>}
    </li>;
  })}</ul> : <p className="py-6 text-sm leading-normal text-muted-foreground">收件箱是空的</p>}</>;
}
export function ShellNotificationsContent({ close = () => {} }: { close?(): void }) {
  const { snapshot, markAllRead } = useShellState();
  return <div className="space-y-5"><ShellDecisionFeedback /><section><h3 className="mb-2 text-sm leading-normal font-medium">需要你处理</h3>
    {snapshot.attention.length ? <ul className="space-y-2">{snapshot.attention.map(item => <li key={item.id}><Link onClick={close} to={item.href} className="block rounded-md border border-border p-3 text-sm leading-normal hover:bg-accent">{item.title} ›</Link></li>)}</ul> : <p className="text-sm leading-normal text-muted-foreground">没有待处理事项</p>}
  </section><section><div className="mb-2 flex items-center justify-between"><h3 className="text-sm leading-normal font-medium">动态</h3><button className="text-xs leading-normal text-muted-foreground" onClick={markAllRead}>全部已读</button></div>
    {snapshot.activity.length ? <ul className="space-y-2">{snapshot.activity.map(item => <li key={item.id}><Link to={item.href} onClick={close} className={`block text-sm leading-normal ${item.read ? 'text-muted-foreground' : 'font-medium'}`}>{item.title}</Link></li>)}</ul> : <p className="text-sm leading-normal text-muted-foreground">暂无动态</p>}
  </section></div>;
}
export function ShellHeaderControls() {
  const { snapshot, loading, error, refresh } = useShellState();
  const [open, setOpen] = useState<'notifications' | 'inbox' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    function key(event: KeyboardEvent) { if (event.key === 'Escape') { setOpen(null); lastTrigger.current?.focus(); } }
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(null); }
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  return <div ref={root} className="relative flex items-center gap-1">
    <button aria-label={loading ? '正在同步' : error || '刷新同步状态'} title={error || (loading ? '正在同步' : '刷新同步状态')} onClick={refresh} className="rounded p-2 hover:bg-accent"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
    {(['notifications', 'inbox'] as const).map(kind => <button key={kind} aria-label={kind === 'notifications' ? '通知' : '收件箱'} aria-expanded={open === kind} aria-controls="shell-popover" onClick={event => { lastTrigger.current = event.currentTarget; setOpen(open === kind ? null : kind); }} className="relative rounded p-2 hover:bg-accent">
      {kind === 'notifications' ? <Bell size={16} /> : <Inbox size={16} />}
      {(kind === 'notifications' ? snapshot.attention.length + snapshot.activity.filter(item => !item.read).length : snapshot.inbox.length) > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
    </button>)}
    {open && <div id="shell-popover" ref={panel} tabIndex={-1} role="region" aria-label={open === 'notifications' ? '通知中心' : '收件箱'} className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-[360px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg">
      <div className="mb-4 flex items-center justify-between"><h2 className="font-medium">{open === 'notifications' ? '通知中心' : '收件箱'}</h2><button aria-label="关闭" onClick={() => { setOpen(null); lastTrigger.current?.focus(); }}><X size={16} /></button></div>
      {error && <InlineNotice tone="destructive" role="alert" className="mb-3" action={<button onClick={refresh} className="underline">重试</button>}>{error}</InlineNotice>}
      {open === 'notifications' ? <ShellNotificationsContent close={() => setOpen(null)} /> : <ShellInboxContent />}
    </div>}
  </div>;
}
