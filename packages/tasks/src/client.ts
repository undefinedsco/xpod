/** HTTP projections of shared Pod resources. Timestamps are Unix seconds. */
export interface TaskSummary {
  id: string; iri?: string; title?: string; instruction: string; assignedTo?: string; source?: string;
  status: string; waiting?: boolean; dueAt?: number; completedAt?: number; notes?: string; priority?: string;
  createdAt: number; updatedAt: number;
  schedule?: { kind: 'once' | 'cron' | 'interval' | 'event'; cron?: string; intervalSeconds?: number;
    eventName?: string; nextRunAt?: number; paused: boolean };
}
export interface TaskRun { id: string; thread?: string; waitingToolCallId?: string; status: string; error?: string; createdAt: number; completedAt?: number; cancelRequestedAt?: number }
export interface TaskStep { id: string; type: string; message?: string; createdAt: number }
export interface TaskCapabilities { createAi: boolean; resumeStep: boolean; handoff: boolean; approve: boolean }
export interface CreateTask {
  prompt: string; workspace: string; source?: string; kind: 'todo' | 'cron' | 'interval' | 'event';
  cron?: string; intervalSeconds?: number; eventName?: string; dueAt?: number;
}
export interface TodoChanges { completed?: boolean; dueAt?: number | null; notes?: string; priority?: string }
export interface TasksClient {
  resumeRun(id: string, approval: string): Promise<{ run: TaskRun; resumed: boolean; duplicate?: boolean }>;
  selection(id: string): Promise<{ taskId: string; run: TaskRun }>;
  list(): Promise<{ tasks: TaskSummary[]; capabilities: TaskCapabilities }>;
  create(input: CreateTask): Promise<{ task: TaskSummary }>;
  update(id: string, input: TodoChanges): Promise<{ task: TaskSummary }>;
  pause(id: string, paused: boolean): Promise<{ task: TaskSummary }>;
  run(id: string): Promise<{ task: TaskSummary; run: TaskRun }>;
  runs(id: string): Promise<{ runs: TaskRun[] }>;
  steps(id: string): Promise<{ steps: TaskStep[] }>;
  stop(id: string): Promise<{ run: TaskRun }>;
}
export function createTasksClient(options: { fetch: typeof fetch; baseUrl?: string }): TasksClient {
  const request = async <T>(path: string, method = 'GET', input?: unknown, id?: string): Promise<T> => {
    const response = await options.fetch(`${(options.baseUrl ?? '').replace(/\/$/, '')}/api/tasks${path}${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method, headers: input === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new Error(response.status === 401 ? '登录已失效，请重新登录' : response.status === 403 ? '暂时无法访问任务，请检查连接与授权' : response.status >= 500 ? '任务服务暂时不可用，请稍后重试' : error?.error && /[\u4e00-\u9fff]/.test(error.error) ? error.error : '任务操作未完成，请检查输入后重试');
    }
    return response.json() as Promise<T>;
  };
  return {
    resumeRun: (id, approval) => request('/resume', 'POST', { approval }, id),
    selection: id => request('/selection', 'GET', undefined, id),
    list: () => request(''), create: input => request('', 'POST', input),
    update: (id, input) => request('', 'PATCH', input, id), pause: (id, paused) => request('/pause', 'POST', { paused }, id),
    run: id => request('/run', 'POST', {}, id), runs: id => request('/runs', 'GET', undefined, id),
    steps: id => request('/steps', 'GET', undefined, id), stop: id => request('/stop', 'POST', {}, id),
  };
}
