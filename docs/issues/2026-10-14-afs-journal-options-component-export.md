# AFS journal constructor options missing from the external component contract

The strict CSS metadata generator fails when a service adapter constructor takes
`SolidFsSyncJournalOptions` from the public AFS workcopy subpath. The interface
exists in that subpath's declarations, but AFS's root DI entry exports the journal
classes without exporting their constructor option interface. The generated
`SqliteSolidFsSyncJournal` parameter range consequently names a component that
the external AFS component index does not expose.

Reproduction: build the normal AFS client artifact, then run
`bun test packages/xpod-afs/tests/component-contract.test.ts`. The test copies the
actual AFS package artifact into a consumer's local `node_modules` and invokes the
real Components generator with `hardErrorUnsupported: true`. Before the fix it
throws `Tried to reference a class 'SolidFsSyncJournalOptions' from an external
module '@undefineds.co/xpod-afs' that does not expose this component`.

The root DI entry currently exports two journal classes. The rooted class takes
only string parameters; the SQLite class takes this one interface. Interfaces
and classes in `workcopy/types` are already re-exported together. Other workcopy
classes are public runtime subpaths, not root DI class exports, and this issue
does not expand that DI surface.

The intended correction exports the existing interface as a type from the root
entry. It creates no runtime interface value, copies no interface into CSS, and
retains strict generator errors. Verification must use the newly built AFS
artifact explicitly: the integration checkout's shared `node_modules` resolves
an older checkout, whose files and links must remain unchanged. A passing AFS
consumer fixture alone does not claim that CSS consumed the new artifact.
