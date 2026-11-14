# Physical module test runners

`scripts/test-runner-ownership.json` is the shared ownership declaration for
Vitest exclusion and the independent module gate. Existing CLI/client/AFS package
gates retain their responsibility. API/CSS directories and the physical-isolation
file run through `bun run test:modules`; package-local `test` scripts select their
same declared group. Every file in a selected group must declare exactly one
runner. Missing or ambiguous ownership fails selection; nothing is skipped.

Bun suites execute under `bun test`. Node suites execute under actual
`node --test`, using the already declared ts-node toolchain solely for source
TypeScript/JSON loading. Original source URLs are preserved for import.meta and
factory provenance; no test bundle substitutes its own source URL. The absolute
repository module-type scope works from both root and package cwd. The API
publication test directly calls Bun.build and therefore uses bun:test; its
assertions remain unchanged.

CI runs this gate in the independent bun-runtime job, so a failing Vitest Unit
step cannot suppress it. The runtime smoke also runs if the module gate fails,
unless the job is cancelled. Existing timeouts and test assertions are unchanged.
Local verification uses Node 22.21.1 and Bun 1.4.2; Node 24/25 loader execution
remains a separate CI/runtime qualification, not implied by the Node package
installation matrix. This gate does not run the full Vitest or integration suite.
