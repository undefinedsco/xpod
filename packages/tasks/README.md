# Shared task applet

`@undefineds.co/tasks` exports `TasksPanel`, `createTasksClient`, and typed Pod API projections. Hosts supply their authenticated fetch, WebID, workspace, header controls, and optional approval renderer. Import `@undefineds.co/tasks/style.css` once. The body uses the SDK `TwoPaneLayout`; Xpod's drawer comes from its host context, while other hosts retain the SDK's standard stack navigation.

```tsx
<TasksPanel client={client} webId={session.webId} workspace={podUrl}
  selectedTaskId={searchParams.get('task') ?? undefined}
  selectedRunId={searchParams.get('run') ?? undefined}
  headerActions={headerControls}
  renderApproval={renderSelectedApproval}
  onOpenConnections={() => navigate('/ai')}
/>
```

The API adapter registers `registerTaskRoutes` with the existing `TaskService` and Pod-backed `RunStore`. AI creation additionally resolves an explicitly granted task-layer credential using `createGrantedTaskAgentResolver`; execution restores that grant via `TaskAuthBindingService.resolveRunContext`. Neither path copies the current browser bearer credential. Task ownership comes from the authenticated caller, and the `assignedTo` resource differentiates a personal todo from the program-declared default agent. DTOs omit runner, authBinding and metadata.

Durable todo deadline, notes and completion time are authoritative models fields (`dueAt`, `notes`, `completedAt`), with the models worktree change applied by the root dependency patch. Source is the existing shared `Task.source` URI. Existing Xpod runtime configuration remains in the single `PodChatKitStore` metadata compatibility adapter until the scheduler migrates to shared Schedule/AutomationRule resources; no new schema or registry is copied into this package.

The list and run details read Pod Task/Run/RunStep, never Inngest. Five-field numeric cron supports lists, ranges and steps and uses the execution environment's local timezone. Manual execution preserves the next scheduled time and paused state. Its API returns the persisted queued Run while the existing runner continues in the background; clients read Run/RunStep for progress and completion. Cancelling a queued or waiting run terminates it immediately; an active run receives a cancellation request and its runtime abort signal. The UI distinguishes stop-current-run from pause-future-runs.

Step-level retry, delegate-todo-to-AI, and authorization-scope editing remain explicitly unavailable. Approval decisions are rendered by the host's shared approval card; after the decision is persisted, `resumeRun(runId, approvalIri)` verifies owner, thread and tool-call checkpoint and restores the granted credential to continue the same run. Repeating the decision does not execute twice. A rejection terminates the waiting run without executing the tool. The continuation explicitly carries authorization, not a fabricated action result. Missing completion timestamps are not fabricated from updatedAt. AI-created task notification delivery remains a host integration responsibility.
