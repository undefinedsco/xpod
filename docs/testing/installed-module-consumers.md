# Installed module consumers

`scripts/css-module-consumer.py` and `scripts/api-module-consumer.py` share
`scripts/lib/module-consumer.py` for original-input bindings, isolated runtime
installation, inventory verification, process ownership, raw log closure, disk
observations, removal and retained data. Each adapter owns its service probes.

Both commands accept one JSON plan. Without `--run`, they only validate existing
inputs and do not create the output directory. Real execution requires macOS
arm64 with `sandbox-exec`, Node and Bun executables, and enough disk for the
declared peak plus the separate remaining-space floor and cushion.

Plans bind `sourceSha`, `checkout`, denied `sourceRoots`, module and CLI projection
receipts, original module/CLI/client archives with SHA256 and SRI, runtime paths,
a new `output`, a private `temporaryParent`, `budget`, and `timeoutSeconds`.
CSS uses `cssReceipt`/`cssArchive`; API uses `apiReceipt`/`apiArchive`. CLI and module
projection sources must match the actual checkout. The existing acquire/project
tools produce these receipts; arbitrary pass flags are not release authority.

The API projection's package identity and archive come from its hash-bound
producer receipt. Its collector input remains an API collector input. It is not
rewritten as a CSS receipt. API probes check public CLI health, exact installed
dashboard/settings bytes, installed PGlite SQL and close, and an installed RDF
query plus shared patched observer identity. All resolved query and observer
dependencies must remain inside the installed module.

Node and Bun run sequentially. Normal shutdown sends TERM to the public parent;
failure cleanup owns group signals. A group whose closure is unknown keeps its
raw logs ineligible for hashing and retains the temporary root. User data moves
to evidence on the same filesystem before known-safe runtime cleanup. Disk
sampling is an observation with explicit incomplete samples, not a hard kernel
quota. Driver and shared helper hashes are recorded and checked after execution.

The local archive transport is an immutable registry fixture. A successful run
does not prove registry publication, Chat, remote Pod authorization, source/native
or legal clearance, or release qualification. Current small tests exercise
contracts and local HTTP/dependency fixtures; they are not a real Xpod acceptance
run. CI must execute the exact candidate archives before reporting that result.
