import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { runResource, threadResource } from '@undefineds.co/models';
import { TasksPanel } from '@undefineds.co/tasks';
import '@undefineds.co/tasks/style.css';
import { createXpodTasksClient } from '../../api/tasks';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';
import { ApprovalCard, ShellDecisionFeedback, ShellHeaderControls } from '../../shell/ShellHeaderControls';
import { useShellState } from '../../shell/useShellState';
import { selectRunApproval } from './select-run-approval';

export default function TasksPage() {
  const runtime = useXpodSolidRuntime();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shell = useShellState();
  const client = useMemo(() => {
    const tasks = createXpodTasksClient({ fetch: runtime.fetch, baseUrl: window.location.origin, database: runtime.currentPod?.database });
    return { ...tasks, stop: async (id: string) => {
      const result = await tasks.stop(id);
      window.dispatchEvent(new Event('xpod:pod-changed'));
      return result;
    } };
  }, [runtime.fetch, runtime.currentPod?.database]);
  const requestedApprovalId = params.get('approval');
  return <TasksPanel key={`${runtime.webId}:${runtime.currentPod?.podUrl}`} client={client} webId={runtime.webId!}
    workspace={runtime.currentPod!.podUrl} selectedTaskId={params.get('task') ?? undefined} selectedRunId={params.get('run') ?? undefined}
    onOpenConnections={() => navigate('/ai-connections')} headerActions={<ShellHeaderControls />}
    renderApproval={(run) => {
      const canonicalRunId = runtime.currentPod!.database.resolveResourceIri(runResource, run.id);
      const canonicalThread = run.thread ? runtime.currentPod!.database.resolveRelationIri(threadResource, run.thread) : undefined;
      const request = selectRunApproval(shell.snapshot.attention, { ...run, id: canonicalRunId, thread: canonicalThread }, requestedApprovalId);
      const recovery = shell.snapshot.attention.some(item => item.id === canonicalRunId && item.resumeApproval);
      return <>{request ? <ApprovalCard item={request} /> : !recovery && <p className="text-sm text-muted-foreground">这次运行在等你确认，暂未收到对应的申请。</p>}<ShellDecisionFeedback run={canonicalRunId} /></>;
    }} />;
}
