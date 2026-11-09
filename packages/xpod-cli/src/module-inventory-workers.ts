/** Fixed file-I/O fanout. A failure stops scheduling; all started work drains. */
export async function checkInventoryFiles<T>(files: readonly T[], check: (file: T) => Promise<void>): Promise<void> {
  let next = 0; let failed = false; let failure: unknown; let failureIndex = Infinity;
  const worker = async () => {
    while (!failed && next < files.length) {
      const index = next++;
      try { await check(files[index]); }
      catch (cause) {
        failed = true;
        if (index < failureIndex) { failureIndex = index; failure = cause; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  if (failed) throw failure;
}
