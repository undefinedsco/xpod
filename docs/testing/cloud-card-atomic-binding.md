# Cloud card storage binding must use an atomic additive patch

## Reproduction and cause

`tests/provision/CloudProfileCreator.test.ts` prepares a Cloud identity card using
the installed CSS templates and a real native ResourceStore. Between reading the
card for finalization and writing its storage binding, an owner updates a FOAF
name. Both writes occur in the same second. A whole-document read/modify/PUT
loses the owner change even when guarded by `BasicConditions` and `If-Match`.

CSS `ResourceUtil.updateModifiedDate` deliberately drops milliseconds.
`BasicETagHandler` constructs its ETag from that modification time and content
type. Consequently two different Turtle documents written in one second can
have the same ETag. Waiting until the following second only hides the failure.

## Chosen control-plane operation

CloudProfileCreator sends an additive `INSERT DATA` patch through the existing
CSS `ResourceStore.modifyResource` contract. It adds the WebID's `solid:storage`
and `pim:storage` relations without replacing the card's other RDF. The configured
`SparqlUpdateResourceStore` executes the document-graph update; CSS's native
locking/patching chain also provides an atomic fallback for supported stores.
The patch is parsed by the installed CSS `SparqlUpdateBodyParser`, so it carries
the actual SPARQL algebra expected by both paths. `If-Match: *` requires the card
to remain present. Storage failures propagate to provisioning rather than being
reported as success.

This card is an identity/discovery document, not data in a user storage Pod.
Its server-side creation, native auxiliary authorization and atomic update belong
to CSS ResourceStore. A drizzle-solid session would require an authenticated
client and network transport and would bypass the existing component/store
contract; it is unsuitable for this server control-plane operation. This record
documents that boundary before introducing the direct protocol patch.

## Creation and namespace protection

New identity resources use `If-None-Match: *`. Cleanup tracks only successful
creations: a failed conditional claim must never delete another creator's
resource. An unknown backend partial write is left intact, rather than assuming
ownership and deleting it.

Profile preparation and native Cloud Pod creation must share
`CloudProfileCreator.withNamespaceLock` for the entire check/generate sequence.
The lock has a separate key from ResourceStore's canonical resource lock, avoiding
recursive lock acquisition. Conditional writes alone cannot protect against a
native creator that checked the name earlier and then writes unconditionally.
Existing Cloud storage Pods keep their original permissions; only newly created
independent identity namespaces receive card-only grants.

## Regression evidence

The focused tests retain the failing same-second owner-edit reproduction and
assert that the additive patch preserves both the edit and the new storage
binding. They also cover both storage predicates, multiple Pods, failure
propagation, real native conditional creation, failed-claim cleanup safety and
the shared namespace-lock contract. Full runtime acceptance additionally must
confirm Cloud profile GET and Local Pod access with no Local public route.


## Issue: direct PATCH authority differs from query preparation capability

The real Cloud/Local no-public-route fixture (v5) creates the Cloud card
successfully, but finalization returns HTTP 400:
`Native prepared update only supports by-line local RDF graph documents`.
The PostgreSQL-backed RDF query engine can prepare the update; that does not mean
MixDataAccessor can commit a native source-file delta for the extensionless
canonical document. The earlier regression used a plain CSS backend and missed
this MixDataAccessor boundary.

Reproduce by parsing an additive `INSERT DATA` using CSS's
SparqlUpdateBodyParser and sending it to the extensionless RDF identifier through
SparqlUpdateResourceStore + MixDataAccessor. The old store consumes the patch
stream before the accessor rejects its target. Mapping that rejection to 400
prevents CSS PatchingStore from trying its native document patcher; catching the
error as 501 afterward would also reuse an already consumed stream.

The narrow correction is a generic per-resource direct-update capability on the
accessor. MixDataAccessor declares only existing by-line RDF identifiers eligible
for direct authority deltas. SparqlUpdateResourceStore validates request conditions
first, then declines unsupported targets with NotImplementedHttpError before
reading the patch or preparing a delta. CSS PatchingStore can apply the original
algebra/stream under the existing outer canonical resource write lock. Supported
by-line updates retain their native path, including its syntax, scope and disabled
feature errors. There is no identity/provider branch, lock-free card replacement,
client session, or drizzle-solid bypass for user Pod data.


`tests/storage/SparqlUpdateResourceStore.capabilities.test.ts` reproduces the
original 400 using the actual Mix accessor and installed CSS parser, patcher,
ResourceStore and canonical lock decorators, without a native-engine subprocess.
The correction preserves the unread patch stream, both storage predicates,
concurrent owner additions under the same canonical lock and the same
second-level modification time. It also checks the original If-Match precondition,
by-line direct dispatch, syntax/unsupported-operation errors and native 400/403
mapping without catch-and-fallback. The focused storage suite passes 43 tests in
each checkout, and `build:ts` passes in each. PostgreSQL-backed runtime evidence
belongs to the separate no-public-route fixture; these focused tests do not claim
a production Cloud/PostgreSQL acceptance result.


## Issue: conditional 304 metadata merges the operational and HTTP ETags

The candidate persisted-revision implementation stores its raw revision in
`HH.etag`. On an initial GET, CSS `assertReadConditions` replaces that revision
with the negotiated HTTP ETag. On a matching `If-None-Match`, however, CSS 8
constructs `NotModifiedHttpError` with the HTTP ETag and then adds all original
representation metadata. This merges two distinct values of the single-valued
`HH.etag` predicate. `ModifiedMetadataWriter` throws while writing the 304.

The real Bun/Electron renewal diagnostic confirmed that the refreshed private
GET had `If-None-Match`, and the response writer received status 304 with one raw
revision and one rendered revision. It was not a refresh authorization failure.
CSS's outer `HandlerServerConfigurator` fallback then wrote an 83-byte 500 error
body while retaining the resource's 64-byte Content-Length. Bun's upstream
parser correctly rejected the extra bytes with
``Parse Error: Data after `Connection: close` ``. This second upstream failsafe
framing issue is separate: changing Gateway error framing improves diagnostics
but does not resolve the original conditional-read failure. No installed CSS
package is edited by this fix.

The response boundary in `RepresentationPartialConvertingStore` now clones
metadata before conversion and before HTTP normalization. After content
negotiation it uses the same pure storage ETag renderer as `StorageETagHandler`
to expose the single HTTP ETag, leaving the persisted revision unchanged. The
standard CSS GET/HEAD conditional path then merges identical RDF quads, retaining
304, Last-Modified and the remaining response metadata. Native
`EmptyErrorHandler` retains the empty 304 body. Cache conditions, permission
checks and 412 errors remain on their existing paths. Duplicate or corrupt
persisted revisions are not silently resolved by choosing one value.

`RepresentationPartialConvertingStore.etag.test.ts` calls the installed CSS
GET/HEAD operation handlers, `BasicConditions`, `EmptyErrorHandler` and
`ModifiedMetadataWriter`. Before the repair, both conditional responses contain
two ETags; response ownership and conversion checks also fail (four causal
failures of six tests). The focused suite after repair passes 18 tests, covering
repeated/concurrent response isolation, the final negotiated content type,
already-rendered tags and unchanged precondition failures. This issue is specific
to the candidate's persisted-revision baseline; the development root lacking
that baseline does not receive an alternate revision implementation.
