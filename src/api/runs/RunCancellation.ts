import { generateId, nowTimestamp } from '../chatkit/types';
import { generateRunStepResourceId, type RunRecordData, type RunStore } from './store';
import { updateRunApprovalSession, type RunApprovalStore } from './RunApproval';

/** Keep a silent provider/tool execution connected to the durable Stop request. */
export async function monitorRunCancellation<TContext>(input: {
  store: Pick<RunStore<TContext>, 'loadRun'>; runId: string; context: TContext;
}): Promise<{
  signal: AbortSignal;
  readonly error: unknown;
  readonly cancelRequestedAt: number | undefined;
  dispose(): void;
}> {
  const controller = new AbortController();
  let error: unknown;
  let cancelRequestedAt: number | undefined;
  let stopped = false;
  let checking = false;
  const check = async (): Promise<void> => {
    if (stopped || checking || controller.signal.aborted) return;
    checking = true;
    try {
      const latest = await input.store.loadRun(input.runId, input.context);
      if (!stopped && latest.cancelRequestedAt) {
        cancelRequestedAt = latest.cancelRequestedAt;
        controller.abort();
      }
    } catch (cause) {
      if (!stopped) { error = cause; controller.abort(cause); }
    } finally { checking = false; }
  };
  await check();
  const timer = controller.signal.aborted ? undefined : setInterval(() => { void check(); }, 500);
  return {
    signal: controller.signal,
    get error() { return error; },
    get cancelRequestedAt() { return cancelRequestedAt; },
    dispose() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      controller.abort();
    },
  };
}

/** Waiting runs have no claimant; cancelling them must reach a terminal state here. */
export async function cancelRun<TContext>(input: {
  store: RunStore<TContext> & RunApprovalStore<TContext>; runId: string; context: TContext;
  resourceIri: (run: RunRecordData) => string;
}): Promise<RunRecordData> {
  const { store, runId, context } = input;
  const run = await store.loadRun(runId, context);
  if (!['queued', 'running', 'waiting_input', 'waiting_runner'].includes(run.status)) {
    if (run.status === 'cancelled') await updateRunApprovalSession(store, run, 'completed', context);
    return run;
  }
  const now = nowTimestamp();
  const firstRequest = !run.cancelRequestedAt;
  const terminal = run.status !== 'running';
  run.cancelRequestedAt ??= now;
  run.updatedAt = now;
  if (terminal) {
    run.status = 'cancelled'; run.completedAt = now;
    run.leaseOwner = undefined; run.leaseExpiresAt = undefined;
  }
  await store.saveRun(run, context);
  const append = async (type: string, message: string) => store.appendRunStep({
    id: generateRunStepResourceId({ key: generateId('run-step'), runId, createdAt: now }),
    runId, run: input.resourceIri(run), type, message, data: { status: run.status }, createdAt: now,
  }, context);
  if (firstRequest) await append('run.cancel_requested', 'Run cancellation requested');
  if (terminal) await append('run.cancelled', 'Run cancelled while waiting for execution or input');
  if (terminal) await updateRunApprovalSession(store, run, 'completed', context);
  return run;
}
