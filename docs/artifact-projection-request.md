# Bounded projection requests

Windows rejected the original 65,572-character Python invocation before the
process started (`uv_spawn ENAMETOOLONG`). The large member-selection JSON now
travels through stdin. The same original ZIP parser and exact member projection
remain; archive/path/type/duplicate/size/hash checks and timeouts are unchanged.
Only the fixed `--selection-stdin` flag replaces the selection JSON in argv.
Existing small argv requests remain supported for existing callers.

Both the parent and Python bound the UTF-8 JSON request at 8 MiB. The parent
retains original request bytes and hashes with the `stdin-json` method in the
existing command diagnostics. An oversized request is rejected before spawn;
its capture is bounded and marked truncated. Actual missing spawn status/signal
are recorded as null, with the native spawn error, never as a successful exit.
No request-file or link-loading protocol is added. Malformed input and invalid
selection structures fail closed, without an extraction fallback.

Tests execute 400-member ZIP projection with request bytes above the observed
Windows invocation limit under actual Node and Bun callers, while argv stays
short. They also cover malformed UTF-8/JSON, a rejected file/link reference,
parent/Python request caps, and primary plus diagnostic-retention failures.
These are local mechanism checks; a new Windows run must prove actual admission.
