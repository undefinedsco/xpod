# Tasks applet implementation plan

1. Extend the authoritative models Task contract in its isolated worktree with dueAt, notes and completedAt, including descriptor alignment tests. Keep scheduling and runner selection out of Task schema.
2. Reuse TaskService and PodChatKitStore for task intent and runtime projection. Add authenticated public list/create/update/run routes; reads remain Pod backed. Preserve existing runtime configuration in its single compatibility adapter.
3. Export a shared TasksPanel and typed HTTP client. Implement assignee filters, bounded todo list, waiting/completed groups, agenda, task/run detail, creation and distinct controls. Unsupported step-level retry/handoff capabilities say 待接入.
4. Verify the model contract, service/handler behaviors, list grouping and package typecheck. Report integration wiring to the host owner.

## Verification evidence

- Authoritative models build and 63 schema/descriptor/resource tests passed.
- Shared package build and 8 UI/grouping/transport tests passed.
- Public handler, task service, cron, original materialization, grouping/client: 21 tests passed before adding the cancellation runtime follow-up.
- Shared cancellation + original RunHandler + TaskTodo (including silent-runtime cancellation): 13 tests passed.
- Root TypeScript and test TypeScript checks passed at the pre-final runtime fixture checkpoint; host owner runs final integrated gates.
- Runtime contract follow-up updates the Pi test fixture with the real SDK abort API and verifies rollback on abort. Re-run after the root dependency patch install settles.
