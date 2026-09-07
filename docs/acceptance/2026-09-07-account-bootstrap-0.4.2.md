# 0.4.2 Account authority repair

Public Account HTML served through `pods.undefineds.co` already advertises
`https://id.undefineds.co/.account/` in its server bootstrap. The UI ignored that
value and derived the Account authority from the page origin, causing canonical
controls to fall through to a nonexistent Local `/provision/status` endpoint.

This release is based on v0.4.1 and only adds validated server-bootstrap
priority to `ui/src/context/resolve-xpod-account-index.ts`, its dedicated
regression tests, and the 0.4.2 package version alignment. Missing bootstrap
retains managed Local discovery; invalid explicit bootstrap fails closed.
No session cookies are copied across origins and no new configuration is added.
Other uncommitted desktop/AI/ORM work is outside this candidate.

Local verification of this release tree:

- Frozen Bun installation and platform package version alignment passed.
- Full source, Components.js, workspace package and UI production builds passed.
- Account and release contract tests: 13 files, 154 tests passed.
- Release workflow actionlint passed.
- Full integration: lite 149 passed / 6 skipped; full 45 passed.
- Independent read-only review found no blocking issue.

CI must rebuild frontend and backend from this exact source commit, complete RC
acceptance, then promote the accepted image digest. Local build output is not
hot-copied to production. Production availability is verified after promotion;
this record alone does not assert an affected user's account has been retested.
