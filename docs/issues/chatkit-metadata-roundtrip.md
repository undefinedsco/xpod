# ChatKit message metadata is corrupted by the direct PATCH bypass

## Status

Fixed in `src/api/chatkit/pod-store.ts` — `directPatchMessage` is removed and
`saveItem` updates messages through `updateConditionalResource` with the real installed ORM
INSERT serializer. The consumer-side duplicate-resume workaround (binding the checkpoint to
the Run via `run.metadata.waitingTool`) is retained as defense in depth. See the live
producer evidence below.

## Live verification

Real Standalone default-inline canonical producer `meta-fix-inline-a`: the `approved` case
passed end to end — `queuedAck`, `approvalPending`, `sessionPaused`, decision approved,
`sameRun=true`, run `completed`, Session `completed`, exact Pod HTTP marker
`markerMatches=true`, `duplicateResume=true`, `stableAfterDuplicateOrStop=true`. The
subsequent `rejected` case failed at checkpoint retrieval with a gateway request
`TimeoutError`. The persisted run was `waiting_input` with a pending Approval and a
matching `waitingTool` receipt, but that does not establish the cause of the request stall.
Concurrent host load was observed; transport diagnosis and a complete producer rerun are
still required. Socket/spawn producer also remains unverified.

## Observed on the real Standalone Gateway

On the real Standalone Gateway (`podproj-inline-d`, models 0.2.x, drizzle-solid 0.3.25),
the completed `client_tool_call` message in
`a-standalone-…/.data/task/task_…/2026/10/02/messages.ttl` was written as:

```
<…/messages.ttl#client-tool_call_mur6…> <https://undefineds.co/ns#metadata>
  "{\"@id\":\"…/metadata-1\",\"id\":\"…/metadata-1\",\"arguments\":\"{\"action\":\"…\"}\",
   \"assistantItemId\":\"…\",\"protocols\":{…},\"reconcilerOwner\":\"client\",
   \"runId\":\"task/…/runs.ttl#run_…\",\"approval\":\"…\",\"output\":\"{\"kind\":\"approval_decision\",…}\"}" .
```

Two defects are visible in that single triple:

1. **The literal is not valid JSON.** `arguments`, `protocols` and `output` are objects /
   JSON-encoded strings nested inside the metadata object. When they are stringified into
   the outer JSON, their own double quotes are escaped; the bypass then emits the whole
   thing as a Turtle `"…"` literal without escaping the backslashes. After the standard
   Turtle unescape (`\X` → `X`) the result is no longer parseable JSON
   (`JSON.parse` fails at position 274 — verified with a bounded local check).
2. **The child metadata node is stale.** The message still points at
   `…/messages.ttl#…/metadata-1` (the ORM inline-object child) via `ns#metadata`, but that
   child only carries the *original* `protocols`/`reconcilerOwner`. The updated key/value
   pairs (`runId`, `approval`, `output`, `arguments`, `assistantItemId`) exist **only** in
   the flat literal. Any reader that follows the RDF child node sees the old shape; the
   "authoritative" flat literal is unparseable. So `metadata.runId` is lost on reload.

The direct consequence: `TaskService.resumeApprovedRun` could not find the completed
checkpoint, threw `Approval does not match the pending tool checkpoint`, and the second
identical `POST /api/tasks/resume` returned HTTP 400. First resume and exact marker were
correct (`markerMatches=true`), so the defect is persistence round-trip only.

## Root cause

`PodChatKitStore.saveItem` routes every message update to `directPatchMessage`, a
hand-rolled SPARQL UPDATE that:

- serializes `metadata` with `escapeForSparql(JSON.stringify(metadata))` into a **flat
  literal** on the message subject, and
- deletes only `<message> ns#metadata ?oldMetadata`, never the inline child node's
  properties, and never updates the `<message> ns#metadata <child>` link.

This bypass exists to work around a historical drizzle-solid `UPDATE` bug
(`避免 drizzle-solid UPDATE 的 bug`, pod-store.ts:1811/1839). The current drizzle-solid
0.3.25 serializer handles inline `object` columns correctly: `buildUpdatePartsForRecord`
(in `@undefineds.co/drizzle-solid` `sparql/builder/update-builder.js`) emits, for an
`object`/inline column, a DELETE of both the link triple **and** the child node's
`?p ?o` properties (via variables) followed by an INSERT of the freshly built nested
child triples from the real value. That is the RDF-correct update and it round-trips.

## Ownership and boundary

- Owner: this issue, i.e. `src/api/chatkit/pod-store.ts` (`directPatchMessage` /
  `saveItem`) and its persistence tests.
- Do **not** change `@undefineds.co/models` schema (`messageResource.metadata` is
  `object('metadata')`) or drizzle-solid; no new dependencies.
- Prefer deleting the bypass and using the existing drizzle-solid exact/update path
  (`db.updateById(Message, …)`), with the existing strong-ETag conditional serializer
  (`updateConditionalResource` in `src/api/runs/ConditionalResourceDocument.ts`) if an
  exact conditional write is required for concurrency. Do not add a second manual
  escaping implementation.
- If drizzle-solid cannot safely express the existing metadata update, record the exact
  limitation here **before** reusing a bounded existing bypass.

## Required regression

A real serialize → parse → reload regression that goes through the store's public
`saveItem`/`loadThreadItems` (or the ORM serializer) and asserts the metadata survives
including nested quotes, backslashes, newlines, and tool output, with original
`call_id`/`output`/`status` preserved. In-memory deletion of `runId` alone does not prove
the serializer is fixed.

## Non-goals

No schema/content ownership duplication; no auth/CAS relaxation; no change to
SolidFS/native/EmbeddedInngestService/static/dist/workflows.
