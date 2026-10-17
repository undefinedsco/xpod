# Artifact acquisition temporary roots

Windows runners may place the OS temporary directory on C: and the workflow
output on D:. The original verified artifact download then failed with `EXDEV`
while renaming the ZIP into custody, after successful ZIP inspection.

Acquisition now supplies its already checked output parent and directory
identity to the existing owned-temp helper. The temporary root is still an
exclusive `mkdtemp` sibling, so ZIP and original-metadata renames stay on the
same volume. The output itself remains absent until final publication. All
parent ancestors must be ordinary directories; parent identity is rechecked
before allocation and output creation. Cleanup of this explicit-parent root
also requires its original parent and root identities. If ownership changes,
cleanup refuses to remove the replacement and preserves any operation error
alongside the cleanup error. Calls without an explicit parent retain their
existing OS-temp behavior.

Source/run/artifact/byte/hash checks and rename semantics remain. There is no
copy fallback, global TMP change, additional timeout or custody qualification.
Local tests use real temporary files with a simulated different OS-temp parent,
actual same-parent rename, symlink/identity replacement and cleanup failures.
Actual Windows admission still requires a new run and its original receipts.

Publication failure never recursively removes the output pathname. Its created
directory and parent identities are rechecked; a replacement raises an ownership
secondary while preserving the original operation error and both directories.
Even an unchanged partial output is retained, because checking then removing
would introduce another race. A partial directory has no completed custody
receipt and receives no admission. This is conservative failure retention, not
a claim of atomic publication or general race freedom.
