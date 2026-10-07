# drizzle-solid 0.3.24: canonical protocol publication needs a guarded property update

Observed on 2026-10-03 while designing owner-published Matrix membership authority. No live Pod was changed by the reproduction.

## Reproduction

Compile the public API `db.update(chatResource).set({ metadata: { '@id': existingMetadataIri, protocols: nextProtocols } }).whereByIri(canonicalChatIri).toSPARQL()`.

The actual AST contains two updates: the first deletes the Chat-to-metadata edge and all outgoing triples of the old metadata subject; the second inserts the supplied metadata object. A partial metadata object would therefore remove root `memberRoles` and unrelated fields. This is object replacement behavior, not a safe update of only `protocols`.

The public insert serializer can produce the new typed JSON term, but a full Chat insert also emits model defaults such as status, dates and favorite. Executing that whole insert would change unrelated facts. Neither ordinary update nor insert supplies a compare-and-set against the previously proven raw source snapshot.

The zero-network AST evidence is saved in `.test-data/solid-multiparty-acceptance/provider-b/root-review/purpose-binding-prerequisite/orm-protocol-update-result.json`. Earlier diagnostic attempts with `where(id)` and an author-only condition were rejected by the public exact-resource contract; the corrected probe uses the exported `whereByIri` API. Those rejected probes do not establish another product defect.

## Required contract and bounded adapter

A property update should atomically replace only the expected protocol term, reject a stale or ambiguous source snapshot, and preserve all unrelated RDF facts. A `204` with no matching condition must not be reported as a successful publication.

Until this conditional contract exists, Xpod may use the same public serializer / authenticated dialect bridge recorded in [the existing atomicity issue](drizzle-solid-matrix-atomicity.md): extract the one ORM-generated protocols triple for the exact existing metadata subject, then construct a single `DELETE / INSERT WHERE` with sparqljs. Match the current raw type, author, metadata edge, participants, root roles and old protocol term; reject additional terms with `sameTerm` guards. Change only the old/new protocol term, and prove the committed result by a fresh canonical read.

This records the gap before any bypass. It does not authorize an unconditional PUT, private SDK access, copied models layout, cross-document atomicity claim or C2 activation. The publication adapter and its authenticated concurrency/crash acceptance are still pending.

## Publication queue carrier: exact conditional deletion

The zero-network public `db.delete(taskResource).whereByIri(recordSubject).toSPARQL()` probe actually completed with exit 0 on 2026-10-03. It emits `DELETE { GRAPH <document> { <recordSubject> ?p ?o } } WHERE { GRAPH <document> { <recordSubject> ?p ?o } }`, without comparing the record metadata or other expected facts. Evidence: `.test-data/solid-multiparty-acceptance/sol-membership-binding-prerequisite-20261003/control-delete-public-orm-probe.json`. No HTTP request or upstream SDK change was made.

The existing Pod outbound carrier reads a batch and then calls this ordinary deletion. During owner publication recovery, an old single-event batch could change into a mixed batch between that read and deletion; deleting it would discard unrelated events. Rebinding the entire mixed batch to the incoming grant would also broaden authority. General queue put/remove behavior is outside this fix.

The approved publication-only adapter must first persist and read back the complete new named actor and original persistent PDU. It may then delete only the unchanged old single-event record with a single scoped conditional update. Capture the original body, cross-check the complete record with the public ORM, guard all original root/metadata RDF facts and reject additional values with `!sameTerm`, and delete only that record subject. A fresh exact read proves removal, including after a lost response; a stale or mixed record fails closed. This is a local property/record CAS contract, not an upstream fix or a cross-document transaction.

### Publication delivery snapshot transition

The public control-record update/delete APIs do not accept the complete previously read RDF snapshot as a server-side condition. The public exact-IRI delete probe above only guards subject existence; an ordinary insert after that delete can recreate a revoked actor's batch when an old delivery response arrives late. Publication delivery therefore requires the same captured raw/ORM equality and full `!sameTerm` guards as exact cleanup, with one conditional DELETE/INSERT over the old and new explicit resource GRAPHs. A deferred result keeps its transaction; a per-PDU refusal uses a new transaction in the original day bucket. Missing or changed old facts must not create a replacement. This adapter does not claim filesystem crash atomicity across documents.

## Membership snapshot target extension (2026-10-03)

The public `update(chatResource).set({metadata:{'@id':existingMetadata,memberRoles:{},protocols},participants:[]}).whereByIri(sourceIri).toSPARQL()` still compiles a DELETE of the Chat metadata edge plus **all** old metadata outgoing triples, followed by independent INSERT DATA. Combining participant changes therefore does not give an exact source-snapshot CAS and destroys unrelated root metadata. With memberRoles:null the public serializer emits no role triple; with {} it emits the typed empty JSON term. Empty participants emits no participant triples. No network was used in this probe.

Reproduction and actual emitted AST/query: `.test-data/solid-multiparty-acceptance/sol-membership-binding-prerequisite-20261003/lifecycle-a-orm-probe.ts` and `lifecycle-a-orm-probe.json` (actual exit 0). This extends the existing unresolved compiler issue; it is not an upstream fix. Approved adapter extracts only public ORM target protocol/participant/root-role terms, guards the complete old canonical facts using exact RDF terms, and performs one conditional DELETE/INSERT preserving all unrelated facts. Null role deletion uses the old snapshot role terms; serialization remains the public ORM's responsibility.

## Upstream contract to add (2026-10-04 design clarification)

The installed 0.3.24 public API lacks the following generic contract; this section specifies required semantics, not an implemented upstream API or a new method name. Xpod's temporary adapter must eventually converge on the public API when verified.

- Property-level updates must distinguish a nested-object replacement from changing selected properties. Patching `protocols` must preserve metadata roles and unrelated RDF terms.
- Exact-resource conditional update and deletion must accept a previously verified complete RDF snapshot, compare exact terms including datatype/language, and execute comparison plus mutation atomically on the server. No-match is a conflict; an unconditional fallback is forbidden. For `messages.ttl#msg-id`, delete only that unchanged subject and its declared owned structure, preserving other subjects in the document.
- Mutation outcomes must distinguish applied, conflict and unknown. An HTTP204 or `.returning()` readback alone cannot prove that this attempt matched the old condition. Lost responses must remain unknown until a qualified fresh recovery read; stale evidence cannot silently adopt a later winner. Callback `transaction` does not establish server transaction or isolation semantics.

The ORM owns the public query/serialization/conditional-result interface; Xpod must provide a qualified native atomic primitive and current Solid authorization/lease checks. Shared schema stays in models; Matrix owns membership phases, original actors and incremental cursors. This does not promise cross-document crash atomicity.

The independently measured A4 adapter defects (lost-response mapping, final readback lease, stale full-source replay and historical actor Pod registration) are Xpod defects to repair now; adding an upstream API does not excuse them. The existing issue-first authenticated conditional bridge remains the bounded implementation path until the public generic contract exists. No drizzle-solid source or dependency version was changed by this clarification.

### Exact recovery evidence boundary observed locally

Root's unfiltered actual indexed CSS/SQLite/Comunica owner-recovery tests (2026-10-04, exec29866:25pass/3fail; exec83027:26pass/6fail, unchanged inputs) show why a full old-WHERE plus checking only the new marker is insufficient. A later readback may carry changed unrelated RDF or original event facts; a reused old handle after a genuine lost committed response may submit an empty condition and see the same persisted marker. The Xpod adapter must validate the complete intended result and invalidate used mutation evidence, allowing confirmation only from a fresh controlled read. This is an adapter repair and does not establish a generic ORM applied-result contract or policy-creation provenance.

For lost ACP policy responses, a reservation written before the write and a deterministic same-shaped graph are not actual commit receipts. Runtime proof maps disappear on restart. Existing storage per-resource journaling must be inspected for an authenticated complete before/after and its crash gap; its existence alone is not proof. A viable receipt must be coupled to the actual durable policy mutation, rather than independently inserting another control document. Shared receipt schemas, if required, belong to models. Qualified native persistence and current authorization remain Xpod obligations; no new Matrix CDC/WAL or callback-transaction atomicity claim is permitted.

## Backend atomicity and receipt qualification (2026-10-05)

The A4-P1 adapter repair is now independently green: Root exec38366, all33 unfiltered cases, five input hashes unchanged. This repairs the adapter's exact original tuple, final complete RDF/lease bookends and consumed mutation evidence. It does not add an ORM API or establish complete recovery.

The current storage map identifies a separate Xpod prerequisite. `MixDataAccessor.writeLocalRdfAuthorityPatches` writes the authority file, then records `recordLocalCommitted`, then updates derived indexes. The installed CSS `FileDataAccessor.writeDocument` writes metadata first and uses an in-place `createWriteStream` for the body. An after-write outbox cannot close the file-write-before-journal crash window, and query-level conditionality alone does not prove durable file atomicity.

The public ORM contract and backend qualification are separate:

| Boundary | Required behavior | Independent proof |
| --- | --- | --- |
| Property patch | Replace declared properties only; preserve other RDF terms and nested fields | Patch protocols while retaining memberRoles and unrelated metadata, including exact datatype/language |
| Exact record CAS/delete | Compare the complete declared record closure and dependencies, then mutate atomically; reject stale, missing or ambiguous conditions | Two competing mutations have at most one winner; deleting `messages.ttl#msg-id` preserves99 other message subjects and their metadata |
| Result | Distinguish applied, conflict and unknown; no-match204 and a later matching read are not proof of this attempt | No-match, dropped response after actual commit, and a different writer producing the same RDF remain distinguishable |
| Backend capability | Refuse unsupported guarantees explicitly; never replace server atomicity with client read-then-write or callback transaction | A backend lacking matched-result or durable recovery evidence cannot report those capabilities or silently fall back |
| Single authority document | Readers and restart see a complete old or new document, not partial RDF; metadata and derived indexes have a defined recovery contract | Real owned process crashes during persistence and after persistence/before outbox, followed by reopen and exact RDF/index checks |
| Durable commit provenance | Trust backend-issued evidence coupled to the actual mutation, exact resource and complete before/after state; later client-created lookalikes cannot adopt the commit | Reconstruct after committed response loss; reject foreign byte-identical policy/marker, stale lease/generation and extra incoming links before effects |

Do not implement a client-writable RDF marker alone as trusted provenance, and do not claim multi-document crash atomicity from a prepared multi-graph delta. A backend-specific receipt may remain an opaque transport/storage result; only a receipt actually modeled as shared Pod RDF needs a models schema. The existing Evidence schema has a default dated layout; that default alone does not prove it cannot use an explicit same-document fragment IRI. Inspect the exact-id/type/admission contract before declaring a new schema necessary.

Execution ownership remains: drizzle-solid owns generic serialization/condition/result APIs; Xpod owns authenticated native execution, current authorization/leases and durable storage; Matrix owns membership transitions, original actor events and incremental cursors; models owns any shared RDF schema. The existing authenticated adapter is temporary and remains subject to full-source and native guards. No upstream source, dependency version or storage implementation is changed by this clarification.

A bounded Root prerequisite probe used the installed public CSS `FileDataAccessor`/`ExtensionBasedMapper` against an owned private file, wrote a complete old policy, began an incomplete replacement stream, observed the actual partial body on disk, and SIGKILLed only that own writer. Reopen retained the partial bytes (exec63878, child exit-9, contract failure1); evidence is `root-review/atomic-authority-file-root/safe-result.json`. This independently qualifies the file accessor's missing old-or-complete-new guarantee for incomplete-stream process failure; it is not a real Gateway/native-CAS/QLever crash test and does not claim every native mutation reproduces that exact timing.

## Reuse existing Solid conditional mechanisms before introducing an extension

Official protocol reference review (2026-10-05) identifies standard candidates. Solid N3 Patch requires409 when its nonempty `solid:where` has zero or multiple matches, or not all declared deletes exist: https://solidproject.org/TR/protocol#modifying-resources-using-n3-patches . Strong `If-Match` can bind the entire HTTP resource version, subject to actual backend support: https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1 . Neither removes the need to qualify exact record closure/dependencies, current authorization and complete source comparison. This is an interface/implementation task first, not justification for a new Matrix persistence protocol.

Important qualifiers: Solid strong ETag availability is optional; RFC9110 permits a failed If-Match to produce2xx if an equivalent operation appears already applied, potentially by another client. Strict CAS victory therefore needs a verified server policy or a qualified result, rather than assuming every2xx proves this attempt won. N3 conditional failure is distinct from SPARQL DELETE/INSERT WHERE no-match, which may complete successfully without mutation. A later equal GET confirms state, not which request created it.

PATCH operation-level atomicity is a standard requirement (including directly affected files), and SPARQL defines a single update operation atomically over the Graph Store. Those requirements do not themselves verify this backend's process-crash persistence, provide fsync semantics, or create a transaction across independent HTTP requests: https://www.rfc-editor.org/rfc/rfc5789.html#section-2 and https://www.w3.org/TR/sparql11-update/ . Do not describe the standards as lacking every form of cross-resource atomicity.

Readonly installed-source inspection also found that internal `ComunicaSPARQLExecutor.executeUpdate` can retry409/412 using a refreshed ETag, then no ETag, then PUT. Such retry policy must not be reused by the strict previously-observed-snapshot API. This is an observed internal implementation branch, NOT proof that the currently guarded Matrix adapter traverses it; reachability through the chosen public API must be verified before attributing an actual request. The public package-root export inspection did not expose that executor class. No private SDK entry point was invoked and no live Pod request was made by this inspection.

## Reuse available CSS atomic body writer before adding a replacement

Root's subsequent public-interface inspection found installed CSS `AtomicFileDataAccessor`, already used by its quota-file configuration. The current Xpod RDF authority paths were bound to the plain accessor; the library itself does contain a temp-and-rename body writer. The protected CSS hooks are also declared protected, not private. A custom stream writer is therefore not the first implementation choice.

Independent owned process tests compare both existing public constructors: plain accessor retains partial RDF and changed metadata after SIGKILL midstream (exec9218, actual1); CSSAtomic retains complete old RDF and old metadata, own child exit-9, staging absent from that owner Pod listing (actual0). Evidence: `root-review/css-atomic-reuse-root/{unsafe,atomic}/safe-result.json`. This proves only the exercised regular stable-extension stream/process-crash boundary. It is not configured Xpod/native CAS/current Gateway/QLever/G09 evidence.

The next authorized implementation is one shared RDF-only CSSAtomic instance with explicit local/cloud/xpod/bun bindings. Existing plain/internal and Minio consumers keep their current instance. Its missing fsync, separate metadata write, extension migration and after-file outbox/provenance boundaries remain to be qualified; wiring it must not be described as full durable recovery or a generic ORM CAS-result implementation.

## Public transport reachability clarification (2026-10-05)

Subsequent read-only mapping of the installed 0.3.24 public surface resolves the earlier reachability uncertainty at the static-code level. Ordinary update/delete builders execute through `session.execute`, `PodExecutor`, `LdpStrategy` and `LdpExecutor`; they do not execute their `toSPARQL()` output through Comunica. Compiling an update alone remains a zero-network operation. Public `db.executeSPARQL`, `db.execute`, `podClient.sparql`, and the executor returned by public `db.getDialect().getSPARQLExecutor()` can reach the previously identified Comunica retry branch. No actual HTTP request was made by this mapping, and it does not establish that the current guarded Matrix transport uses that branch.

Strict CAS must also avoid the ordinary LDP retry policy. Installed `dist/core/execution/ldp-executor.js:536` first sends a SPARQL PATCH without If-Match and may retry409/5xx. Its N3 fallback also omits If-Match, may create an absent document with PUT, and may retry409/5xx or transport exceptions. A new strict operation must carry the caller's validated version/condition and return an explicit result without entering either legacy retry chain. Updating only the SPARQL compiler or Comunica executor would leave ordinary writes unchanged.

The installed URI resolvers already remove the fragment for physical HTTP access and retain the exact subject for record mutation. A shared `messages.ttl#msg-id` layout is statically expressible; preservation of neighboring records and actual conditional behavior still require authenticated HTTP acceptance. Exact read currently parses the document and hydrates schema values, without exposing a complete raw-term snapshot plus ETag. Existing mutation results and conflict resolution expose success/retry fields, not the required applied/conflict/unknown contract.

The dirty upstream checkout is not the published version: its HEAD is `a144d7fbc8b10b5165e590f37564bfa42c866824` with package0.3.21, while tag `v0.3.24` exists at `6b49416a73cd56d740e22300408bf75d1cc3a38e`. Any upstream implementation must use an isolated checkout corresponding to the installed behavior and preserve the existing dirty work. Version/tag correspondence does not prove byte-identical rebuilding of the published package. No upstream source or dependency version was changed by this investigation.

## Ordinary replacement erases authority after index failure (2026-10-05)

Independent Root exec45711 ran the single unfiltered `tests/storage/rdf/AuthorityAfterIndexFailure.acceptance.test.ts`, actual exit1. Through the actual locked CSS store and Mix accessor, it submitted parsed RDF with the configured public CSS AtomicFileDataAccessor and injected a failure at the public structured index writer. The complete intended new RDF file was observed before that failure. Afterwards the authority file returned ENOENT: `MixDataAccessor.writeRdfDocument` deletes the authority file in its derived-index error handler.

This is a measured Xpod recovery defect separate from the missing ORM API. The regression requires complete old or complete new authority to remain, without prescribing the commit point or treating a failed indexing response as success. A correct repair must also define subsequent current reads/authorization and index/cache recovery; simply retaining bytes does not establish trusted commit provenance. The first exec35746 took the fixture's Turtle-preserving unstructured path and did not reach the fault injection; that oracle-path error is not product failure evidence. Root corrected only its new test to submit INTERNAL_QUADS. No product repair has been made yet.

Evidence: `root-review/post-file-index-failure-root-result.md`. This private actual CSS/File/SQLite fixture uses a Comunica native-protocol producer, not current-user Gateway, production QLever or Cloud. Historical1985-input passing gates predate this new regression and do not qualify the present test set.

The subsequent exploratory Root freshness file (`tests/storage/rdf/AuthorityIndexFreshness.acceptance.test.ts`, exec20012, actual1/4fail) observes successful fresh-request/warm-hit RDF and native ASK reads despite a missing authority file, and404 from warm-miss after an uncertain write. It accepts current-file-consistent facts (including coherent rollback) or explicit503. These reinforce the need for shared pending/cache/native-read recovery; the B product implementation was concurrently active, so this exploratory run is not a frozen final acceptance. Both Root files remain unchanged by the worker and must be included in final qualification.

## Upstream implementation authorized (2026-10-05)

The user explicitly requested direct drizzle-solid changes. Root created an isolated `codex/drizzle-solid-conditional-writes` worktree at `/Users/ganlu/.codex/worktrees/drizzle-solid-conditional-writes/drizzle-solid`, based on `v0.3.24` (`6b49416a73cd56d740e22300408bf75d1cc3a38e`). The original dirty upstream checkout remains preserved; the isolated baseline CJS/ESM build completed with exit0 using existing dependencies.

The accepted public design adds `readResourceSnapshot(table, exactSubjectIri)` and explicit update/delete `executeConditional({ snapshot })` terminals. The conditional update terminal patches selected nested properties while ordinary CRUD behavior remains compatible. One generic backend compiles standard N3 Patch, uses the captured strong document version once, and returns applied/conflict/unknown/unsupported under an explicitly qualified backend contract. Legacy retry/ETag-refresh/unconditional-PUT paths are excluded. Complete raw terms, neighboring same-document records and actual lost-response behavior are mandatory acceptance cases.

The existing sole executor has begun real CSS regressions and implementation under Root's design and independent acceptance. This records authorization and execution, not a finished upstream API or a qualified release. Root design/evidence: `.test-data/solid-multiparty-acceptance/provider-b/root-review/drizzle-solid-conditional-root-design-20261005.md`; no Xpod dependency version has changed yet. Full Matrix/Gateway/durable storage and runtime delivery gates remain required.

### Independently measured backend prerequisite: version collisions

Root's actual public CSS producer protocol test now completes: six cases, three pass and three fail, actual exit1; the four oracle/helper inputs remain unchanged. Exact raw-body readback confirms the selected value changed, while fast writes in one second retain the same syntactically strong ETag (millisecond number aligned to1000 plus representation type). Old versions therefore cannot distinguish those mutations. The three fast-write failures cannot be counted as strict backend qualification.

The two controlled-time cases separate that defect from ignored preconditions: after waiting1.2seconds before a real mutation, the old and new ETags are genuinely different; both stale non-noop and stale equivalent PATCH receive412, and the confirmed body remains intact. N3 missing-condition409 with unchanged document also passes. Consequently this evidence does not establish that If-Match is ignored or that this producer takes an equivalent-result2xx shortcut; the measured prerequisite is same-second document-version collision. Delaying every ORM write is not a repair.

Evidence in the isolated upstream worktree: `.test-data/root-review/strict-css-protocol-separated-result.json` and `.private.log`. This is actual CSS request/response behavior, not current user Gateway, production QLever or crash durability. The generic public snapshot/compiler/single-attempt API has its first successful build; the backend must reject this failed qualification while the producer's true strong-version boundary is repaired and independently tested. No node_modules or original dirty upstream files were modified.


## Upstream implementation and current qualification (2026-10-05)

The user-authorized upstream worktree now implements `readResourceSnapshot(table, exactIri)` and update/delete `.whereByIri(iri).executeConditional({ snapshot })`. A fragment such as `messages.ttl#msg-id` remains one subject in a shared document. The compiler modifies selected properties and proven owned inline facts while retaining unknown RDF terms and neighboring subjects. Ordinary update replacement semantics remain unchanged. Nested JSON own keys, dates, null deletion and unselected properties have regression coverage.

`StrictIfMatchN3Backend.qualify` supplies standard plural N3 clauses, strict stale-version/equivalent-result refusal and a single mutation attempt tied to the snapshot transport. Unknown response completion is not promoted by a later equal GET. Unqualified scopes return unsupported before mutation; failed/uncertain qualification retains its uniquely owned probe. Snapshot auth body errors preserve 401/403, and cache maintenance cannot erase an acknowledged applied outcome. The upstream public guide documents the contract and qualification boundaries.

Upstream full unit 87 files/891 cases and Root independent 41 cases/public typed caller passed with 1,377 stable inputs. This is bounded API/compiler/raw snapshot acceptance. Actual published Xpod 0.3.71 retains a seconds-based ETag across immediate content changes, so it cannot qualify the strict backend. The Xpod source socket response streaming repair passed actual Node and Bun consumer checks, but unchanged original notifications against the explicitly selected rebuilt target failed its original 120-second startup hook (14 cases not executed). The prior upstream complete integration was incomplete/terminated; neither result is a pass. The document version repair, real supported mutation/concurrency/lost-response qualification, original complete integrations and final Matrix/current-Gateway/release acceptance remain required. No installed dependencies were patched to disguise these failures, and Xpod has not yet switched to the new upstream package.
