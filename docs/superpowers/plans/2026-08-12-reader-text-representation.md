# Reader Text Representation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Reader-generated Markdown a durable alternate representation of the original Pod resource and project one deterministic retrieval-point set into FTS and optional VEC in both Local and Cloud.

**Architecture:** The shared models package owns document-understanding class/capability semantics, exact `AIConfig.readerModel` selection, and Reader Note vocabulary. Xpod persists generated Markdown and reconciliation state internally, commits current state through one deterministic `.meta#reader` Note, serves Markdown through a ResourceStore decorator, and runs one mdast projection whose chunks feed both text and vector indexes.

**Tech Stack:** TypeScript, Bun/Vitest, drizzle-solid, drizzle-orm, Community Solid Server ResourceStore, N3, `mdast-util-from-markdown`, SQLite, PostgreSQL, existing PaddleOCR adapter, existing RDF text/vector indexes.

---

## File map

### `/Users/ganlu/develop/models`

- Modify `src/namespaces.ts` — canonical DocumentUnderstanding and Reader materialization vocabulary.
- Modify `src/ai-model.schema.ts` — replace the broad DocumentModel subclass.
- Modify `src/ai-model-vocab.ts` — class defaults, workload eligibility, and exact model selection.
- Modify `src/ai-runtime.schema.ts` — retain `readerModel`; delete automatic Reader fallback fields.
- Create `src/reader-materialization.ts` — shared Note constants, statuses, and provenance types.
- Modify `src/index.ts` and `src/schema.ts` — export only the new contract.

### `/Users/ganlu/develop/xpod-jobs`

- Delete `src/document/ReaderAiConfig.ts` — remove flat `modelType === 'reader'` selection.
- Create `src/document/ReaderModelSelection.ts` — resolve an exact model relation to provider and Pod credential.
- Create `src/document/ReaderMaterialization.ts` — fingerprint and runtime record types.
- Create `src/document/ReaderMaterializationRepository.ts` — durable body and operational queue for SQLite/PostgreSQL.
- Create `src/document/ReaderMaterializationNote.ts` — deterministic `.meta#reader` codec.
- Create `src/document/ReaderRepresentationResolver.ts` — one current lookup shared by HTTP and indexing.
- Create `src/storage/ReaderRepresentationStore.ts` — negotiation, `Vary`, and source invalidation.
- Create `src/document/ReaderReconciler.ts` — retry, atomic swap, move, delete, and restart recovery.
- Create `src/document/MarkdownRetrievalPointProjector.ts` — mdast projection and stable keys.
- Modify `src/storage/rdf/RdfTextIndex.ts`, `src/api/service/RdfSearchIndexingService.ts`, and both SolidFS index syncers — one projection for FTS/VEC.
- Modify `src/api/runs/RdfRunContextRetriever.ts` — join on `sourceKey + retrievalPointKey`.
- Delete `src/storage/vector/VectorIndexingListener.ts` — remove duplicate whole-resource vector indexing.
- Modify `config/xpod.base.json`, `config/local.json`, and `config/cloud.json` — identical semantics with different SQL stores.

## Cross-task invariants

```ts
export const READER_MARKDOWN_MEDIA_TYPE = 'text/markdown'
export const READER_CHUNK_POLICY_VERSION = 'markdown-mdast-v1'
export const READER_NOTE_FRAGMENT = '#reader'

export type ReaderMaterializationStatus =
  | 'pending'
  | 'complete'
  | 'stale'
  | 'failed'
```

- The public result URI is always the current canonical source URI.
- `sourceKey` starts as the first source URI and survives content-preserving moves.
- Body first and Note last is the only commit sequence.
- Source mutation invalidates Note and search points before the mutation call returns.
- Model-only replacement preserves a source-valid old representation until Note swap.
- FTS works without embedding; VEC reuses already committed retrieval-point keys.
- No legacy alias, generated Markdown file, provider fallback, environment secret, or second chunker remains.

### Task 1: Replace DocumentModel with DocumentUnderstandingModel

**Files:**
- Modify: `/Users/ganlu/develop/models/tests/ai-model-inheritance.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-model-vocab.test.ts`
- Modify: `/Users/ganlu/develop/models/src/namespaces.ts`
- Modify: `/Users/ganlu/develop/models/src/ai-model.schema.ts`
- Modify: `/Users/ganlu/develop/models/src/ai-model-vocab.ts`
- Modify: `/Users/ganlu/develop/models/src/index.ts`
- Modify: `/Users/ganlu/develop/models/src/schema.ts`

- [ ] **Step 1: Write the failing class/default tests**

```ts
expect(documentUnderstandingModelSchema.type)
  .toBe(UDFS.DocumentUnderstandingModel)
expect(documentUnderstandingModelSchema.subClassOf)
  .toContain(UDFS.AIModel)
expect(documentUnderstandingModelResource.getType())
  .toBe(UDFS.DocumentUnderstandingModel)
expect(AI_MODEL_CLASS.document_understanding)
  .toBe(UDFS.DocumentUnderstandingModel)
expect(withAIModelClassDefaultCapabilities({
  rdfType: [UDFS.DocumentUnderstandingModel],
  capabilities: [],
})).toMatchObject({
  capabilities: [AI_MODEL_CAPABILITY.document_understanding],
})
expect((UDFS as Record<string, string>).DocumentModel).toBeUndefined()
```

- [ ] **Step 2: Run RED**

Run:

```bash
cd /Users/ganlu/develop/models
yarn test tests/ai-model-inheritance.test.ts tests/ai-model-vocab.test.ts
```

Expected: FAIL because the new class/schema/helper are absent.

- [ ] **Step 3: Implement the exact subclass and delete the broad class**

```ts
export const documentUnderstandingModelSchema = aiModelSchema.extend({}, {
  type: UDFS.DocumentUnderstandingModel,
  namespace: UDFS,
})

export const documentUnderstandingModelResource =
  documentUnderstandingModelSchema.table(
    'documentUnderstandingModel',
    MODEL_STORAGE,
  )

export type DocumentUnderstandingModelRow =
  typeof documentUnderstandingModelResource.$inferSelect
export type DocumentUnderstandingModelInsert =
  typeof documentUnderstandingModelResource.$inferInsert
export type DocumentUnderstandingModelUpdate =
  typeof documentUnderstandingModelResource.$inferUpdate
```

Delete `documentModelSchema`, `documentModelResource`, all DocumentModel types, the `UDFS.DocumentModel` term, the `document` class key, and the `reader/document/ocr` class aliases. Define:

```ts
export const AI_MODEL_CLASS = {
  chat: UDFS.ChatModel,
  embedding: UDFS.EmbeddingModel,
  document_understanding: UDFS.DocumentUnderstandingModel,
  reranking: UDFS.RerankingModel,
  image_generation: UDFS.ImageGenerationModel,
  speech_recognition: UDFS.SpeechRecognitionModel,
  speech_synthesis: UDFS.SpeechSynthesisModel,
  video_generation: UDFS.VideoGenerationModel,
} as const

export function withAIModelClassDefaultCapabilities<T extends {
  rdfType?: unknown
  capabilities?: unknown
}>(model: T): T & { capabilities: AIModelCapabilityUri[] } {
  const rdfTypes = Array.isArray(model.rdfType) ? model.rdfType : [model.rdfType]
  const capabilities = filterAIModelCapabilityUris(model.capabilities)
  for (const rdfType of rdfTypes) {
    if (typeof rdfType !== 'string') continue
    const value = AI_MODEL_CLASS_DEFAULT_CAPABILITY[
      rdfType as AIModelClassUri
    ]
    if (value) capabilities.push(value)
  }
  return { ...model, capabilities: [...new Set(capabilities)] }
}
```

- [ ] **Step 4: Run GREEN and build**

```bash
cd /Users/ganlu/develop/models
yarn test tests/ai-model-inheritance.test.ts tests/ai-model-vocab.test.ts
yarn build
```

Expected: both tests PASS and no DocumentModel export remains.

- [ ] **Step 5: Commit**

```bash
cd /Users/ganlu/develop/models
git add src/namespaces.ts src/ai-model.schema.ts src/ai-model-vocab.ts src/index.ts src/schema.ts tests/ai-model-inheritance.test.ts tests/ai-model-vocab.test.ts
git diff --cached --check
git commit -m "🧠 Name document understanding as the durable model contract" -m "Remove the speculative DocumentModel class and give dedicated document-understanding models their composable default capability." -m "Rejected: Keep DocumentModel aliases | the approved schema intentionally has no compatibility surface" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: model inheritance, vocabulary, and package build"
```

### Task 2: Freeze exact reader selection and shared Note vocabulary

**Files:**
- Create: `/Users/ganlu/develop/models/src/reader-materialization.ts`
- Modify: `/Users/ganlu/develop/models/src/namespaces.ts`
- Modify: `/Users/ganlu/develop/models/src/ai-model-vocab.ts`
- Modify: `/Users/ganlu/develop/models/src/ai-runtime.schema.ts`
- Modify: `/Users/ganlu/develop/models/src/index.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-config.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-runtime-schema.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-model-vocab.test.ts`

- [ ] **Step 1: Write failing exact-selection tests**

```ts
expect(selectAIModelForWorkload({
  config: {
    readerModel:
      '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
  },
  models: [{
    id: '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
    status: 'active',
    rdfType: [UDFS.DocumentUnderstandingModel],
    capabilities: [UDFS.DocumentUnderstandingCapability],
  }],
  workload: 'readerModel',
})?.id).toContain('paddleocr-vl-1.6')

expect(selectAIModelForWorkload({
  config: { readerModel: '/settings/providers/qwen.ttl#qwen-vl' },
  models: [{
    id: '/settings/providers/qwen.ttl#qwen-vl',
    rdfType: [UDFS.ChatModel],
    capabilities: [
      UDFS.DocumentUnderstandingCapability,
      UDFS.VisionCapability,
    ],
  }],
  workload: 'readerModel',
})?.id).toContain('qwen-vl')

expect(selectAIModelForWorkload({
  config: {},
  models: [{
    id: '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
    capabilities: [UDFS.DocumentUnderstandingCapability],
  }],
  workload: 'readerModel',
})).toBeUndefined()

expect(READER_MATERIALIZATION_NOTE_KIND)
  .toBe('reader-materialization')
expect(Object.keys(aiConfigResource.columns))
  .not.toContain('failureFallback')
expect(Object.keys(aiConfigResource.columns))
  .not.toContain('ocrFallbackOrder')
```

- [ ] **Step 2: Run RED**

```bash
cd /Users/ganlu/develop/models
yarn test tests/ai-config.test.ts tests/ai-runtime-schema.test.ts tests/ai-model-vocab.test.ts
```

Expected: FAIL because exact selection/Reader vocabulary are absent and fallback columns remain.

- [ ] **Step 3: Add the shared contract**

Create `src/reader-materialization.ts`:

```ts
export const READER_MATERIALIZATION_NOTE_KIND =
  'reader-materialization' as const
export const READER_MARKDOWN_MEDIA_TYPE = 'text/markdown' as const
export const READER_NOTE_FRAGMENT = '#reader' as const

export const READER_MATERIALIZATION_STATUSES = [
  'pending',
  'complete',
  'stale',
  'failed',
] as const

export type ReaderMaterializationStatus =
  (typeof READER_MATERIALIZATION_STATUSES)[number]

export interface ReaderMaterializationProvenance {
  readerEngine: string
  readerVersion: string
  generatedWithModel?: string
  sourceHash: string
  readerOptionsHash: string
  representationHash: string
  representationMediaType: typeof READER_MARKDOWN_MEDIA_TYPE
  coverageUnit: 'page' | 'line' | 'byte' | 'section' |
    'symbol' | 'rdf-resource'
  coveredRange: string
  readUnits: number
  totalUnits?: number
  status: ReaderMaterializationStatus
  failureCategory?: string
}
```

Add `Note`, `noteKind`, `representationMediaType`, `readerEngine`, `readerVersion`, `generatedWithModel`, `readerOptionsHash`, `representationHash`, `coverageUnit`, `coveredRange`, `readUnits`, `totalUnits`, and `failureCategory` to canonical UDFS. Reuse existing `sourceHash` and `status`.

```ts
export function selectAIModelForWorkload<T extends {
  id?: string | null
  '@id'?: string | null
  status?: string | null
  rdfType?: unknown
  capabilities?: unknown
}>(input: {
  config: Partial<Record<AIModelWorkload, string | null | undefined>>
  models: T[]
  workload: AIModelWorkload
}): T | undefined {
  const selectedUri = input.config[input.workload]
  if (!selectedUri) return undefined
  const model = input.models.find((candidate) =>
    (candidate.id ?? candidate['@id']) === selectedUri)
  if (!model || model.status === 'inactive') return undefined
  return isAIModelEligibleForWorkload(
    withAIModelClassDefaultCapabilities(model),
    input.workload,
  ) ? model : undefined
}
```

Delete `ocrFallbackOrder` and `failureFallback` from `aiConfigResource`; add no replacement fields.

- [ ] **Step 4: Run GREEN and build**

```bash
cd /Users/ganlu/develop/models
yarn test tests/ai-config.test.ts tests/ai-runtime-schema.test.ts tests/ai-model-vocab.test.ts tests/ai-model-inheritance.test.ts
yarn build
```

Expected: all focused tests PASS and the build exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/ganlu/develop/models
git add src/reader-materialization.ts src/namespaces.ts src/ai-model-vocab.ts src/ai-runtime.schema.ts src/index.ts tests/ai-config.test.ts tests/ai-runtime-schema.test.ts tests/ai-model-vocab.test.ts
git diff --cached --check
git commit -m "🧭 Select Reader models by exact Pod-owned relation" -m "Keep capability eligibility composable while removing automatic Reader fallback and sharing current materialization vocabulary." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: AI config, runtime schema, vocabulary, inheritance, and package build"
```

### Task 3: Replace Xpod's flat Reader selector

**Files:**
- Delete: `src/document/ReaderAiConfig.ts`
- Create: `src/document/ReaderModelSelection.ts`
- Modify: `src/api/chatkit/pod-store.ts`
- Modify: `src/extensions/ExtensionRuntime.ts`
- Modify: `src/document/index.ts`
- Modify: `src/index.ts`
- Delete: `tests/document/ReaderAiConfig.test.ts`
- Create: `tests/document/ReaderModelSelection.test.ts`
- Modify: `tests/extensions/ExtensionRuntime.test.ts`
- Modify: `tests/extensions/ServerExtensionSmoke.test.ts`
- Modify: `tests/ai/PodStoreAiConfig.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Build the verified models artifact**

```bash
cd /Users/ganlu/develop/models
yarn build
yarn pack:release --version 0.2.51
tar -tzf preview/undefineds-co-models-0.2.51.tgz | rg 'dist/(ai-model|reader-materialization|index)'
```

Expected: the tarball contains the new class, selector, and Reader declarations.
Publishing `0.2.51` is an explicit registry side-effect gate: publish only with
release authority or consume the version if it already exists. If neither is
true, stop Xpod dependency integration at this gate; never commit a sibling
`file:` dependency or a temporary compatibility copy.

- [ ] **Step 2: Write failing URI-first tests**

```ts
expect(resolveReaderModelSelection({
  aiConfig: {
    readerModel:
      '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
  },
  providers: [{
    id: '/settings/providers/paddleocr.ttl',
    baseUrl: 'https://paddle.example/',
  }],
  models: [{
    id: '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
    isProvidedBy: '/settings/providers/paddleocr.ttl',
    status: 'active',
    rdfType: [UDFS.DocumentUnderstandingModel],
    capabilities: [UDFS.DocumentUnderstandingCapability],
  }],
  credentials: [{
    id: '/settings/credentials.ttl#paddle',
    provider: '/settings/providers/paddleocr.ttl',
    status: 'active',
    apiKey: 'pod-secret',
  }],
})).toMatchObject({
  modelUri:
    '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
  providerUri: '/settings/providers/paddleocr.ttl',
  credentialUri: '/settings/credentials.ttl#paddle',
})

expect(resolveReaderModelSelection({
  aiConfig: {},
  providers: [],
  models: [],
  credentials: [],
})).toBeUndefined()
```

Also assert that provider defaults do not select a model when `readerModel` is absent and that a capable ChatModel is eligible.

- [ ] **Step 3: Run RED**

```bash
cd /Users/ganlu/develop/xpod-jobs
bun run test:run -- tests/document/ReaderModelSelection.test.ts
```

Expected: FAIL because the module is absent.

- [ ] **Step 4: Implement exact model/provider/credential resolution**

```ts
export interface ReaderModelSelection {
  modelUri: string
  providerUri: string
  credentialUri: string
  baseUrl?: string
  proxyUrl?: string
  apiKey: string
}

interface ReaderModelRow {
  id?: string | null
  '@id'?: string | null
  isProvidedBy?: string | null
  status?: string | null
  rdfType?: unknown
  capabilities?: unknown
}

interface ReaderProviderRow {
  id?: string | null
  '@id'?: string | null
  baseUrl?: string | null
  proxyUrl?: string | null
}

interface ReaderCredentialRow {
  id?: string | null
  '@id'?: string | null
  provider?: string | null
  status?: string | null
  apiKey?: string | null
  baseUrl?: string | null
  proxyUrl?: string | null
}

export interface ResolveReaderModelSelectionInput {
  aiConfig: Partial<Record<AIModelWorkload, string | null | undefined>>
  models: ReaderModelRow[]
  providers: ReaderProviderRow[]
  credentials: ReaderCredentialRow[]
}

export function resolveReaderModelSelection(
  input: ResolveReaderModelSelectionInput,
): ReaderModelSelection | undefined {
  const model = selectAIModelForWorkload({
    config: input.aiConfig,
    models: input.models,
    workload: 'readerModel',
  })
  if (!model) return undefined
  const modelUri = model.id ?? model['@id']
  const providerUri = model.isProvidedBy
  if (!modelUri || !providerUri) return undefined
  const provider = input.providers.find((row) =>
    (row.id ?? row['@id']) === providerUri)
  const credential = input.credentials.find((row) =>
    row.provider === providerUri &&
    (row.status ?? 'active') === 'active' &&
    typeof row.apiKey === 'string' &&
    row.apiKey.length > 0)
  const credentialUri = credential?.id ?? credential?.['@id']
  if (!credential || !credentialUri) return undefined
  return {
    modelUri,
    providerUri,
    credentialUri,
    apiKey: credential.apiKey!,
    baseUrl: credential.baseUrl ?? provider?.baseUrl ?? undefined,
    proxyUrl: credential.proxyUrl ?? provider?.proxyUrl ?? undefined,
  }
}
```

Delete `ReaderAiConfig.ts` and pass the exact model URI to the Paddle adapter and provenance. After the registry artifact exists:

```bash
cd /Users/ganlu/develop/xpod-jobs
bun add @undefineds.co/models@0.2.51
```

In `src/api/chatkit/pod-store.ts`, make `getReaderConfig(context)` load the
singleton Pod `AIConfig` row with exact id `config`, then pass only
`{ readerModel: config?.readerModel }` into
`resolveReaderModelSelection`. Delete the preferred-provider/default-model
selection. Extend `PodStoreAiConfig.test.ts` with both boundaries:

```ts
expect(await getReaderConfig(podWithProviderDefaultButNoReaderModel))
  .toBeUndefined()
expect(await getReaderConfig(podWithExactReaderModel)).toMatchObject({
  modelUri: '/settings/providers/paddleocr.ttl#paddleocr-vl-1.6',
})
```

- [ ] **Step 5: Run GREEN**

```bash
cd /Users/ganlu/develop/xpod-jobs
bun run test:run -- tests/document/ReaderModelSelection.test.ts tests/extensions/ExtensionRuntime.test.ts tests/ai/PodStoreAiConfig.test.ts
bun run build:ts
! rg "modelType.*reader|selectReaderAiConfig" src tests
```

Expected: tests and build PASS; the final `rg` prints no matches.

- [ ] **Step 6: Commit**

```bash
cd /Users/ganlu/develop/xpod-jobs
git add package.json bun.lock src/document/ReaderModelSelection.ts src/document/ReaderAiConfig.ts src/document/index.ts src/index.ts src/api/chatkit/pod-store.ts src/extensions/ExtensionRuntime.ts tests/document/ReaderModelSelection.test.ts tests/document/ReaderAiConfig.test.ts tests/extensions/ExtensionRuntime.test.ts tests/extensions/ServerExtensionSmoke.test.ts tests/ai/PodStoreAiConfig.test.ts
git diff --cached --check
git commit -m "🔐 Resolve Reader execution from the exact Pod model" -m "Delete flat reader model types and preserve the user-owned provider and credential boundary without fallback." -m "Constraint: Xpod consumes a published registry artifact, never a sibling file dependency" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: URI selection, extension runtime, Pod config, and TypeScript build"
```

### Task 4: Persist immutable Reader bodies and reconciliation intent

**Files:**
- Create: `src/document/ReaderMaterialization.ts`
- Create: `src/document/ReaderMaterializationRepository.ts`
- Create: `tests/document/ReaderMaterializationRepository.test.ts`
- Modify: `src/document/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing repository contract tests**

Run the focused repository contract against the normal Local identity SQLite
database. Reuse the same DB-neutral SQL implementation unchanged in the real
PostgreSQL Cloud acceptance harness in Task 11; do not introduce PGlite as a
third identity-database behavior. The focused contract must prove:

```ts
const body = await repository.putBody({
  sourceKey: 'urn:xpod:source:1',
  sourceUri: 'https://pod.example/a.pdf',
  sourceHash: 'sha256:source-v1',
  mediaType: 'text/markdown',
  readerEngine: 'urn:xpod:reader:paddleocr-official-api',
  readerVersion: '1.0.0',
  modelUri: '/settings/providers/paddle.ttl#paddle-vl',
  readerOptionsHash: 'sha256:options-v1',
  representationHash: 'sha256:markdown-v1',
  markdown: '# A\n\nBody',
})

expect(await repository.getBody(body.fingerprint))
  .toEqual(body)
expect(await repository.putBody({ ...body, markdown: 'different' }))
  .rejects.toThrow(/immutable/i)

await repository.enqueue({
  sourceKey: body.sourceKey,
  sourceUri: body.sourceUri,
  desiredFingerprint: body.fingerprint,
  reason: 'source-created',
})
await repository.enqueue({
  sourceKey: body.sourceKey,
  sourceUri: body.sourceUri,
  desiredFingerprint: body.fingerprint,
  reason: 'restart-recovery',
})
expect(await repository.listRunnable()).toHaveLength(1)
```

Also prove retry timestamps survive repository recreation, leases expire, a
successful item is removed, and `moveSource` changes only the public URI.

- [ ] **Step 2: Run RED**

```bash
bun run test:run -- tests/document/ReaderMaterializationRepository.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the DB-neutral durable contract**

Use the existing `IdentityDatabase`, `executeQuery`, `executeStatement`,
`toDbTimestamp`, and `fromDbTimestamp` helpers. Do not add an ORM or a
second database connection. Create exactly two internal tables:

``sql
CREATE TABLE IF NOT EXISTS reader_materialization_body (
  fingerprint TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  reader_engine TEXT NOT NULL,
  reader_version TEXT NOT NULL,
  model_uri TEXT,
  reader_options_hash TEXT NOT NULL,
  representation_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reader_reconciliation (
  source_key TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL,
  desired_fingerprint TEXT,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_failure_category TEXT,
  updated_at TEXT NOT NULL
);
```

The materialization fingerprint is the SHA-256 of a canonical tuple containing
`sourceKey`, `sourceHash`, media type, Reader engine/version, exact model URI
or the literal `no-model`, and options hash. A duplicate fingerprint may only
be accepted when every fingerprint field and the body are byte-identical.
`sourceUri` is the one mutable locator column: `moveSource` may update it
without changing the fingerprint, `sourceKey`, or Markdown bytes.

- [ ] **Step 4: Run GREEN**

```bash
bun run test:run -- tests/document/ReaderMaterializationRepository.test.ts
bun run build:ts
```

- [ ] **Step 5: Commit**

```bash
git add src/document/ReaderMaterialization.ts src/document/ReaderMaterializationRepository.ts src/document/index.ts src/index.ts tests/document/ReaderMaterializationRepository.test.ts
git diff --cached --check
git commit -m "🗃️ Make Reader materialization restart-safe" -m "Persist immutable Markdown bodies and one idempotent reconciliation intent per stable source identity." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Reader repository contract on SQLite; PostgreSQL covered by Cloud acceptance"
```

### Task 5: Make one deterministic Note the public commit marker

**Files:**
- Create: `src/document/ReaderMaterializationNote.ts`
- Create: `src/document/ReaderRepresentationResolver.ts`
- Create: `tests/document/ReaderMaterializationNote.test.ts`
- Create: `tests/document/ReaderRepresentationResolver.test.ts`
- Modify: `src/document/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing Note codec tests**

Use an in-memory `ResourceStore` fixture whose source metadata document already
contains an unrelated triple. Assert that writing the current state:

```ts
await notes.commit({
  sourceUri: 'https://pod.example/a.pdf',
  sourceKey: 'urn:xpod:source:1',
  fingerprint: 'sha256:fingerprint-v1',
  provenance,
})

const first = await readMeta('/a.pdf.meta')
expect(first).toContain('<#reader>')
expect(first).toContain('reader-materialization')
expect(first).not.toContain('pod-secret')
expect(first).toContain('unrelated')

await notes.commit({ ...current, fingerprint: 'sha256:fingerprint-v2' })
expect(parseReaderNotes(await readMeta('/a.pdf.meta'))).toHaveLength(1)
```

Prove that `markStale` preserves unrelated quads, `remove` removes only the
`#reader` subject, a model-backed Note requires the exact model URI, and a
deterministic Reader Note has no invented model.

- [ ] **Step 2: Write failing resolver tests**

```ts
expect(await resolver.resolve(source)).toMatchObject({
  sourceUri: source.path,
  sourceKey: 'urn:xpod:source:1',
  mediaType: 'text/markdown',
  markdown: '# A\n\nBody',
})

await notes.markStale(source)
expect(await resolver.resolve(source)).toBeUndefined()
```

Add cases for a missing body, mismatched representation hash, non-complete Note,
and duplicate/malformed Reader subjects. None may be served.

- [ ] **Step 3: Run RED**

```bash
bun run test:run -- tests/document/ReaderMaterializationNote.test.ts tests/document/ReaderRepresentationResolver.test.ts
```

- [ ] **Step 4: Implement the codec and resolver**

Use N3 parsing/writing and the canonical `UDFS` terms from
`@undefineds.co/models`; do not read the old
`https://vocab.undefineds.co/udfs#` vocabulary. Resolve `/a.pdf.meta#reader`
against the metadata document, follow `sioc:about` back to the source, and
trust a body only when status, fingerprint, source hash, representation hash,
and media type all match the immutable repository row.

Commit order is fixed:

``ts
const body = await repository.putBody(generated)
await noteStore.commit(noteFrom(body)) // always last
```

The resolver performs no source fetch, hash calculation, or external model
request on a public read.

- [ ] **Step 5: Run GREEN**

```bash
bun run test:run -- tests/document/ReaderMaterializationNote.test.ts tests/document/ReaderRepresentationResolver.test.ts
bun run build:ts
```

- [ ] **Step 6: Commit**

```bash
git add src/document/ReaderMaterializationNote.ts src/document/ReaderRepresentationResolver.ts src/document/index.ts src/index.ts tests/document/ReaderMaterializationNote.test.ts tests/document/ReaderRepresentationResolver.test.ts
git diff --cached --check
git commit -m "📝 Commit Reader Markdown through one current Note" -m "Treat the complete metadata Note as the only externally meaningful pointer to an immutable derived body." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Note preservation, replacement, stale state, and resolver integrity"
```

### Task 6: Serve Markdown as an alternate representation

**Files:**
- Create: `src/storage/ReaderRepresentationStore.ts`
- Create: `tests/storage/ReaderRepresentationStore.test.ts`
- Modify: `src/index.ts`
- Modify: `config/xpod.base.json`
- Modify: `config/local.json`
- Modify: `config/cloud.json`

- [ ] **Step 1: Write the failing negotiation matrix**

Drive `getRepresentation` through a primary-store fake and a valid Reader
resolver. Assert the selected media type for all rows:

| Accept | Valid Markdown | Result |
|---|---:|---|
| absent | yes/no | primary |
| `*/*` | yes | primary |
| `image/jpeg, text/markdown` | yes | primary (tie) |
| `image/jpeg;q=.4, text/markdown;q=.8` | yes | Markdown |
| `text/markdown` | no | 406 |
| `text/markdown, image/jpeg;q=.1` | no | primary |

Also assert that a native `text/markdown` resource always comes from the
primary store, Markdown bytes equal the resolver body exactly, the response
metadata carries `Vary: Accept`, and primary/Markdown ETags differ.

- [ ] **Step 2: Write failing synchronous-invalidation tests**

For `setRepresentation`, `addResource`, `modifyResource`, and
`deleteResource`, block the delegated primary mutation and assert the old
Note/search invalidation has already completed before the mutation is invoked.
When the primary mutation fails, enqueue reconciliation against observable
current source state; never restore a possibly stale Note.

- [ ] **Step 3: Run RED**

```bash
bun run test:run -- tests/storage/ReaderRepresentationStore.test.ts
```

- [ ] **Step 4: Implement the ResourceStore decorator**

Subclass CSS `PassthroughStore`. Negotiate only between the primary
representation and the one valid `text/markdown` alternate. Equal quality,
wildcards, and missing preferences select primary. Raise `NotAcceptableHttpError`
only when the request rejects primary and exclusively accepts unavailable
Markdown.

Return a `BasicRepresentation` with Markdown content type, derived modified
timestamp, and the custom response metadata predicate
`urn:undefineds:xpod:http:vary-accept`. Extend the existing mapped metadata
writer with that predicate -> `Vary: Accept` while preserving the existing
`Location` mapping. Place this store directly around `ResourceStore_Backend`;
keep `RepresentationPartialConvertingStore` outside it so RDF conversion
behavior is unchanged.

- [ ] **Step 5: Run GREEN and configuration checks**

```bash
bun run test:run -- tests/storage/ReaderRepresentationStore.test.ts tests/storage/RepresentationPartialConvertingStore.test.ts
bun run build:components
bun run build:ts
```

- [ ] **Step 6: Commit**

```bash
git add src/storage/ReaderRepresentationStore.ts src/index.ts tests/storage/ReaderRepresentationStore.test.ts config/xpod.base.json config/local.json config/cloud.json
git diff --cached --check
git commit -m "🌐 Negotiate Reader Markdown at the source URI" -m "Serve a committed alternate representation without generated files, synchronous inference, or changes to RDF conversion." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: Accept matrix, invalidation ordering, Components.js build"
```

### Task 7: Reconcile Reader work without blocking source writes

**Files:**
- Create: `src/document/ReaderReconciler.ts`
- Create: `src/document/ReaderReconciliationInitializer.ts`
- Create: `tests/document/ReaderReconciler.test.ts`
- Create: `tests/document/ReaderReconciliationInitializer.test.ts`
- Modify: `src/document/index.ts`
- Modify: `src/index.ts`
- Modify: `config/xpod.base.json`
- Modify: `config/local.json`
- Modify: `config/cloud.json`

- [ ] **Step 1: Write failing lifecycle tests around fakes**

Use a controlled source store, exact model selector, fake `DocumentReader`,
repository, Note store, and fake index projector. Lock these sequences:

``ts
// First materialization
expect(events).toEqual([
  'read-source',
  'invoke-reader:model-v1',
  'put-body:fingerprint-v1',
  'commit-note:fingerprint-v1',
  'project-search:fingerprint-v1',
  'complete-job',
])

// Model-only upgrade failure leaves the source-valid old commit active.
expect(await resolver.resolve(source)).toMatchObject({
  fingerprint: 'sha256:fingerprint-v1',
})
expect(await repository.listRunnable()).toMatchObject([{
  sourceKey,
  lastFailureCategory: 'quota-exhausted',
}])
```

Also prove:

- no Reader config means the source write succeeds and no provider is called;
- adding exact Reader config enumerates existing eligible binary resources;
- a deterministic Reader receives the literal no-model fingerprint branch;
- native Markdown/text is indexed directly and gets no Reader Note;
- retry resumes the same exact model and never selects another provider;
- non-retryable failure writes `failed` only if no old valid commit exists;
- restart reclaims expired work without duplicating a committed body;
- two workers cannot hold the same source lease concurrently.

- [ ] **Step 2: Run RED**

```bash
bun run test:run -- tests/document/ReaderReconciler.test.ts tests/document/ReaderReconciliationInitializer.test.ts
```

- [ ] **Step 3: Implement one idempotent reconciler**

`ReaderReconciliationInitializer` initializes tables, releases expired leases,
scans existing Pod resources only when Reader configuration becomes applicable,
and starts one bounded worker loop. The loop compares current source hash,
desired exact Reader/model/options fingerprint, current Note, and immutable body.

The worker uses this order:

``ts
const lease = await repository.claimNext(workerId, now)
const current = await sourceSnapshot.read(lease.sourceUri)
const desired = await desiredReader.resolve(current)

if (!desired) return repository.complete(lease.sourceKey)
if (await currentNote.matches(desired)) {
  await searchProjection.ensureCurrent(desired)
  return repository.complete(lease.sourceKey)
}

const generated = await desired.reader.read(current.body, desired.request)
const body = await repository.putBody(materialize(generated, desired))
await noteStore.commit(noteFrom(body))
await searchProjection.replace(body)
await repository.complete(lease.sourceKey)
```

Use a fixed exponential retry schedule capped at one hour and a bounded failure
category enum. Credentials exist only in the invocation object and are never
serialized. Delete orphan bodies with no current Note after a bounded grace
period; do not create parse history resources or user-visible Markdown files.

- [ ] **Step 4: Run GREEN and component generation**

```bash
bun run test:run -- tests/document/ReaderReconciler.test.ts tests/document/ReaderReconciliationInitializer.test.ts tests/document/ReaderMaterializationRepository.test.ts tests/document/ReaderMaterializationNote.test.ts
bun run build:components
bun run build:ts
```

- [ ] **Step 5: Commit**

```bash
git add src/document/ReaderReconciler.ts src/document/ReaderReconciliationInitializer.ts src/document/index.ts src/index.ts tests/document/ReaderReconciler.test.ts tests/document/ReaderReconciliationInitializer.test.ts config/xpod.base.json config/local.json config/cloud.json
git diff --cached --check
git commit -m "♻️ Reconcile Reader output through durable intent" -m "Keep writes available, retry the selected model, and atomically replace only source-valid Reader commits." -m "Constraint: Reader credentials remain Pod-owned and ephemeral" -m "Rejected: Provider fallback | violates exact AIConfig.readerModel selection" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: creation, upgrade, retry, lease, restart, and native-text paths"
```

### Task 8: Replace regex chunking with one mdast projection

**Files:**
- Delete: `src/document/HeadingChunker.ts`
- Create: `src/document/MarkdownRetrievalPointProjector.ts`
- Delete: `tests/document/HeadingChunker.test.ts`
- Create: `tests/document/MarkdownRetrievalPointProjector.test.ts`
- Modify: `src/document/index.ts`
- Modify: `src/storage/rdf/RdfTextIndex.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add only the approved parser dependency**

```bash
bun add mdast-util-from-markdown
```

Do not add a second chunking framework. Traverse the returned mdast directly.

- [ ] **Step 2: Write failing deterministic projection tests**

Use Markdown containing nested headings, paragraphs, a list, a block quote, a
table-shaped paragraph, and an oversized leaf. Assert:

```ts
const first = projector.project({
  sourceKey: 'urn:xpod:source:1',
  sourceUri: 'https://pod.example/a.pdf',
  representationHash: 'sha256:markdown-v1',
  markdown,
})
const second = projector.project({
  sourceKey: 'urn:xpod:source:1',
  sourceUri: 'https://pod.example/a.pdf',
  representationHash: 'sha256:markdown-v1',
  markdown,
})

expect(second).toEqual(first)
expect(first.every((point) =>
  point.chunkKey === point.retrievalPointKey)).toBe(true)
expect(first.map((point) => point.sectionPath)).toContain('H1 / H2')
expect(first.every((point) => point.sourceKey === 'urn:xpod:source:1'))
```

Changing only the public source URI must not change keys; changing source
content/hash, Markdown bytes, or `READER_CHUNK_POLICY_VERSION` must. Oversized
leaves split deterministically on UTF-8 byte boundaries without corrupting
Unicode, and empty structural nodes emit no retrieval point.

- [ ] **Step 3: Run RED**

```bash
bun run test:run -- tests/document/MarkdownRetrievalPointProjector.test.ts
```

- [ ] **Step 4: Implement the canonical projection**

Set `READER_CHUNK_POLICY_VERSION = 'markdown-mdast-v1'` and a single fixed
oversized-leaf budget in code. Heading hierarchy supplies the structural path;
paragraphs and structural leaves supply text. Compute each key from the
canonical tuple:

``ts
const retrievalPointKey = sha256([
  sourceKey,
  representationHash,
  READER_CHUNK_POLICY_VERSION,
  structuralPath,
  subdivisionOrdinal,
  text,
].join('\u0000'))
```

Set `chunkKey` equal to `retrievalPointKey`. Preserve `sourceKey`, current
`sourceUri`, section path, ordinal, and byte range in the projection. Delete
the random-ID regex `HeadingChunker`; no compatibility adapter remains.

- [ ] **Step 5: Run GREEN**

```bash
bun run test:run -- tests/document/MarkdownRetrievalPointProjector.test.ts tests/storage/rdf/RdfTextIndex.test.ts
bun run build:ts
! rg "HeadingChunker|randomBytes" src/document tests/document
```

Expected: tests/build PASS and the final search has no matches.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/document/HeadingChunker.ts src/document/MarkdownRetrievalPointProjector.ts src/document/index.ts src/storage/rdf/RdfTextIndex.ts src/storage/rdf/types.ts tests/document/HeadingChunker.test.ts tests/document/MarkdownRetrievalPointProjector.test.ts
git diff --cached --check
git commit -m "🔎 Give FTS and vectors one Markdown structure" -m "Derive deterministic retrieval points from mdast so every search backend shares identity and segmentation." -m "Rejected: Separate FTS and VEC chunkers | creates unjoinable search candidates" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: deterministic hierarchy, Unicode splitting, moves, and content changes"
```

### Task 9: Feed the same committed points to FTS and optional VEC

**Files:**
- Modify: `src/api/service/RdfSearchIndexingService.ts`
- Create: `src/api/service/RdfSearchReconciliationRepository.ts`
- Modify: `src/solidfs/RdfIndexSolidFsSyncer.ts`
- Modify: `src/api/service/RdfSearchIndexingSolidFsSyncer.ts`
- Modify: `src/api/container/rdf.ts`
- Modify: `src/storage/rdf/RdfTextIndex.ts`
- Modify: `src/api/runs/RdfRunContextRetriever.ts`
- Delete: `src/storage/vector/VectorIndexingListener.ts`
- Modify: `src/index.ts`
- Modify: `tests/service/RdfSearchIndexingService.service.test.ts`
- Create: `tests/api/service/RdfSearchReconciliationRepository.test.ts`
- Modify: `tests/solidfs/RdfIndexSolidFsSyncer.test.ts`
- Modify: `tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts`
- Modify: `tests/api/container/rdf.test.ts`

- [ ] **Step 1: Write failing shared-point tests**

Assert that `indexProjection(points)` always writes FTS first, passes the same
retrieval-point identity and text to VEC when an embedding runtime exists, and
succeeds with FTS only when it does not. Use fake text/vector indexes that
capture their existing `indexTextSource` / `indexVectorSource` inputs; do
not add a production list API only for tests.

Then index with no embedding configuration, add one later, and run convergence:

```ts
const before = capturedTextChunks.map(identity)
await service.reconcileVectors(sourceKey)
const after = capturedVectorChunks.map(identity)

expect(after).toEqual(before)
expect(reader.read).toHaveBeenCalledTimes(1)
expect(projector.project).toHaveBeenCalledTimes(1)
```

Changing only the embedding model must replace vector rows for those existing
keys without modifying the text rows, Reader body, or Note.

Also assert durable recovery state:

- no Pod embedding configuration stores `waiting-config`, not `done`;
- quota/rate-limit and transient Provider failures store retryable work with
  `nextAttemptAt` and resume after restart;
- an authentication/invalid-model failure waits for the Pod configuration
  fingerprint to change rather than hot-looping;
- a new provider/model/model-version requeues every current FTS source and the
  query uses only that exact profile;
- deleting a source deletes its reconciliation work;
- vector backfill reads the already committed FTS retrieval points and never
  reruns Reader or Markdown projection.

- [ ] **Step 2: Run RED**

```bash
bun run test:run -- tests/service/RdfSearchIndexingService.service.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts tests/api/container/rdf.test.ts
```

- [ ] **Step 3: Make retrieval points the only indexing input**

Remove service overloads that accept raw document text and chunk internally.
`RdfSearchIndexingService` accepts committed retrieval points and stores FTS
unconditionally. `RdfSearchReconciliationRepository` is a small, product-
specific lease/retry queue keyed by source identity and desired embedding
profile; it is not a generic job framework. Both SolidFS syncers resolve the
public/committed textual representation exactly once and pass one projection
downstream. `RdfTextIndex` exposes the minimum production read needed to fetch
current chunks by `sourceKey`, so late vector backfill consumes the exact FTS
points. Local container construction creates the indexing/reconciliation
service even when embedding is absent; only vector generation is optional.

`ai_config_unavailable`, missing model, quota/rate-limit, and transient
Provider failure must not return a terminal `skipped` result to the SolidFS
journal. They update reconciliation state. Pod configuration discovery and
service startup reawaken eligible rows. A model/profile change rebuilds VEC
from current FTS chunks, removes superseded derived rows, and does not rebuild
Reader or FTS. `RdfRunContextRetriever` forwards provider, model, and model
version so old profiles are never mixed into current results.

Delete `VectorIndexingListener` and its exports/configuration. It indexes an
entire resource through a second identity path and is superseded, so no bridge
or fallback remains.

- [ ] **Step 4: Run GREEN and absence checks**

```bash
bun run test:run -- tests/service/RdfSearchIndexingService.service.test.ts tests/api/service/RdfSearchReconciliationRepository.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts tests/api/container/rdf.test.ts
bun run build:ts
! rg "VectorIndexingListener|chunkRdfTextSource\(" src config tests
```

Expected: tests/build PASS; no production path uses the deleted listener or
re-chunks Reader Markdown.

- [ ] **Step 5: Commit**

```bash
git add src/api/service/RdfSearchIndexingService.ts src/api/service/RdfSearchReconciliationRepository.ts src/solidfs/RdfIndexSolidFsSyncer.ts src/api/service/RdfSearchIndexingSolidFsSyncer.ts src/api/container/rdf.ts src/storage/rdf/RdfTextIndex.ts src/api/runs/RdfRunContextRetriever.ts src/storage/vector/VectorIndexingListener.ts src/index.ts tests/service/RdfSearchIndexingService.service.test.ts tests/api/service/RdfSearchReconciliationRepository.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts tests/api/container/rdf.test.ts
git diff --cached --check
git commit -m "🧲 Let vectors converge on committed text points" -m "Keep FTS available without embedding and fill vectors later without rerunning Reader or segmentation." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: FTS-only, late embedding, model replacement, and Local container construction"
```

### Task 10: Preserve identity through fusion, move, stale, and delete

**Files:**
- Modify: `src/api/runs/RdfRunContextRetriever.ts`
- Modify: `src/storage/rdf/RdfVectorIndex.ts`
- Modify: `src/storage/rdf/PostgresRdfVectorIndex.ts`
- Modify: `src/solidfs/RdfIndexSolidFsSyncer.ts`
- Modify: `src/api/service/RdfSearchIndexingSolidFsSyncer.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `tests/service/RdfRunContextRetriever.service.test.ts`
- Modify: `tests/storage/rdf/RdfVectorIndex.test.ts`
- Modify: `tests/storage/rdf/PostgresRdfVectorIndex.test.ts`
- Modify: `tests/solidfs/RdfIndexSolidFsSyncer.test.ts`
- Modify: `tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts`

- [ ] **Step 1: Reproduce the cross-product fusion bug**

Give one source two retrieval points, with text matching point A and vector
matching point B. Assert that fusion yields only explicit pairs and never joins
the text score from A to the vector score from B:

```ts
expect(results.map(({ sourceKey, retrievalPointKey }) =>
  [sourceKey, retrievalPointKey])).toEqual([
    ['urn:xpod:source:1', 'point-a'],
    ['urn:xpod:source:1', 'point-b'],
  ])
```

Include the same `retrievalPointKey` under a second `sourceKey` to prove both
parts of the composite identity are required. Verify final grouping exposes the
current authorized source URI, not a body fingerprint or generated path.

- [ ] **Step 2: Write lifecycle tests**

Prove the following against SQLite and PostgreSQL indexes:

- source content mutation synchronously removes old text/vector points and marks
  the Note stale before new Reader work begins;
- content-preserving move changes `sourceUri` in body pointer, Note, text rows,
  and vector rows while preserving `sourceKey` and every retrieval-point key;
- delete removes the Note, every body for the sourceKey, queue row, FTS, and VEC;
- a failed move/delete resumes idempotently from the durable journal.

- [ ] **Step 3: Run RED**

```bash
bun run test:run -- tests/service/RdfRunContextRetriever.service.test.ts tests/storage/rdf/RdfVectorIndex.test.ts tests/storage/rdf/PostgresRdfVectorIndex.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts
```

- [ ] **Step 4: Implement composite fusion and vector moves**

Bind `sourceKey` and `retrievalPointKey` in both text and vector subqueries,
key candidate maps by their escaped pair, and fuse only identical pairs. Group
after scoring by `sourceKey`; resolve its latest authorized public URI at the
final result boundary.

Add `moveSource(oldUri, next)` to both vector indexes with the same contract as
the text indexes. Update the SolidFS syncers to call `moveSource` instead of
delete/reinsert when the journal identifies a content-preserving move. Use the
Reader repository's stable source mapping; never recompute `sourceKey` from
the destination URI.

- [ ] **Step 5: Run GREEN**

```bash
bun run test:run -- tests/service/RdfRunContextRetriever.service.test.ts tests/storage/rdf/RdfVectorIndex.test.ts tests/storage/rdf/PostgresRdfVectorIndex.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts
bun run build:ts
```

- [ ] **Step 6: Commit**

```bash
git add src/api/runs/RdfRunContextRetriever.ts src/storage/rdf/RdfVectorIndex.ts src/storage/rdf/PostgresRdfVectorIndex.ts src/solidfs/RdfIndexSolidFsSyncer.ts src/api/service/RdfSearchIndexingSolidFsSyncer.ts src/storage/rdf/types.ts tests/service/RdfRunContextRetriever.service.test.ts tests/storage/rdf/RdfVectorIndex.test.ts tests/storage/rdf/PostgresRdfVectorIndex.test.ts tests/solidfs/RdfIndexSolidFsSyncer.test.ts tests/api/service/RdfSearchIndexingSolidFsSyncer.service.test.ts
git diff --cached --check
git commit -m "🔗 Fuse search at the retrieval-point boundary" -m "Keep stable source identity through moves while stale and deleted content disappears from both text and vector search." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: composite joins, mutation invalidation, move, delete, and journal replay"
```

### Task 11: Exclude system metadata and prove the full Reader contract

**Files:**
- Modify: `src/storage/rdf/RdfTextProjection.ts`
- Create: `tests/storage/rdf/RdfTextProjection.test.ts`
- Create: `tests/fixtures/DeterministicDocumentReader.ts`
- Create: `tests/integration/helpers/ReaderAcceptanceHarness.ts`
- Create: `tests/integration/ReaderTextRepresentation.integration.test.ts`
- Create: `tests/integration/ReaderSearchParity.integration.test.ts`
- Modify: `docs/COMPONENTS.md`
- Modify: `docs/progressive-semantic-index.md`

- [ ] **Step 1: Write failing RDF metadata-exclusion tests**

Project a graph containing an ordinary searchable title plus every Reader Note
predicate. Assert the title remains a field retrieval point while Note kind,
engine, model URI, hashes, coverage, status, and failure category never appear
in searchable text. Keep predicate/datatype/language/graph/subject provenance
for ordinary RDF literals.

- [ ] **Step 2: Build one explicit Local/Cloud test harness**

`DeterministicDocumentReader` maps fixture bytes to fixed Markdown and records
every call. `ReaderAcceptanceHarness` directly constructs the production
repository, Note store, reconciler, representation store, projector, and search
indexes; it does not add a test-only Components.js branch.

- Local mode uses a `.test-data/reader-acceptance/local/` SQLite identity/RDF
  root and the production SQLite text/vector indexes.
- Cloud mode starts the same PG17 Docker fixture pattern already used by
  `NativeRdfProductHttp.integration.test.ts`, creates an isolated database,
  and uses the production PostgreSQL repository/text/vector implementations.
- The helper owns cleanup and exposes one `canonicalSearchResult` comparator
  that retains only source URI, `sourceKey`, `retrievalPointKey`, snippet,
  and normalized scores.
- A separate configuration assertion loads `config/local.json` and
  `config/cloud.json` so direct construction cannot hide missing production
  wiring.

- [ ] **Step 3: Write Local/Cloud Reader acceptance tests**

Run the same corpus in both configurations: native Markdown, text, image/PDF
with a deterministic fake Reader, and RDF literals. Exercise authenticated HTTP
and search, then compare canonical results after removing backend timing fields.
The test must assert:

- native and alternate representations at the same source URI;
- the complete Accept matrix, `Vary`, and distinct ETags;
- public GET never calls Reader;
- source write without Reader config;
- later config discovery and automatic reconciliation;
- FTS-only success and later vector convergence on identical keys;
- move/delete/restart/model-upgrade behavior;
- unauthorized resources are filtered before final top-k;
- no `.md` containment entry or parse-history resource exists.

- [ ] **Step 4: Run RED, then implement only missing wiring**

```bash
bun run test:run -- tests/storage/rdf/RdfTextProjection.test.ts tests/integration/ReaderTextRepresentation.integration.test.ts
XPOD_RUN_READER_CLOUD_E2E=true bun run test:run -- tests/integration/ReaderSearchParity.integration.test.ts
```

Expected before the final wiring: at least the integration tests FAIL.

Use the canonical UDFS exclusion set in `RdfTextProjection`; do not match by
labels or old namespace aliases. Wire the already-tested components into both
Local and Cloud without edition-specific semantic branches.

- [ ] **Step 5: Delete superseded surfaces**

```bash
rg -n "DocumentModel|modelType.*reader|ReaderAiConfig|HeadingChunker|VectorIndexingListener|vocab\.undefineds\.co/udfs|reader.*fallback|generated.*\.md" src config tests docs/COMPONENTS.md docs/progressive-semantic-index.md
```

Remove every production match belonging to the superseded design. Do not add a
compatibility parser, migration, fallback, or deprecated export.

- [ ] **Step 6: Run focused and full verification**

```bash
bun run test:run -- tests/document/ReaderModelSelection.test.ts tests/document/ReaderMaterializationRepository.test.ts tests/document/ReaderMaterializationNote.test.ts tests/document/ReaderRepresentationResolver.test.ts tests/document/ReaderReconciler.test.ts tests/document/MarkdownRetrievalPointProjector.test.ts tests/storage/ReaderRepresentationStore.test.ts tests/service/RdfSearchIndexingService.service.test.ts tests/service/RdfRunContextRetriever.service.test.ts tests/storage/rdf/RdfTextProjection.test.ts tests/integration/ReaderTextRepresentation.integration.test.ts tests/integration/ReaderSearchParity.integration.test.ts
bun run build
bun run typecheck:test
XPOD_RUN_READER_CLOUD_E2E=true bun run test:run -- tests/integration/ReaderSearchParity.integration.test.ts
bun run test:integration
```

All commands must exit 0. The full integration run is mandatory after the
focused tests; it is the final regression gate, not the first diagnostic loop.

- [ ] **Step 7: Update component and search documentation**

Document `ReaderRepresentationStore` as the ResourceStore equal-position
replacement, the internal body/Note split, exact Reader selection, one mdast
projection, FTS-without-VEC behavior, and identical Local/Cloud semantics.

- [ ] **Step 8: Commit**

```bash
git add src/storage/rdf/RdfTextProjection.ts tests/storage/rdf/RdfTextProjection.test.ts tests/fixtures/DeterministicDocumentReader.ts tests/integration/helpers/ReaderAcceptanceHarness.ts tests/integration/ReaderTextRepresentation.integration.test.ts tests/integration/ReaderSearchParity.integration.test.ts docs/COMPONENTS.md docs/progressive-semantic-index.md config/xpod.base.json config/local.json config/cloud.json
git diff --cached --check
git commit -m "✅ Hold Reader search to one cross-edition contract" -m "Exclude materialization metadata and verify representation, lifecycle, authorization, FTS, and vector behavior end to end." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: build, test typecheck, focused acceptance, and full integration suite"
```
