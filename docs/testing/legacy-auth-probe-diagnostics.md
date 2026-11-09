# Legacy package authentication probe diagnostics

The full legacy Node/Bun matrix installs the actual packed package before running
`tests/scripts/packaged-auth-probe.cjs`. Installation and probe completion are
separate observations: an install-phase failure can occur after the package
manager has successfully installed the package.

The probe emits `packaged-auth-probe-stage` JSON records with a fixed stage token
and bounded monotonic elapsed milliseconds. Failures add a fixed error class;
exception messages, stacks, installed paths, keys and tokens are not diagnostic
fields. Stages distinguish factory configuration/routes, session-cookie handling,
caller resolution, each root/openid JOSE CJS and ESM operation, RS256 key and token
operations, and callback cleanup. A pending await retains its current stage when
the watchdog fires. A failed synchronous ESM child relays only valid stage records
from its bounded stdout before the parent reports failure; child stderr is not
forwarded into this diagnostic stream.

The existing 30-second watchdog and 10-second ESM child limit remain unchanged.
All original authentication assertions, caller-scoped module resolution checks,
cryptographic operations and callback-cleanup checks still execute. Diagnostics
do not qualify a package, repair a timeout or waive any of the 18 matrix lanes.
Controlled provider/session test fixtures verify the probe and do not constitute
real installed-product acceptance.

Run `bun run test -- tests/scripts/packaged-auth-probe.test.ts` and
`node --test tests/scripts/packaged-auth-condition.node-test.cjs` for focused
regression. Retain the lane's original stdout/stderr, exit status and receipt
hashes when diagnosing CI. A last-stage token identifies the pending operation;
it does not establish why that operation stalled.

In run39801471041 at event head4858f38b, Windows Bun/Node22 installed the package
then hit the authentication watchdog. The other five Windows lanes succeeded.
That earlier trace lacks internal stages, so its precise pending operation and
root cause remain unproven; a later successful lane does not retroactively prove
that failure was repaired.
