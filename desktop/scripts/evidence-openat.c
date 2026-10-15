/* Fixed ABI shim: C supplies openat's variadic mode using the platform ABI. */
extern int openat(int directory, const char *name, int flags, ...);
int xpod_evidence_openat(int directory, const char *name, int flags) {
  return openat(directory, name, flags, 0600);
}
