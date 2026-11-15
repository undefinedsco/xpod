# Linux FUSE crashed-owner detach

Linux FUSE mounted acceptance identified a backend dispatch defect: after the owned helper was killed, crash recovery selected the macOS NFS-only detach path and rejected Linux before spawning an unmount command. The later GC check was not reached; its assertion remains unchanged.

The unchanged private owner record selects the backend. Normal unmount and crashed FUSE recovery share one command registry: Linux uses ordinary `umount <target>` with no force or lazy flags; macOS uses ordinary `/sbin/umount <target>`. The existing macOS crashed NFS policy remains `/sbin/umount -f <target>`; Linux crashed NFS remains unsupported. This adds no fusermount helper dependency and never retries with a weaker command on busy, permission or ambiguous results.

Recovery still requires independently observed original process death, the exact kernel mount binding, the original private lease and socket identities, unchanged owner checks immediately before spawn, an actually waited successful unmount child, and subsequent kernel absence. Unknown process/mount state, foreign binding, unresolved prepared/started operations or failed unmount retain the runtime. These observations do not claim atomic protection against a noncooperating mount replacement after the last kernel check.

Unit regressions cover the command registry, recorded backend dispatch, live/unknown/foreign negative cases for both backends, and actual killed owner plus waited child proof for both backends under controlled kernel observations. Those tests do not replace an actual Linux FUSE mounted crash/cleanup acceptance run on fresh source-bound native artifacts.
