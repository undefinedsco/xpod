# CSS CLI lifecycle and resource ownership audit

The CSS module and service child share `runCssCli`. It creates one canonical
`App` through `AppRunner.createCli`, installs signal ownership before asynchronous
creation, starts that same App, and calls its real `stop` finalizer after startup
settles. A signal during creation suppresses starting the App after shutdown
has been requested. A signal during initialization waits for initialization before
finalization. Concurrent signals share one stop promise. Startup errors retain
their original failure and attempt finalization; shutdown failure is observable
as exit code 1. This path never forces an exit or reinitializes CSS.

The existing App finalizer first runs `Finalizer` (including
`ServerInitializer.finalize`, which awaits the HTTP server close callback), then
`CleanupFinalizer`. Xpod's local profile closes the RDF accessor and authority
recovery journal; the cloud profile drains Pod mutations before closing RDF
authority and its Redis connection. These remain the canonical cleanup chain.

Local `SolidRdfEngine` can eagerly open during Components instantiation.
`SolidRdfDataAccessor.finalize` therefore closes its configured engine even
before the accessor's own initialization has run. The engine joins concurrent
open/close calls, waits for eager startup to settle, and attempts every owned
cleanup resource even if native cleanup fails. Borrowed indexes retain their
existing ownership contract. Failed cleanup blocks reopening until a successful
cleanup retry; the original cleanup errors remain observable.

## Open lifecycle interface gaps

These are reported ownership gaps, not removed capabilities or accepted modes.
The signal adapter alone does not prove all CSS profiles close every resource.

| Resource | Existing owner and observed gap | Reproduction and required evidence |
| --- | --- | --- |
| Cluster workers | CSS `ClusterManager.spawnWorkers` installs a cluster exit callback which unconditionally forks a replacement. `WorkerManager` has no finalizer and `ClusterManager` has no stop method. `App.stop` only invokes configured finalizers. | Start a valid multiworker profile, signal only the primary process as ModuleStore does, and observe worker PIDs/IPC and replacement behavior. Closure requires the same cluster owner to stop respawning, finalize workers and await their actual exit. Do not globally kill processes or suppress CLI signal exit codes. |
| Upgraded WebSocket connections | The original CSS configurator exposed no cleanup contract. Xpod now uses `FinalizingWebSocketServerConfigurator` in the same configurator slot and registers that owner in the canonical finalizer. Real network unit tests prove graceful close and visible failure after terminating a nonresponsive peer. | The earlier staged production-entry reproduction reached HTTP 200 and a real 101/protocol greeting, but owner-only stop left the connection open and required emergency cleanup. A new source-bound stage and final installed archive must separately prove the fix; see [CSS WebSocket lifecycle](../css-resource-lifecycle.md). |
| Identity database cache | Xpod `getIdentityDatabase` caches SQLite handles and shared PostgreSQL pool references. `closeAllIdentityConnections` closes/releases these, but no CSS App finalizer registration was found. Calling a global cache close directly from a shared runner could close resources owned by other consumers. | Exercise real identity storage in SQLite and PostgreSQL profiles, stop the App, inspect handles/pool references and natural process termination. Closure needs explicit cache/lease ownership in the canonical finalizer chain. A process exiting does not alone prove every SQLite handle was properly finalized. |
| Initializer/finalizer errors | CSS finalizers use a sequence: an earlier rejected finalizer prevents later cleanup handlers from running. Startup can also fail after resource creation. | Fail startup after listening and reject an early finalizer; verify cleanup failure remains visible and record actual remaining resources. Do not turn rejection into a successful exit. |

Focused tests cover a real HTTP listener, an App-owned child which exits
naturally, startup/creation races, concurrent signals, and failed finalization.
They do not substitute for actual installed CSS Node/Bun HTTP consumers or the
cluster/WebSocket/database reproductions above.

`SolidRdfDataAccessor.finalize` also closes its configured engine when the accessor
has not initialized: the engine can already own a native process from constructor
`autoOpen`. `SolidRdfEngine` serializes open/close and attempts every owned index
cleanup after native failure, retaining original or aggregate errors and leaving
borrowed indexes open. The native client shares actual child-close completion,
waits for failed process cleanup before restarting, and retains ownership on a
final timeout. Normal shutdown requiring a signal or ending with a nonzero child
status is a failure after reaping, rather than a successful App stop.
