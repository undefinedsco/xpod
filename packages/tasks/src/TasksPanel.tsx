import { DisclosureSummary } from '@undefineds.co/shared-ui'
import { Button, Checkbox, InlineNotice, Input, NativeSelect, SearchInput, SegmentedControl, Textarea, interactiveFocusClass } from '@undefineds.co/shared-ui';
import { TwoPaneLayout, WorkspaceDrawerContext, useWorkspaceLayout } from '@undefineds.co/extension-sdk/react';
import { useContext, useEffect, useState, type ReactNode, type FormEvent } from 'react';
import type { CreateTask, TaskCapabilities, TaskRun, TaskStep, TaskSummary, TasksClient, TodoChanges } from './client';
import { agendaTasks, groupTasks, isEnded, isMine, type TaskFilter } from './grouping';

export interface TasksPanelProps {
  client: TasksClient;
  webId: string;
  workspace: string;
  onOpenConnections?: () => void;
  selectedTaskId?: string;
  selectedRunId?: string;
  renderApproval?: (run: TaskRun) => ReactNode;
  headerActions?: ReactNode;
}
const unavailable: TaskCapabilities = { createAi: false, resumeStep: false, handoff: false, approve: false };
const statusLabel: Record<string, string> = { open: '待办', active: '按计划运行', blocked: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', running: '进行中', queued: '等待执行', waiting_input: '在等你', waiting_runner: '等待执行环境' };
const kindLabel: Record<string, string> = { cron: '定时', interval: '周期', event: '事件', once: '定时' };
const time = (seconds?: number) => seconds === undefined ? '未设置' : new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const cronLabel = (cron?: string) => {
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron ?? '');
  return daily ? `每天 ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` : '自定义计划';
};
const safeSource = (source?: string) => source && /^https?:\/\//.test(source) ? source : undefined;

/** Shared body only: hosts own rail, navigation, session and authenticated transport. */
export function TasksPanel({ client, webId, workspace, onOpenConnections, selectedTaskId, selectedRunId, renderApproval, headerActions }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [capabilities, setCapabilities] = useState(unavailable);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [view, setView] = useState<'list' | 'agenda'>('list');
  const [search, setSearch] = useState('');
  const [todo, setTodo] = useState('');
  const [expandedTodos, setExpandedTodos] = useState(false);
  const [allEnded, setAllEnded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [run, setRun] = useState<TaskRun>();
  const [linkedRun, setLinkedRun] = useState<TaskRun>();
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const result = await client.list(); setTasks(result.tasks); setCapabilities(result.capabilities);
  };
  useEffect(() => {
    let active = true; setLoading(true); setTasks([]); setCapabilities(unavailable); setSelected(undefined); setLinkedRun(undefined); setError('');
    client.list().then(result => { if (active) { setTasks(result.tasks); setCapabilities(result.capabilities); } })
      .catch(error => { if (active) setError(String(error.message ?? error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, webId]);
  useEffect(() => {
    let active = true; setRuns([]); setRun(undefined); setSteps([]);
    if (selected) client.runs(selected).then(result => { if (active) { setRuns(result.runs); if (linkedRun) setRun(result.runs.find(item => item.id === linkedRun.id) ?? linkedRun); } })
      .catch(error => { if (active) setError(String(error.message ?? error)); });
    return () => { active = false; };
  }, [client, selected, linkedRun]);
  useEffect(() => {
    let active = true; setSteps([]);
    if (run) client.steps(run.id).then(result => { if (active) setSteps(result.steps); })
      .catch(error => { if (active) setError(String(error.message ?? error)); });
    return () => { active = false; };
  }, [client, run?.id]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState !== 'hidden') {
          const [taskResult, runResult, stepResult] = await Promise.all([
            client.list(), client.runs(selected), run?.id ? client.steps(run.id) : undefined,
          ]);
          if (!active) return;
          setTasks(taskResult.tasks); setCapabilities(taskResult.capabilities); setRuns(runResult.runs);
          setRun(current => current ? runResult.runs.find(item => item.id === current.id) ?? current : current);
          if (stepResult) setSteps(stepResult.steps);
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [client, selected, run?.id]);
  useEffect(() => {
    if (!selectedTaskId) return;
    const linked = tasks.find(item => item.id === selectedTaskId || item.iri === selectedTaskId);
    if (linked) { setSelected(linked.id); setCreating(false); }
  }, [selectedTaskId, tasks]);
  useEffect(() => {
    let active = true;
    if (selectedRunId) client.selection(selectedRunId).then(result => {
      if (active) { setSelected(result.taskId); setLinkedRun(result.run); setCreating(false); }
    }).catch(error => { if (active) setError(String(error.message ?? error)); });
    return () => { active = false; };
  }, [client, selectedRunId]);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const task = tasks.find(item => item.id === selected);
  const matches = tasks.filter(item => `${item.title ?? ''} ${item.instruction}`.toLowerCase().includes(search.toLowerCase()));
  const groups = groupTasks(matches, webId, filter, Date.now() / 1000);
  const agenda = agendaTasks(matches.filter(item => filter === 'all' || (filter === 'mine' ? isMine(item, webId) : Boolean(item.assignedTo) && !isMine(item, webId))), webId, new Date());
  const pick = (item: TaskSummary) => { setSelected(item.id); setLinkedRun(undefined); setCreating(false); };
  const rows = (items: TaskSummary[]) => items.map(item => <div className={`task-row ${selected === item.id ? 'selected' : ''}`} key={item.id}>
    {isMine(item, webId) ? <Checkbox aria-label={`完成 ${item.title ?? item.instruction}`} checked={item.status === 'completed'} disabled={busy} onChange={event => void perform(() => client.update(item.id, { completed: event.target.checked }))} /> : <span aria-label={kindLabel[item.schedule?.kind ?? ''] ?? '任务'}>{item.schedule?.kind === 'event' ? 'ϟ' : item.schedule?.kind === 'interval' ? '↻' : '▦'}</span>}
    <TaskPickButton onClick={() => pick(item)} aria-current={selected === item.id ? 'true' : undefined}><strong>{item.title ?? item.instruction}</strong><small>{item.waiting ? '在等你' : item.dueAt ? time(item.dueAt) : statusLabel[item.status] ?? item.status}</small></TaskPickButton>
  </div>);
  const addTodo = (event: FormEvent) => {
    event.preventDefault(); if (!todo.trim()) return;
    void perform(async () => { const result = await client.create({ prompt: todo.trim(), kind: 'todo', workspace }); setTodo(''); pick(result.task); });
  };
  const editor = <form onSubmit={addTodo} className="task-quick-add"><span aria-hidden>＋</span><Input aria-label="添加待办" placeholder="添加待办，回车" value={todo} onChange={event => setTodo(event.target.value)} disabled={busy} /></form>;
  return <TwoPaneLayout className="tasks-panel" pageType="collection" hasObjectCollection
    listHeader={<div className="tasks-list-header"><SearchInput aria-label="搜索任务" value={search} onChange={event => setSearch(event.target.value)} /><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" aria-label="新建任务" onClick={() => { setCreating(true); setSelected(undefined); }}>＋</Button></div>}
    list={<div className="tasks-list"><PaneSelection selection={selected ?? (creating ? "create" : undefined)} />
      <div className="tasks-toolbar"><SegmentedControl className="flex-1" size="sm" ariaLabel="交给谁" value={filter} onValueChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'mine', label: '我的' }, { value: 'ai', label: 'AI 的' }] as const} /><SegmentedControl size="sm" ariaLabel="视图" value={view} onValueChange={setView} options={[{ value: 'list', icon: <ListSegmentIcon />, 'aria-label': '清单' }, { value: 'agenda', icon: <AgendaSegmentIcon />, 'aria-label': '日程' }] as const} /></div>
      <div className="tasks-scroll">
        {loading ? <p role="status">正在读取任务…</p> : <>
          {groups.waiting.length > 0 && <section><h3>在等你 <small>{groups.waiting.length}</small></h3>{rows(groups.waiting)}</section>}
          {view === 'list' ? <>
            {filter !== 'ai' && <section><h3>我的待办 <small>{groups.mine.length}</small></h3>{editor}{rows(expandedTodos ? groups.mine : groups.mine.slice(0, 5))}{groups.mine.length > 5 && <Button size="sm" variant="ghost" className="task-more h-auto min-h-9 whitespace-normal py-1" type="button" onClick={() => setExpandedTodos(!expandedTodos)}>{expandedTodos ? '收起' : `还有 ${groups.mine.length - 5} 条`}</Button>}</section>}
            {filter !== 'mine' && <details><DisclosureSummary className={interactiveFocusClass}>AI 按计划在做 <small>{groups.ai.length}</small></DisclosureSummary>{rows(groups.ai)}</details>}
            {groups.unassigned.length > 0 && <details><DisclosureSummary className={interactiveFocusClass}>未分配 <small>{groups.unassigned.length}</small></DisclosureSummary>{rows(groups.unassigned)}</details>}
            <details><DisclosureSummary className={interactiveFocusClass}>已结束 · {allEnded ? '全部' : '最近 7 天'} <small>{(allEnded ? groups.ended : groups.recent).length}</small></DisclosureSummary>{rows(allEnded ? groups.ended : groups.recent)}<Button size="sm" variant="ghost" className="task-more h-auto min-h-9 whitespace-normal py-1" type="button" onClick={() => setAllEnded(!allEnded)}>{allEnded ? '只看最近 7 天' : '查看全部已完成'}</Button></details>
          </> : Object.entries(agenda).map(([key, items]) => <section key={key}><h3>{({ overdue: '已逾期', today: '今天', tomorrow: '明天', week: '本周', later: '以后' } as Record<string, string>)[key]}</h3>{items.length ? rows(items) : <p className="task-muted">没有安排</p>}</section>)}
        </>}
      </div>
      <footer><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" disabled={busy} onClick={() => void perform(refresh)}>刷新</Button></footer>
    </div>}
    mainHeader={<div className="tasks-main-header"><TaskBackButton /><span>任务与待办</span>{headerActions}</div>}
    main={<div className="tasks-detail">
      {error && <InlineNotice className="task-notice" tone="destructive" role="alert" action={<div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={() => void perform(refresh)}>重试</Button>{onOpenConnections && <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={onOpenConnections}>检查连接与授权</Button>}</div>}><p>{/[\u4e00-\u9fff]/.test(error) ? error : '暂时无法加载任务，请检查连接后重试'}</p></InlineNotice>}
      {creating ? <TaskCreateForm key="create" supported={capabilities.createAi} busy={busy} onCancel={() => setCreating(false)} onSubmit={input => void perform(async () => { const result = await client.create({ ...input, workspace }); pick(result.task); })} /> : task ? <>
        <header><div><span className="task-eyebrow">{isMine(task, webId) ? '我的待办' : kindLabel[task.schedule?.kind ?? ''] ?? '任务'}</span><h2>{task.title ?? task.instruction}</h2></div><span className="task-badge">{statusLabel[task.status] ?? task.status}</span></header>
        <section><h3>要做什么</h3><p className="task-instruction">{task.instruction}</p></section>
        {isMine(task, webId) ? <TodoEditor key={`${task.id}:${task.updatedAt}`} task={task} busy={busy} onSave={changes => void perform(() => client.update(task.id, changes))} /> : <>
          <section><h3>什么时候</h3><p>{kindLabel[task.schedule?.kind ?? ''] ?? '未设置'} · {(task.schedule?.cron ? cronLabel(task.schedule.cron) : undefined) ?? (task.schedule?.intervalSeconds ? `每 ${task.schedule.intervalSeconds} 秒` : task.schedule?.eventName ?? '待接入')}</p><p>下次运行：{time(task.schedule?.nextRunAt)}</p></section>
          <section><h3>能动哪些资料</h3>{task.workspace ? <><p>工作空间：{task.workspace}</p><p className="task-muted">工作空间不代表授权范围。实际可读写的资料由 Pod 权限决定，逐项授权明细待接入。</p></> : <p className="task-muted">未记录工作空间，资料授权明细待接入。</p>}</section>
          <div className="task-actions"><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" disabled={busy || !['active', 'blocked'].includes(task.status) || !task.schedule} onClick={() => void perform(async () => { const result = await client.run(task.id); setRun(result.run); setRuns((await client.runs(task.id)).runs); })}>立即运行一次</Button><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" disabled={busy || isEnded(task) || !task.schedule || task.schedule.kind === 'once'} onClick={() => void perform(() => client.pause(task.id, !task.schedule?.paused))}>{task.schedule?.paused ? '恢复后续运行' : '暂停后续运行'}</Button></div>
        </>}
        <section><h3>怎么来的</h3>{safeSource(task.source) ? <a className={interactiveFocusClass} href={safeSource(task.source)} target="_blank" rel="noreferrer">查看来源对话</a> : <p className="task-muted">未记录来源</p>}</section>
        <section><h3>最近运行</h3>{runs.length ? runs.map(item => <button type="button" className={`task-run-row ${interactiveFocusClass}`} key={item.id} onClick={() => setRun(item)}><span>{time(item.createdAt)}</span><span>{statusLabel[item.status] ?? item.status}</span></button>) : <p className="task-muted">暂无运行记录</p>}</section>
        {run && <section className="task-run-detail" aria-label="运行详情"><header><h3>这次运行 · {statusLabel[run.status] ?? run.status}</h3><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={() => setRun(undefined)}>关闭</Button></header>
          {run.status === 'waiting_input' && (renderApproval ? renderApproval(run) : <p>这次运行在等你确认。继续同一次运行的确认入口待接入。</p>)}
          {run.error && <InlineNotice className="task-notice" tone="destructive" role="alert">{/[\u4e00-\u9fff]/.test(run.error) ? run.error : '本次执行未完成，请检查连接与授权后重试'}</InlineNotice>}
          <ol>{steps.map(step => <li key={step.id}><span>{time(step.createdAt)}</span> {step.message ?? step.type}</li>)}</ol>
          {run.status === 'failed' && <><p className="task-muted">以上是已记录的执行步骤；未记录的副作用无法确认。</p>{onOpenConnections && <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={onOpenConnections}>检查并修复连接</Button>}<p className="task-muted">从失败这一步继续 · 待接入</p></>}
          {['queued', 'running', 'waiting_input', 'waiting_runner'].includes(run.status) && <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" disabled={busy || Boolean(run.cancelRequestedAt)} onClick={() => void perform(async () => { const result = await client.stop(run.id); setRun(result.run); setRuns((await client.runs(task.id)).runs); })}>{run.cancelRequestedAt ? '已请求停止' : '停止这次运行'}</Button>}
        </section>}
      </> : <div className="tasks-empty"><span className="task-eyebrow">任务与待办</span><h2>把想做的事，安排好</h2><p>记下自己的待办，或让 AI 按计划完成任务。</p><p className="task-muted">从左边选择一项，查看详情和运行记录。</p></div>}
    </div>}
  />;
}
function TaskPickButton({ onClick, children, ...props }: { onClick: () => void; children: ReactNode; 'aria-current'?: 'true' }) {
  const { openMain } = useWorkspaceLayout();
  return <button className={interactiveFocusClass} type="button" {...props} onClick={() => { onClick(); openMain(); }}>{children}</button>;
}
function PaneSelection({ selection }: { selection?: string }) {
  const { openMain } = useWorkspaceLayout();
  useEffect(() => { if (selection) openMain(); }, [selection, openMain]);
  return null;
}
function TaskBackButton() {
  const { mode, openList } = useWorkspaceLayout();
  const drawer = useContext(WorkspaceDrawerContext);
  return !drawer && mode === 'stack' ? <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={openList} aria-label="返回任务清单">‹</Button> : null;
}
function TodoEditor({ task, busy, onSave }: { task: TaskSummary; busy: boolean; onSave: (changes: TodoChanges) => void }) {
  const [notes, setNotes] = useState(task.notes ?? '');
  const [priority, setPriority] = useState(task.priority ?? 'normal');
  const [due, setDue] = useState(task.dueAt ? new Date(task.dueAt * 1000 - new Date(task.dueAt * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  return <form className="task-form" onSubmit={event => { event.preventDefault(); onSave({ notes, priority, dueAt: due ? new Date(due).getTime() / 1000 : null }); }}>
    <label>截止日期<Input type="datetime-local" value={due} onChange={event => setDue(event.target.value)} /></label>
    <label>重要程度<NativeSelect value={priority} onChange={event => setPriority(event.target.value)}><option value="normal">普通</option><option value="high">重要</option><option value="urgent">紧急</option></NativeSelect></label>
    <label>备注<Textarea value={notes} onChange={event => setNotes(event.target.value)} /></label>
    <div className="task-actions"><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="submit" disabled={busy}>保存待办</Button><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" disabled={busy} onClick={() => onSave({ completed: task.status !== 'completed' })}>{task.status === 'completed' ? '重新打开' : '标记完成'}</Button></div><p className="task-muted">交给 AI 去做 · 待接入</p>
  </form>;
}
function TaskCreateForm({ supported, busy, onSubmit, onCancel }: { supported: boolean; busy: boolean; onSubmit: (input: Omit<CreateTask, 'workspace'>) => void; onCancel: () => void }) {
  const [prompt, setPrompt] = useState(''); const [kind, setKind] = useState<'cron' | 'interval' | 'event'>('cron');
  const [clock, setClock] = useState('09:00'); const [interval, setInterval] = useState(60); const [eventName, setEventName] = useState('');
  return <form className="task-form" onSubmit={event => { event.preventDefault(); onSubmit({ prompt, kind, ...(kind === 'cron' ? { cron: `${Number(clock.split(':')[1])} ${Number(clock.split(':')[0])} * * *` } : kind === 'interval' ? { intervalSeconds: interval * 60 } : { eventName }) }); }}>
    <header><h2>新建任务</h2><Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="button" onClick={onCancel}>取消</Button></header>
    <label>要做什么<Textarea required value={prompt} placeholder="例如，每天整理我关注的信息" onChange={event => setPrompt(event.target.value)} /></label>
    <fieldset><legend>什么时候</legend><SegmentedControl className="grow" size="sm" ariaLabel="什么时候" value={kind} onValueChange={setKind} options={[{ value: 'cron', label: kindLabel.cron }, { value: 'interval', label: kindLabel.interval }, { value: 'event', label: kindLabel.event }] as const} /></fieldset>
    {kind === 'cron' ? <label>每天几点<Input type="time" required value={clock} onChange={event => setClock(event.target.value)} /><small>按执行环境的时区安排。</small></label> : kind === 'interval' ? <label>每隔多少分钟<Input type="number" min="1" required value={interval} onChange={event => setInterval(Number(event.target.value))} /></label> : <label>事件名称<Input required value={eventName} onChange={event => setEventName(event.target.value)} /></label>}
    {!supported && <InlineNotice tone="info" role="status">代理执行身份待接入。你可以先在清单中添加自己的待办。</InlineNotice>}
    <Button size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal py-1" type="submit" disabled={busy || !supported || !prompt.trim()}>创建任务</Button>
  </form>;
}
const segmentIconProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
function ListSegmentIcon() { return <svg {...segmentIconProps}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>; }
function AgendaSegmentIcon() { return <svg {...segmentIconProps}><path d="M4 5h16v15H4zM4 10h16M8 3v4M16 3v4" /></svg>; }
