# Drizzle inline object nodes collide between Tasks in one document

Observed on the real standalone Gateway with `@undefineds.co/drizzle-solid@0.3.24` and the shared `taskResource` schema. Two legitimate interval Tasks were created through `POST /api/tasks`; the second creation succeeded, but subsequent pause returned `Task has no recurring schedule` and run returned `代理执行凭据待接入或已失效`.

## Reproduction and evidence

1. Use a Pod with a granted task execution credential.
2. Insert two Tasks with different fragment ids into `/.data/task/index.ttl`. Each uses the shared `object('metadata')` column containing an `authBinding` snapshot and an `xpod` schedule object.
3. Read both rows through drizzle-solid, and inspect the document with an authenticated GET.
4. Both Task subjects point through `udfs:metadata` to the same `index.ttl#metadata-1` node. That node contains both Tasks' values. The ORM projects `metadata.authBinding` and `metadata.xpod` as arrays, mixing separate Tasks.

Expected: each Task owns a distinct nested metadata subject and updating/deleting one Task does not change another Task's metadata. The adapter correctly rejects the ambiguous arrays; choosing the first value would grant or execute the wrong Task context.

## Root cause and ownership

The published triple builder's `resolveInlineChildUri` removes the parent fragment and derives the child from document + column + array index. The subject's own identity is lost. This is a drizzle-solid serializer defect, not a Task API payload, grant, or shared schema problem.

Upstream local commit `a144d7fbc8b10b5165e590f37564bfa42c866824` already introduces a parent-qualified helper across triple/URI/subject resolvers. Its presence in the release branch/package must be reconciled and covered by a two-resource real Pod CRUD regression before updating Xpod's dependency. Do not modify installed `node_modules` or work around this by selecting an arbitrary array value.

Existing collided metadata cannot be unambiguously reconstructed from the merged node alone. Preserve evidence and repair only from authoritative per-Task inputs; the serializer fix prevents new collisions but does not invent lost ownership.

## Published fix

`@undefineds.co/drizzle-solid@0.3.25` is published from `86983384f9ea98f6748631bc859a5fc187e4cd1d` ([upstream PR](https://github.com/undefinedsco/drizzle-solid/pull/12), [release](https://github.com/undefinedsco/drizzle-solid/releases/tag/v0.3.25)). Build, 839 unit tests and real Gateway two-row CRUD passed. Xpod consumes that exact version; its existing patch is regenerated against the verified registry tarball without semantic changes and the dependency checker confirms exactly one application. A fresh actual Task now creates, pauses and starts successfully; later runtime authorization and approval acceptance are separate gates.
