# Reconciler / Wake / Agent Runtime Boundary

Date: 2026-06-14

## Decision

ChatKit and Matrix are API shapes. They are not the execution kernel and they do
not own multi-agent routing.

The durable model stays human-transaction oriented:

```text
Chat / Thread / Message / Run / RunStep
```

`Session.sessionType` is not part of this model anymore. Treat any existing
value as legacy compatibility metadata only; direct/group topology and
Reconciler ownership are derived from `Chat`/`Thread`, participants, and product
policy.

Protocol adapters map external requests into this model:

```text
ChatKit request ┐
Matrix request  ├─> append Message/Thread facts -> ReconcilerService -> WakeAgentJob -> Agent Runtime
other adapters ┘
```

`ReconcilerService` is the shared decision point for “should an agent be woken
for this newly appended thread event?”. `Wake` only wakes the selected agent(s).
`Agent Runtime` owns all model/provider/tool/workspace execution details.

## Responsibilities

### Protocol adapters: ChatKit / Matrix

Adapters are ingress/egress surfaces only.

They may:

- validate protocol-shaped requests;
- authenticate the caller through the existing API auth path;
- map request bodies into `Chat`, `Thread`, `Message`, and namespaced protocol
  metadata under `metadata.protocols.<apiNs>`;
- call the message append path that triggers reconciliation;
- project stored messages back into Matrix/ChatKit response shapes.

They must not:

- create Matrix- or ChatKit-specific durable data directories such as `/.data/matrix`;
- promote opaque protocol ids such as Matrix `room_id` / `event_id` / `txn_id`
  or ChatKit `chat_id` / `thread_id` into shared schema fields unless the id
  has become a cross-client query, dedupe, audit, recovery, or protocol-contract
  fact;
- decide which Agent should answer;
- encode Agent Runtime provider, model, workspace, or tool placement policy;
- hard-code a primary agent in protocol store code.

### ReconcilerService

`ReconcilerService` is protocol-independent and model-facing.

It answers only:

1. should any Agent respond;
2. which Agent URI(s) should be woken;
3. why the wake happened.

It produces minimal wake jobs and persists/enqueues them through the configured
state backend.

It must not decide:

- which LLM provider/model/API key to use;
- whether the LLM call runs in a user client, server worker, or local runtime;
- where tools execute;
- which workspace runner is used;
- prompt/tool capability details.

Those decisions belong to Agent Runtime after it owns the wake job.

### Wake

`Wake` is a routing signal, not an execution plan.

Minimal wake job shape:

```ts
type WakeAgentJob = {
  id: string
  thread: string
  triggerMessage: string
  agent: string
  reason: 'mention' | 'reconciler_decision' | 'manual'
  status: 'queued' | 'leased' | 'completed' | 'failed'
  createdAt: string
}
```

Optional operational fields may be added when the queue implementation needs
them:

```ts
type WakeAgentJobLeaseFields = {
  priority?: 'low' | 'normal' | 'high'
  leaseOwner?: string
  leaseExpiresAt?: string
}
```

Do not put `agentRole`, model/provider config, workspace path, tool target,
prompt hints, or protocol event shapes on the wake job. The job names one agent
and one triggering message in one thread.

Queue key:

```text
steer_queue:{thread}:{agent}
```

Each coordinated thread and each agent has an independent queue. One agent processes
one queued wake at a time; excess wake jobs remain in that agent's queue. A
single message may wake multiple agents concurrently, but each target agent is
serialized by its own queue.

### Agent Runtime

Agent Runtime consumes `WakeAgentJob` and owns execution.

It should:

- load `agent` and resolve the Agent configuration;
- load `thread` and `triggerMessage` context;
- choose where the LLM call runs;
- choose where tools run;
- create `Run` / `RunStep` state for execution;
- append assistant `Message` output to the same durable thread;
- mark the wake job completed or failed.

Agent Runtime may run server-side, client-side, local CLI-side, or through a
workspace runner. That placement is intentionally not encoded in `Wake`.

## Trigger policy

The default trigger policy is conservative:

- writes through homeserver/xpod API append paths trigger `ReconcilerService`;
- direct Pod writes by unrelated apps do not automatically spend Agent/LLM
  budget unless the room/thread policy explicitly grants that app or actor the
  right to trigger reconciliation;
- direct Pod writes may still be observed and surfaced as candidate events for
  later reconciliation.

Pod write permission is not the same as permission to trigger AI execution.

This avoids an external app causing duplicate or unexpected Agent runs just by
writing a compatible message resource.

## LinX CLI Reconciler relationship

LinX CLI already has a Reconciler in
`linx-cli/packages/agent-runtime/src/reconciler.ts`. It is useful prior art, but
it should not be merged into xpod as a server-only class. CLI is not a
multi-human group-chat surface: it owns single-human threads such as private AI
chat, automode, and Symphony. Those threads may have multiple Agent/runtime
participants, but only one human authority.

The right merge is at the contract/core boundary:

```text
shared Reconciler core/contract
  ├─ xpod / homeserver host adapter
  └─ LinX CLI host adapter
```

The shared part should be portable and mostly pure:

```ts
type ReconcilerInput = {
  thread: string
  triggerMessage: string
  actor?: string
  content?: string
  mentions?: string[]
  routeTargetAgent?: string
  policy: ReconcilerPolicy
}

type ReconcilerOutput = {
  wakeJobs: WakeAgentJob[]
  skippedReason?: string
}
```

Host-specific adapters provide persistence, leases, Redis queues, local queues,
client focus state, notifications, and runtime handoff.

### Product coordination rule

Keep the product rule simple: client-owned conversations are client-side;
multi-human group conversations are server-side.

| Conversation kind | Reconciler owner | Runtime / LLM owner | Rule |
| --- | --- | --- | --- |
| Direct/private AI chat | client side | client side preferred | CLI, desktop, native app, or foreground web may coordinate. If no client is alive, auto work waits. |
| CLI automode / Symphony | CLI side | CLI/local runtime | Still a direct single-human control thread, even if it has secretary/worker/reviewer agents. |
| Multi-human group room | server/homeserver | client side preferred, server only by explicit policy | Server decides which Agent(s) to wake; clients do not make group routing decisions. |

This is the default mental model. Do not expose "client/server/lease" as a
protocol distinction. The API surface can still be Matrix/ChatKit/Responses
shaped; durable data remains Chat/Thread/Message shaped.

Web clients must not infer this from route names, UI placement, protocol shape,
or participant counting. The server/store exposes only the operational
coordination owner in thread/chat projection. ChatKit threads carry the field
in thread metadata; Matrix sync uses the `co.undefineds.coordination` room
extension.

```ts
type ReconcilerOwner = 'client' | 'server'
```

Mapping rule:

```text
single-human authority / client-owned policy -> reconcilerOwner = client
multi-human authority / open-group policy    -> reconcilerOwner = server
```

This owner is runtime coordination metadata. It is not a durable conversation
topology field and should not be copied into `Session.sessionType`, `Chat.type`,
`chatKind`, or `conversationKind`. Matrix `is_direct` is ignored by this
adapter.

Do not collapse product facts into this owner:

- privacy / visibility is an access and policy fact. Matrix `visibility` may stay
  as protocol metadata; Solid ACL / product policy remains the authority for
  actual access. It is not Reconciler ownership.
- group is modeled through the human transaction graph: a group Contact
  (`ContactClass.GROUP` / `ContactType.GROUP`) and/or `Chat.participants`.
  It is not a Thread enum.
- `reconcilerOwner` is derived runtime coordination output: which side is
  allowed to run Reconciler for this Thread now.

Adapter defaults:

- CLI private chat, automode, and Symphony use `reconcilerOwner = client`.
- ChatKit/Responses private chat uses `reconcilerOwner = client` unless product
  policy explicitly says the thread is server-owned.
- Matrix rooms use `reconcilerOwner = server` by default. `is_direct` is not
  persisted and does not switch owner in this adapter.
- Group creation APIs must set `reconcilerOwner = server` explicitly.

Implementation still needs one hidden invariant: each coordinated thread has at
most one active Reconciler owner. For client-owned threads that owner is one of
the user's clients. For server-owned rooms it is the server.

### Client-owned conversations

A client-owned thread is owned by one human authority. CLI, desktop app,
native app, and foreground web can share the same thread, but only one client at
a time runs `ReconcilerCore`.

Server responsibilities for client-owned threads:

- store messages and thread state;
- sync messages across the user's clients;
- keep the lightweight coordinator lease/fencing state;
- dedupe wake insertion on `(thread, triggerMessage, agent)`.

Server does not normally run client-owned reconciliation and does not normally
run the LLM. If all clients are offline, auto work waits until an eligible client
returns, unless the user explicitly enables a server-side fallback policy.


### Same client-owned thread on web, CLI, desktop, and mobile

A client-owned thread may be open on several clients at the same time. They all
share one durable `Thread` and one message timeline. They do not each run an
independent Reconciler.

Separate four locations:

| Concern | Where it lives | Selection rule |
| --- | --- | --- |
| Agent Profile | Pod/shared model as `agent` | Durable identity/config. It is not tied to one process. |
| Reconciler coordinator | One active client for the client-owned thread | Lease/fencing picks one client. Prefer CLI/desktop, then capable native app, then foreground web. |
| Agent Runtime | One capable runtime consumes each wake | Chosen by agent/workspace/tool capability. Usually CLI/desktop for tool-heavy work; web only for browser-safe work. |
| Workspace | The referenced workspace resource/location | Execution should run near the workspace owner: local file workspace on CLI/desktop, Pod/SolidFS workspace via capable runtime, cloud workspace only by policy. |

Example with web, CLI, desktop, and mobile open:

```text
1. Web sends a user message into the client-owned Thread.
2. Server stores/syncs the Message but does not reconcile by default.
3. The current client-owned-thread coordinator, e.g. desktop or CLI, sees the new
   Message and runs ReconcilerCore.
4. ReconcilerCore creates an idempotent WakeAgentJob for agent.
5. A capable Agent Runtime consumes the wake. If the workspace is local to CLI,
   CLI should run it; if desktop owns the workspace, desktop should run it; if
   only foreground web is available, web may run only browser-safe work.
6. The runtime appends the assistant Message.
7. Web, CLI, desktop, and mobile all receive the same final Message via sync.
```

If the coordinator and runtime are the same client, that is an optimization, not
a requirement. A desktop client may coordinate while a CLI runtime executes
because the CLI owns the workspace.

If no capable runtime is online, the wake remains queued. The server should not
move execution to itself unless client-owned-thread policy explicitly allows server
runtime fallback.

Hidden implementation state can be a small client capability/presence record:

```ts
type ClientCapability = {
  clientId: string
  kind: 'cli' | 'desktop' | 'mobile' | 'web'
  user: string
  canCoordinateClientOwnedThread: boolean
  canRunAgent: boolean
  workspaces: string[]
  heartbeatAt: string
}
```

This record is operational state, not the durable conversation model. Durable conversation semantics remain `Thread`, `Message`, `agent`, and
`workspace` relations. Coordination owner is operational metadata, not a second
durable topology field.


### Pod-center activation for client-owned Reconciler

Yes: client-owned chat should support Reconciler-capable logic on multiple
clients, but the Pod center/homeserver activates only one coordinator per
client-owned thread at a time.

The center is an activation arbiter, not the client-owned-thread Reconciler by
default.

```text
all capable clients: contain ReconcilerCore
Pod center: grants one active coordinator lease
active client: runs ReconcilerCore and creates WakeAgentJob
other clients: sync, render, maybe run Agent Runtime for assigned wake
```

The center chooses the active client-owned-thread coordinator from client presence and
capabilities, for example:

1. client is the same user who owns the client-owned thread;
2. client is online and heartbeating;
3. client declares `canCoordinateClientOwnedThread`;
4. prefer stable processes: CLI/desktop > capable native app > foreground web;
5. current lease holder remains active until heartbeat expires or it releases
   voluntarily.

Operational state can live in Redis/Postgres/in-memory cluster state, depending
on deployment. It should not be modeled as durable human conversation data. The
durable data remains the `Thread`, `Message`, `agent`, `workspace`, and final
assistant output.

Minimal operational record:

```ts
type ClientReconcilerLease = {
  thread: string
  ownerClientId: string
  ownerUser: string
  fencingToken: string
  expiresAt: string
}
```

Client behavior:

- if this client owns the lease, it runs ReconcilerCore for new client-owned-thread
  messages;
- if this client does not own the lease, it must not reconcile that thread;
- if the owner sleeps, the lease expires and another capable client may become
  active;
- every wake insert remains idempotent on `(thread, triggerMessage,
  agent)` so a stale client cannot duplicate work after resume.

Current xpod API surface is intentionally small and operational:

```text
POST /v1/clients/heartbeat
POST /v1/threads/coordination/lease
POST /v1/threads/coordination/lease/release
```

These endpoints only publish client capability/presence and grant/release the
client-owned-thread coordinator lease. They are not a Reconciler business API: clients
still send/sync messages through ChatKit/Matrix/Responses-shaped APIs, and the
Pod does not gain a durable `Reconciler` resource. The lease backend may be
Redis for multi-process deployments or in-memory for a single local process.

Only if client-owned-thread policy explicitly enables server fallback may the center
run ReconcilerCore itself. Otherwise, no active client means client-owned auto work
waits.

### Web in client-owned conversations

Web can enable auto mode. The distinction is:

```text
enable auto mode = write/update policy
run auto mode    = hold the client coordinator role and execute runtime work
```

A foreground web tab may run client-owned auto mode while it is visible and
heartbeating. Background, suspended, or closed web tabs are not reliable workers.
When the tab stops heartbeating, its hidden coordinator role expires and work
waits for another eligible client such as CLI, desktop, native app, or a new
foreground web tab.

Preferred client-owned client order:

1. CLI or desktop app;
2. native app with active execution grant;
3. foreground web tab;
4. no client: wait.

### Multi-human group conversations

Group rooms are server-coordinated. This avoids duplicate decisions across users
and devices.

Server responsibilities for group rooms:

- observe appended group messages;
- decide whether any Agent should respond;
- choose the Agent URI(s) to wake;
- enqueue minimal `WakeAgentJob` records;
- dedupe wake insertion.

Client responsibilities for group rooms:

- sync and render messages;
- let users configure whether their Agent participates;
- optionally consume wake jobs and run that user's Agent Runtime when active and
authorized;
- append assistant output as normal `Message` facts.

A client, including web, does not decide group routing. It may execute a queued
wake that the server already decided.

### Traffic placement

The split above does not force LLM traffic through the server.

For group rooms the server can stay thin:

```text
server: append group message -> decide WakeAgentJob -> enqueue tiny wake
client/CLI/app/web: consume wake -> call LLM with user credentials -> write assistant Message
```

Wake jobs carry references, not expanded prompts:

```text
thread + triggerMessage + agent
```

The expensive traffic remains at the runtime side: LLM request/response, context
fetching, workspace/tool reads and writes, and optional streaming. Final durable
assistant output is still appended once as a `Message` and synchronized normally.

### Hidden lease/fallback mechanics

Lease, heartbeat, fencing token, and fallback are implementation mechanics, not
product-level modes.

Minimum mechanics:

- client-owned thread: one eligible client owns the coordinator lease;
- group room: server owns coordination;
- coordinator decisions are idempotent by `(thread, triggerMessage, agent)`;
- a stale client must observe a newer fencing token before making decisions;
- server-side LLM fallback is off unless user/room/agent policy explicitly turns
  it on.

Future distributed group coordination can reuse the same lease/fencing mechanics,
but it is not part of the MVP rule.

### What to reuse from LinX CLI

Reuse:

- the idea of a pure `reconcileThreadEvent(...)` function;
- policy-driven target selection;
- wake job scheduling/dedupe as implementation reference.

Do not copy directly into the shared contract:

- `targetRole` / Agent role routing as required wake fields;
- client focus state as a core decision input;
- notification/inbox side effects as part of the wake job;
- Symphony-specific control resource semantics.

Those are valid host/product extensions, not the common message-room contract.

## MVP scope

For the current messaging MVP:

- no AI execution is required;
- no central Agent is required;
- Matrix/ChatKit only need to store and sync human messages;
- the Reconciler boundary should be documented and kept out of protocol stores
  until the Agent MVP starts.

For the first Agent MVP:

- one user message may wake multiple agents;
- execution is one round only;
- agents cannot trigger other agents;
- each `(thread, agent)` queue is serialized;
- Redis can be used as the wake/steer queue state center, while Mongo/Pod stores
  the durable message/run state.
