# External normal producer workspace

The pinned extensions source has no Vitest configuration. A checkout under
Xpod's `.test-data` can inherit Xpod's Vitest config and resolve its setup file
against the external source. The normal producer therefore uses an exclusive,
identity-checked OS-temp workspace outside the host repository. If the selected
temporary parent is inside the host, it refuses to run. No upstream config,
manifest, test, typecheck, prepare, Git pin or pack arguments are rewritten.
The existing shared child runner waits for `close` before returning; this is
not a claim of universal detached-descendant closure.

The original normal archive is written to its original absolute output path.
Before cleanup, its manifest and every regular payload are compared with the
actual external source/build outputs. The original manifest, before/after
tracked snapshots and observed payload hashes survive in the lane evidence.
The owned workspace is then removed with parent/root identity checks. Subsequent
supply and portable retained readers rehash the original archive and manifest,
check the external pin/snapshots and measured payload observations, and never
read stale native source coordinates or repack an installed package.

Tests execute a tiny actual Vitest upstream without its own config: nested
under a host setup sentinel it fails, while the same normal script in isolation
passes. A separate tiny Git/prepare/pack fixture verifies cwd, exact pin,
original commands, source cleanup and post-cleanup byte readback; its no-op
dependency install is explicitly synthetic. These are contract checks, not a
normal extensions product run or release qualification.

Before/after snapshots have their own retained original references. Current and
portable readers rehash those originals and require exact equality with the
inline receipt snapshots. Each snapshot's internal input hash, external pin,
status flag and tracked file identities are checked again. Non-output tracked
files must remain identical across the two snapshots; only output roots derived
from the original manifest can change payloads. A fresh caller receipt hash does
not override a changed snapshot or substitute for its retained original. These
checks use canonical retained members and never reopen the deleted source path.
