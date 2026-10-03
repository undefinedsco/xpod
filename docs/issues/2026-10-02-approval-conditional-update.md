# Approval decisions require fail-closed conditional writes

Observed with drizzle-solid 0.3.24 and models 0.2.59. Two clients can both
read a pending Approval and then overwrite each other's approved/rejected
terminal decision through `updateByIri`.

Reproduction: pause two decision callers after their initial pending read;
allow the approval write to complete, then release the rejection write. Both
calls succeed and the last write replaces the decision.

`claimControlRequest` is also read/update/read, not an atomic compare-and-swap.
The ORM's exact mutation API has no conditional version argument. Public
`where` rejects id/@id and `whereByIri` replaces the predicate conditions.
`UpdateBuilder.convertUpdate` generates deletion followed by an unconditional
insertion. The SPARQL transport retries HTTP 412 with a refreshed ETag and may
retry without the original precondition. Neither surface can preserve the
version the decision was made against.

Temporary shared-model adapter: GET the complete approval document as Turtle,
require a strong ETag, validate the actual subject in that same representation,
preserve unrelated triples with n3, and perform exactly one PUT using that
ETag in If-Match. Missing/weak ETags fail closed. HTTP 412 returns conflict;
there is no unconditional retry. The shell only calls this shared helper.

Server prerequisite: GET must return a correct strong representation ETag and
conditional PUT must compare and replace under one resource write lock. CSS
LockingResourceStore wraps setRepresentation in withWriteLock, including
condition validation by DataAccessorBasedStore. Deployment acceptance must
still exercise two clients against the current Gateway; a fake server or
source inspection alone does not establish live deployment behavior.

Remove this bypass when drizzle-solid exposes an exact conditional mutation
that retains the original version and never retries failed preconditions.

## Run cancellation has the same blocking gap

Desktop Task acceptance exposed a second use of the missing primitive: a Run
finisher reads a running Run, waits while updating its Session, then saves its
old full row after Stop has persisted `cancelRequestedAt`. The old save clears
the cancellation and can publish `failed` or `running` over `cancelled`.
Queued manual execution makes the start transition susceptible as well.

The installed ORM still forbids `id` in public conditional `where` and its
update compiler extracts the target id without retaining other predicates.
Its ETag retry also replaces the original version. An additional read or a
process-local mutex cannot protect independent API/runner writers.

The Run adapter therefore needs the same strong-ETag document boundary: read
state and version together, merge cancellation monotonically, preserve other
subjects in the document, and conditionally replace exactly that version.
Unlike an approval decision, a Run update may retry a conflict only after a
fresh document read and recomputing the transition against its latest state.
Run schema and serialization remain owned by models and drizzle-solid.
