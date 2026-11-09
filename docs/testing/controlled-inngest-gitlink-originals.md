# Controlled Inngest Gitlink originals

The website dependency has one policy-selected Gitlink evidence recipe. It is
independent of the five complete archive originals and their actual acquisition
HTTP references.

`reviewed-github-contents-original-v1` retains the historical response bytes in
`packages/xpod-api/scripts/inngest-website-gitlink.original.json`. The immutable
policy pins its path, size and SHA256. Its response URL names the exact parent
Inngest commit; the submodule path, child commit and repository must match the
same policy. The original bytes are preserved without JSON reserialization.

Acquisition reads the fixed source original through held, no-follow parent and
file descriptors, checks the full bytes and identities, and validates all such
proofs before any archive request. It makes no GitHub Contents API request for
this recipe. The website archive still requires the actual fixed codeload HTTP
response and complete size/SHA256 verification. Preparation rechecks the fixed
Gitlink original before extracting the exact recursive Go embed projection.

The retained `gitlinkOriginal` has the explicit historical kind and
`trackedOriginal` reference. It has no HTTP status: it does not claim a new
HTTP200 response in the current run. Unknown kinds, missing or changed originals,
wrong parent/path/repository/commit, links and old/new recipe substitutions fail
closed. There is no token, user path, environment selection or network fallback.

Historical policies with no `gitlinkEvidence` retain the original fresh,
anonymous HTTP200 API recipe. A historical source group is selected in full;
new evidence does not grant an old source group new obligations or authority.

The private reader and stager use the shared Gitlink codec. Complete source
binding registration must include the new fixed original and the changed policy
and helpers before this recipe is eligible. This evidence proves the reviewed
Gitlink relationship only. It does not mean the full website tree was extracted,
or grant source, licensing, native ABI or product release qualification.
