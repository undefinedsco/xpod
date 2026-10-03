# Real Task approval acceptance

The production Pi runtime registers `request_approval` through the SDK's custom-tool interface. Its fields are `target` (current Pod HTTP resource IRI), `action` (policy action IRI), `risk` (`low`, `medium`, or `high`) and `description`. It asks for a human decision and does not perform the requested action. Existing read/bash/edit/write permissions are unchanged.

1. Sign in to the actual Gateway. Configure the provider, credential and selected model through the normal AI Connections Pod store. Grant background task access through `/api/ai/task-credentials` using the current account credential; never put a key in the prompt.
2. Prepare an isolated workspace container in that Pod, with a non-RDF seed file. The runner needs its normal `CSS_BASE_URL` / `CSS_ROOT_FILE_PATH` mapping; an unavailable mount must report `waiting_runner`.
3. Create an interval task and pause future scheduling before manually running it. Ask the model to call `request_approval` before writing `approval-marker.txt`, with target equal to that file's Pod IRI and action `http://www.w3.org/ns/odrl/2/write`. Tell it to write a unique harmless marker and report completion only after approval.
4. Run via `POST /api/tasks/run?id=<task-id>`. Verify the real model invoked the tool, the Run is `waiting_input`, and no marker exists. Inspect the Pod's pending Approval: its `thread` and `toolCallId` must match the Run and `metadata.waitingTool`; `assignedTo` is the current owner, `expiresAt` is present, and `session` points to a real paused Session resource, not a Thread used as a Session.
5. Decide using the shared approval UI or `decideApprovalRequest` (the same models CAS contract). Call `POST /api/tasks/resume?id=<run-id-or-IRI>` with `{ "approval": "<approval-IRI>" }`. Verify the Run id is unchanged, a continuation audit exists, the real provider completes, and an authenticated Pod GET returns the expected marker. The Session returns to active and then completed. The decision is human input, not a fabricated tool-execution result.
6. Repeat the resume request: it must return a duplicate without executing the action again. A separate rejected request must cancel the waiting Run and leave the requested marker absent.

Record Gateway origin, Task/Run/Approval/Session IRIs, actual tool-call id, state transitions, non-secret response statuses and marker readback. Artificial checkpoints and mocked model output only validate adapters; they do not satisfy this real producer-to-decision acceptance.

Pi sends its actual `Xpod/<version>` user agent and a stable thread-derived session identifier to the Gateway through the SDK model header contract. It does not impersonate another client or put provider secrets in those headers.
