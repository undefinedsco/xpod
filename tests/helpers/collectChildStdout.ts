import type { ChildProcess } from 'node:child_process';

/** Collect unmodified stdout from an already spawned child after stdio closes. */
export function collectChildStdout(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error('Child stdout is not piped'));
      return;
    }
    const chunks: Buffer[] = [];
    stdout.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    // Keep error listeners attached so repeated error events cannot become
    // unhandled exceptions. Promise settlement is idempotent.
    child.on('error', () => reject(new Error('Child process failed')));
    stdout.on('error', () => reject(new Error('Child stdout failed')));
    child.once('close', (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(new Error('Child closed unsuccessfully'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export function assertCompleteDigest(digest: string): void {
  if (digest.length !== 64 || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error('Child digest output must be exactly 64 lowercase hex characters');
  }
}
