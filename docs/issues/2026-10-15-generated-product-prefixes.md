# Distinct compiler prefixes for preview and AFS commands

CI 38706235746 failed in the normal root build:packages AFS producer path.
The earlier preview source correction legitimately removed unused __toESM
helpers (755 bytes), but changing the common generated index also changed
what the AFS command notice collector expected. AFS commands still emit the
original reviewed 1867-byte prefix including __toESM. The command library's
CJS profile is separately derived and was not the failing collector call.

Retained real AFS command-host.mjs bytes in the integration tree contain the
exact original prefix a3e72d01f26bcd39142331f3a6d2033a495188dc06ab7b477f728f88afcff0a7.
The new explicit afs-commands profile binds those bytes and retains the full
original pinned runtime.js / ParseTask attribution and helper source lines.
The explicit preview profile binds 3ebc0b0d70e161eed359ca6057bdb960e72ea886916b35534b57e9a2b34c21d5,
with its own retained helper attribution. Neither consumer accepts the other's
valid profile. No wildcard or prefix normalization is introduced. Unknown
profile names are rejected before reading a profile path.

Small notice regressions cover both positive selections, exchanged profiles,
changed bytes and an unknown path-shaped profile. They do not replace a fresh
normal root build:packages or cold AFS producer run. Those gates await the
shared disk window, followed by real remote CI; retained output inspection
alone is not qualification of a newly built artifact.

Follow-up consumer audit found scripts/workspace-runtime-materials.cjs as an
additional real caller. The initial package-only count was incomplete. Its
helper derivation admits transformed helpers from reviewed profiles only when
basePrefixSha256 matches the shared index. Changing the shared base to preview
755 incorrectly skipped the old core/client authorities; the reviewed __toESM
AST was rejected. A new test reproduces that exact failure with the 755 base.
The follow-up restores the original shared 1867 base and its original full
provenance. Preview continues to select its explicit 755 profile, AFS commands
select their explicit 1867 profile. No helper AST algorithm, base-authority
comparison or existing profile provenance is changed. The retained three real
ai-connections-runtime CJS products were also checked, without rebuilding them;
this only checks their existing prefix consumption, not cold build acceptance.
