/** Fixed file-I/O fanout. A failure stops scheduling; all started work drains. */
export async function checkInventoryFiles<T>(files: readonly T[], check: (file: T) => Promise<void>,
  concurrency = 4): Promise<void> {
  // An explicit fanout must be a real positive bound. Zero/NaN/fractional values
  // would silently schedule NO worker and skip the check entirely, so they are
  // refused instead of degrading into a no-op.
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('File-I/O concurrency must be a positive safe integer');
  }
  let next = 0; let failed = false; let failure: unknown; let failureIndex = Infinity;
  const worker = async () => {
    while (!failed && next < files.length) {
      const index = next++;
      try { await check(files[index]!); }
      catch (cause) {
        failed = true;
        if (index < failureIndex) { failureIndex = index; failure = cause; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  if (failed) throw failure;
}
