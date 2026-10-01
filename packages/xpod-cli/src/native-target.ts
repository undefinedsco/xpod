import { openSync, readSync, closeSync } from 'node:fs';

export function bunCompileTarget(target: string): string {
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target)) {
    throw new Error(`Unsupported build target: ${target}`);
  }
  return `bun-${target}`;
}

/** Reject a host helper accidentally bundled in an unexecuted cross build. */
export function assertNativeTarget(file: string, target: string): void {
  bunCompileTarget(target);
  const bytes = Buffer.alloc(32);
  const descriptor = openSync(file, 'r');
  let count: number;
  try { count = readSync(descriptor, bytes); } finally { closeSync(descriptor); }
  const arm = target.endsWith('-arm64');
  const valid = count >= 32 && (target.startsWith('linux-')
    ? bytes.subarray(0, 6).equals(Buffer.from([ 0x7f, 0x45, 0x4c, 0x46, 2, 1 ])) && bytes.readUInt16LE(18) === (arm ? 183 : 62)
    : bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arm ? 0x0100000c : 0x01000007));
  if (!valid) { throw new Error(`Native executable does not match ${target}: ${file}`); }
}
