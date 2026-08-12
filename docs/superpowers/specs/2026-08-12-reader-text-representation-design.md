# Reader Text Representation and Unified FTS/VEC Design

Date: 2026-08-12

Status: approved direction; implementation planning pending written-spec review

Related:

- [Full-text Index V2 overview](2026-06-23-full-text-index-v2-design.md)
- [Source and retrieval-point design](2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md)
- [Embedding and semantic retrieval](2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md)
- [Local/Cloud QLever capability design](2026-08-08-qlever-local-cloud-capability-design.md)
- [SolidFS move and projection design](2026-06-17-solidfs-move-projection-design.md)

This design supersedes conflicting reader-model, provider-fallback,
ReadDocumentTree-authority, and generated-file identity guidance in
[progressive-semantic-index.md](../../progressive-semantic-index.md). It does
not replace that document's unrelated progressive retrieval and
source/retrieval-point guidance.

## 1. Decision

The original Pod resource is the canonical business entity. Reader output is a
durable, rebuildable text representation of that same resource.

- A non-text resource does not gain a second business identity after parsing.
- Reader Markdown is served from the original URI through HTTP content
  negotiation with Accept: text/markdown.
- The Markdown body lives in a durable derived-representation store, not in the
  resource .meta graph and not in a sibling generated file.
- The resource .meta graph contains one current Reader materialization Note
  with model, engine, version, hashes, coverage, and status.
- FTS and VEC index the same retrieval points and return the original resource
  URI.
- DocumentUnderstandingModel is the dedicated AIModel subclass for models whose
  primary inference contract is document understanding.
- DocumentUnderstandingCapability remains independently composable, so a
  ChatModel can be eligible for the readerModel role without becoming a
  DocumentUnderstandingModel.

## 2. Goals

- Define one textual-representation contract into which document, image,
  audio/video, folder, and other non-text Reader adapters can converge.
- Preserve one canonical identity, one authorization boundary, and one search
  result for each source resource.
- Make Reader output reusable across FTS, VEC, previews, and Agent reads.
- Record enough provenance to rebuild Reader output after source, Reader,
  model, or option changes.
- Allow FTS to work without embedding configuration and let VEC converge later.
- Preserve the same source, retrieval-point, ACL, and result semantics across
  Local and Cloud physical backends.

## 3. Non-goals

- Parsed-output history or multiple active Reader variants.
- User editing of the machine-maintained Reader representation.
- Account-level Reader or embedding configuration.
- A TextObject, ParseResult, DocumentRepresentation, ReaderProvider, or
  ReaderCredential business resource.
- A visible source.reader.md file in the user's container.
- Provider pools, automatic provider fallback, or shared platform Reader
  credentials.
- Implementing every source-specific Reader adapter, or introducing generic
  caption/transcription model-selection relations, in the first delivery.
- Separate chunking policies for FTS and VEC.
- A compatibility layer, data migration, fallback path, or legacy alias for
  superseded model and reader semantics.

## 4. Canonical Identity and Alternate Representation

The source resource is authoritative:

    canonical identity  = original resource URI / stable sourceKey
    authority body      = original resource representation
    derived text body   = text/markdown alternate representation
    search result       = original resource URI

For example:

    GET /photos/a.jpg
    Accept: image/jpeg

    -> original JPEG

    GET /photos/a.jpg
    Accept: text/markdown

    -> current Reader-generated Markdown

The alternate representation has no independent LDP containment entry, ACL,
ACR, path, or business URI. This avoids directory pollution, duplicate search
entities, authorization drift, and move/delete synchronization.

The representation store is persistent across service restarts but remains
derived and rebuildable. Its lookup identity contains:

    sourceKey
    sourceHash
    output media type
    Reader engine URI
    Reader implementation version
    exact AI model URI, or an explicit no-model marker
    Reader options hash

The sourceKey is internal derived-index identity, not a new durable Pod
relationship. The current source URI remains the public locator.

## 5. Reader Materialization Note

The existing UDFS Note plus sioc:about convention is reused. The parsed
Markdown is not itself a Note. The Note is a deterministic current-state
fragment in the source .meta graph, for example:

    <#reader> a udfs:Note ;
      sioc:about <./a.jpg> ;
      udfs:noteKind "reader-materialization" ;
      udfs:representationMediaType "text/markdown" ;
      udfs:readerEngine <urn:xpod:reader:paddleocr-official-api> ;
      udfs:readerVersion "1.0.0" ;
      udfs:generatedWithModel
        </settings/providers/paddleocr.ttl#paddleocr-vl-1.6> ;
      udfs:sourceHash "sha256:..." ;
      udfs:readerOptionsHash "sha256:..." ;
      udfs:representationHash "sha256:..." ;
      udfs:coverageUnit "page" ;
      udfs:coveredRange "1-12" ;
      udfs:readUnits 12 ;
      udfs:totalUnits 12 ;
      udfs:status "complete" .

The Note stores only queryable provenance and lifecycle facts. It never stores:

- the Markdown body;
- API keys, tokens, credential contents, or signed URLs;
- duplicated provider/model labels that can be followed from the model URI;
- vendor response payloads that are not needed for rebuild or audit.

One source has at most one current Reader materialization Note. Reprocessing
replaces it in place. There is no parse history resource.

generatedWithModel is required when an AI model produced the representation.
A deterministic local Reader records only its stable engine URI and
implementation version; it does not invent an AI model resource.

The durable shared statuses are:

- pending: eligible work has no current valid representation;
- complete: the Note fingerprint matches the served representation;
- stale: the source changed and the old representation is not valid;
- failed: a non-retryable read or materialization failure occurred.

Quota waits and scheduler leases are operational queue state, not new shared
Pod classes. A bounded failure category may be recorded for visibility without
persisting provider payloads.

The Note is the durable externally meaningful materialization state. A complete
Note describes the committed representation and acts as its commit marker. If
a source-valid old representation remains active while a new model is tried,
the Note remains complete for the old fingerprint. The replacement attempt
stays in operational reconciliation state. failed is written to the Note only
when no valid committed representation exists.

## 6. Document Understanding Model Semantics

DocumentUnderstandingModel is an AIModel subclass with this definition:

> A dedicated AI model whose primary inference contract accepts a document or
> page sequence and produces a structure-preserving textual or structured
> document representation without requiring a conversational interaction.

The defining behavior is:

- document input is first-class, including PDF, office, scanned, or multi-page
  image input;
- output preserves reading order and meaningful document structure;
- headings, paragraphs, lists, tables, formulas, and equivalent blocks are
  represented when present;
- Markdown, structured blocks, or structured JSON are normal outputs;
- document parsing/understanding is the model's primary interface.

Examples:

- PaddleOCR-VL and a dedicated Mistral OCR endpoint are
  DocumentUnderstandingModel instances.
- Qwen-VL remains a ChatModel with DocumentUnderstandingCapability and
  VisionCapability.
- An EmbeddingModel that accepts document-derived text remains an
  EmbeddingModel.
- readerModel is an AIConfig selection role, not a class.

DocumentUnderstandingModel instances have
DocumentUnderstandingCapability by default and may additionally advertise
OCRCapability, VisionCapability, StructuredOutputCapability, or other
composable capabilities.

The broad DocumentModel class is removed. It would only be justified as a
parent for multiple durable kinds such as document understanding and document
generation; the current product has no such requirement.

## 7. Model, Provider, and Credential Policy

Document/page Reader selection uses the Pod's AIConfig.readerModel relation and
an exact model resource URI.

- The selected model must have DocumentUnderstandingCapability.
- A dedicated model normally has rdf:type DocumentUnderstandingModel.
- A capable ChatModel may also fill the readerModel role.
- Exact released model resources are used; an ambiguous persisted latest model
  is not used for provenance or rebuild decisions.
- Provider and credential resolution follow the existing Pod-owned AI provider
  configuration.
- User AI secrets remain in the user's Pod credential boundary and are resolved
  just in time.
- Server environment variables are not a user configuration mechanism.

AIConfig.readerModel is deliberately not a universal selector for every kind
of source:

- native text, including native Markdown, needs no Reader model selection;
- document/page understanding uses readerModel and requires
  DocumentUnderstandingCapability;
- a future speech-transcription or image-caption adapter must use its own
  source-specific capability and model-selection relation, then publish the
  same Markdown materialization contract;
- those additional adapters and relations are outside the first delivery and
  are not predeclared by this design.

PaddleOCR Official API with PaddleOCR-VL-1.6 is the recommended initial
document Reader because it provides document-to-Markdown behavior and is
mainland-friendly. The user supplies the credential. Xpod does not provide a
shared PaddleOCR token.

There is no automatic provider fallback. A missing credential, quota
exhaustion, or provider outage leaves the source intact and lets reconciliation
resume against the same selected model.

The representation contract is broader than document understanding. A
source-specific Reader records the actual model class it used: for example, an
audio transcription model remains a SpeechRecognitionModel, and an image
caption produced by a general multimodal model remains attached to that
model's actual class and capabilities. These models do not become
DocumentUnderstandingModel merely because their output is Markdown.

## 8. Component Boundaries

### Shared models package

The shared models package owns:

- DocumentUnderstandingModel and its AIModel inheritance;
- canonical model capability URIs;
- the AIConfig.readerModel URI relation, eligibility semantics, and selection
  helper;
- durable Reader Note predicates whose meaning is shared across clients.

### Xpod Reader adapter

The Reader adapter owns provider-specific input/output translation. Its common
output is Markdown plus bounded provider-neutral coverage metadata. The first
delivery implements document/page understanding; later source-specific
adapters reuse this output contract. It does not write indexes or choose
FTS/VEC behavior.

Xpod replaces the local flat modelType === 'reader' selection in
ReaderAiConfig with the shared AIConfig.readerModel relation and capability
helper. The flat path is deleted rather than retained as an alias or fallback.

### Reader reconciler

The reconciler compares the current source, desired Reader/model selection, and
current Note fingerprint. It schedules or performs only the missing work. Pod
configuration changes trigger Pod-scoped reconciliation.

### Derived representation store

The representation store persists complete generated Markdown keyed by the
materialization fingerprint. It is not visible as a normal user file and does
not own authorization policy.

### Representation-serving layer

A dedicated Reader representation layer participates in ResourceStore
getRepresentation for text/markdown preferences. The existing
RepresentationPartialConvertingStore remains RDF-only; Reader behavior is not
added to the RDF converter.

### Text projection and indexes

The text projection layer resolves native text, Reader Markdown, or searchable
RDF literals into existing source/retrieval-point contracts. Physical FTS and
VEC backends consume those contracts without knowing whether content came from
OCR, a captioner, a transcript reader, or a folder reader.

## 9. Materialization Lifecycle

### Source creation

1. The original resource write succeeds without waiting for Reader work.
2. A change event makes the source eligible for reconciliation.
3. Native text sources use their existing body and require no Reader Note.
4. Eligible sources supported by an installed Reader adapter and lacking a
   valid fingerprint become pending.
5. The selected Reader produces Markdown into a new derived-store entry.
6. The reconciler writes the complete representation first.
7. The reconciler updates the current Note last; that Note update is the commit
   marker.
8. Indexing starts only after the committed Note matches the current source and
   representation.

A crash before the Note swap can leave an unreferenced derived-store entry.
Such an entry is never served or indexed and is removed by bounded garbage
collection. A crash after the Note swap is recovered by idempotently projecting
the committed representation into FTS/VEC.

### Source content change

- A sourceHash mismatch immediately makes the old representation invalid.
- The Note becomes stale and old FTS/VEC points are removed.
- The stale body may remain temporarily in derived storage but is neither
  served as current nor indexed.
- Successful regeneration commits a new body and Note, then rebuilds FTS/VEC.

### Reader, model, or option upgrade

- If the sourceHash still matches, the current complete representation remains
  available while the replacement is generated.
- The desired fingerprint differs from the current Note, so reconciliation
  continues until the new version succeeds.
- The new body is written first and the Note is swapped last.
- The old derived-store entry is deleted after the new Note is committed.
- No compatibility record or prior-version history is kept.

### Missing configuration and quota exhaustion

- Missing applicable source-specific model selection or credential never
  blocks source writes.
- Adding or changing Pod Reader configuration triggers Pod-scoped
  reconciliation of eligible sources.
- Retryable quota and provider errors remain queued with bounded backoff.
- Quota recovery automatically resumes the same work.
- A valid old representation may continue to serve during a model-only upgrade;
  no old representation is served after a sourceHash change.
- No alternate provider or lower-quality Reader is selected automatically.

### Move and delete

- Moving a resource without a content change preserves sourceKey and Reader
  cache reuse.
- The public URI/path projection changes; the content fingerprint does not.
- Deleting the source deletes its Note, derived representation, text points,
  and vector points.

## 10. HTTP Representation Behavior

- The primary resource response remains its original media type and is the
  default when Accept is absent.
- Negotiation considers only representations that currently exist and have a
  positive quality value. The primary representation wins equal-quality ties.
- A valid Reader representation is selected only when text/markdown has a
  strictly higher negotiated quality than the primary media type, or when the
  primary media type is unacceptable.
- Wildcards alone do not displace an acceptable primary representation. Thus
  Accept: */* and browser-style ties return the primary bytes.
- Responses vary on Accept and use a representation-specific ETag.
- Authorization is evaluated against the original resource identifier before
  either representation is returned.
- A stale or missing Markdown representation is never returned as current.
- If no valid Markdown exists but the primary representation is acceptable, the
  primary representation is returned. A request that accepts only
  text/markdown receives 406 Not Acceptable while no valid Markdown exists.
- Public GET does not synchronously call an external Reader. Reader work is
  driven by reconciliation.
- Internal indexing and public GET use the same representation resolver so the
  indexed bytes and served bytes cannot drift.
- The alternate representation is read-only. PUT, PATCH, and DELETE continue to
  mutate the canonical resource; any such source mutation invalidates the
  Reader representation through the normal source lifecycle.
- For a native text/markdown resource, the primary body satisfies
  text/markdown directly; no derived-store lookup or Reader Note is involved.

## 11. Markdown Structure and Chunking

Reader output is normalized to Markdown. The indexer parses it with
mdast-util-from-markdown.

- Heading hierarchy defines section paths.
- Paragraphs and structural leaves are the default retrieval points.
- Oversized leaves are subdivided using explicit token/byte budgets.
- Chunk identities are deterministic for the same source, representation
  content, and chunking-policy version.
- Reader/provider-specific output kinds are not persisted in the shared index.
- The Reader owns OCR, caption, transcript, table, and layout interpretation.
- The indexer owns Markdown structure, chunk budgets, retrieval-point identity,
  and search projection.

The same chunks feed FTS and VEC. The product does not maintain one segmentation
for keyword search and another for embeddings.

## 12. Unified FTS/VEC Contract

All searchable content converges on the existing internal source and
retrieval-point contract:

    native text body -----------+
    Reader Markdown ------------+--> retrieval points --> FTS and VEC
    searchable RDF literals ----+

Rules:

- sourceKey identifies the original source.
- retrievalPointKey equals the stable chunk/retrieval-point key.
- FTS and VEC candidates join on sourceKey plus retrievalPointKey.
- Fusion happens at retrieval-point level.
- Final results group by sourceKey and expose the current original URI.
- Snippets come from the matching authorized text chunk.
- Reader Notes, hashes, provider identifiers, and operational statuses are
  classified as system/structured metadata and do not enter the searchable
  body.

FTS becomes queryable as soon as a valid text projection is committed. VEC is
optional derived state:

- without embedding configuration, FTS continues to work;
- when embedding becomes available, vectors are added for the existing
  retrievalPointKey values;
- embedding retries do not rerun Reader or chunking;
- changing only the embedding model rebuilds vector points, not Reader output
  or FTS chunks.

## 13. RDF Alignment

RDF resources do not pass through the document Reader by default.

- Searchable RDF literals continue to use TextIndexPolicy.
- Predicate, datatype, language, graph, and subject provenance remain intact.
- Raw Turtle, RDF/XML, or JSON-LD serialization is not indexed as entity body.
- RDF FTS and RDF VEC use the same entity-card or field-chunk retrieval points.
- Reader materialization Note predicates are system metadata and are excluded
  from FTS/VEC body projection.

This keeps RDF exact facts, RDF textual search, document text, and semantic
vectors joinable without pretending that RDF serialization is a document
summary.

## 14. Local and Cloud Semantics

Local and Cloud expose the same:

- sourceKey and retrievalPointKey meanings;
- Markdown chunk content and chunk-policy version;
- authorization scope;
- FTS/VEC join identity;
- canonical result URI and provenance shape;
- stale, delete, and move behavior.

SQLite/PostgreSQL, RDF3X/QLever integration, tokenizer, ANN implementation, and
rank execution may differ physically. Those differences must not create a
second product-semantic definition.

## 15. Security and Privacy

- The source ACL/ACR authorizes primary and text/markdown representations.
- Authorization and path scopes are applied before final top-k.
- A derived representation cannot be fetched through an independent URL.
- Reader credentials and raw provider responses never enter Notes, indexes, or
  logs.
- Search snippets are treated as untrusted source content.
- Derived storage, queue records, and indexes are deleted with the source.
- Provider/model metadata is visible only where the source .meta graph is
  authorized.

## 16. Acceptance Gates

### Shared model gates

- DocumentUnderstandingModel is a real AIModel subclass.
- The broad DocumentModel class and its compatibility aliases are absent.
- Dedicated document models receive DocumentUnderstandingCapability by
  default.
- A ChatModel with DocumentUnderstandingCapability is eligible for
  AIConfig.readerModel without changing class.
- Model-backed Reader Notes use exact model URIs; deterministic Readers do not
  invent model resources; neither form contains secrets.

### Representation gates

- The same image/PDF URI returns the primary bytes for its native media type and
  Reader Markdown for Accept: text/markdown.
- Missing Accept, Accept: */*, and equal-quality ties return the primary bytes;
  a strictly preferred valid text/markdown representation returns Markdown.
- Responses include correct Vary and representation-specific ETag behavior.
- A missing or stale Markdown representation is not returned.
- A native text/markdown resource returns its original body and never requires
  or gets shadowed by a Reader materialization.
- Public GET never invokes an external Reader synchronously.
- The representation bytes used by indexing equal the bytes served publicly.

### Lifecycle gates

- Source writes succeed with no Reader configuration.
- Adding Reader configuration reconciles existing eligible Pod resources.
- Source hash changes remove stale search points before replacement completes.
- Reader/model upgrades keep a source-valid old representation until atomic
  replacement succeeds.
- Quota exhaustion retries automatically without provider fallback.
- Move without content change reuses Reader output and preserves sourceKey.
- Delete removes Note, derived body, FTS, and VEC state.
- Restart recovers pending/stale reconciliation without duplicating work.

### Search gates

- Searching Reader-derived content returns the original resource URI and never
  a generated .md identity.
- FTS and VEC results for the same content share retrievalPointKey.
- FTS remains usable with no embedding model.
- Adding embedding later fills vectors without rerunning Reader or rechunking.
- RDF searchable literals preserve field provenance and exclude serialization
  boilerplate.
- Reader Note metadata is not searchable body text.
- Unauthorized resources do not enter final top-k in Local or Cloud.
- Local and Cloud produce the same canonical source/retrieval-point result
  shape for the shared conformance corpus.

## 17. Rejected Alternatives

### Parsed output as the canonical entity

Rejected because Reader output is reproducible, model-dependent, and
replaceable. It must not own identity, authorization, path, or user intent.

### Independent TextObject or ParseResult

Rejected because it creates a duplicate entity and requires extra ACL, move,
delete, query hydration, and deduplication behavior.

### Visible generated Markdown file

Rejected because it pollutes user containers and gives a derived representation
an unnecessary URI and containment lifecycle.

### Full Markdown in .meta

Rejected because metadata is for queryable facts and normal metadata reads
should not load or rewrite a document-sized literal.

### Broad DocumentModel class

Rejected because the current requirement has one durable dedicated kind:
document understanding. A speculative umbrella class adds no current
semantics.

### Reader capability only, with no dedicated subclass

Rejected because dedicated document-understanding endpoints have a stable
cross-product primary inference contract and the product requires AI model
subclasses. Capability remains necessary for composability and role
eligibility.

### Automatic Reader provider fallback

Rejected because it changes quality, cost, privacy boundary, provenance, and
output stability without an explicit user decision.

### Separate FTS and VEC segmentation

Rejected because it duplicates lifecycle state and prevents exact
retrieval-point fusion.

## 18. Implementation Planning Boundary

Implementation planning must proceed in dependency order:

1. add the shared AIConfig.readerModel URI relation and selection helper,
   DocumentUnderstandingModel, capability vocabulary, and Reader Note
   predicates; replace Xpod ReaderAiConfig's flat modelType === 'reader'
   selection and delete the old path;
2. freeze the Reader materialization fingerprint and Note read/write contract;
3. implement the durable derived-representation store;
4. add the Reader representation-serving layer without expanding the RDF
   converter;
5. implement reconciliation, invalidation, retry, move, and delete behavior;
6. normalize Reader Markdown through the shared mdast chunker;
7. connect existing text/vector source identities to the representation
   resolver;
8. run focused model, representation, lifecycle, ACL, search, and
   cross-backend conformance tests;
9. delete superseded DocumentModel, flat reader model-type, generated-file,
   provider-fallback, and duplicate chunking paths.

No compatibility layer, migration, fallback, or speculative configuration
surface is part of this design.
