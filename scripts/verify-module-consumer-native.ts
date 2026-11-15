/** Installed byte/target validation only; never executes or admits native sources. */
import { openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { productTarget } from './module-product-targets';
import { verifyNativeMaterialTarget } from './lib/physical-module-native';

export function verifyConsumerNative(input: { module: 'api' | 'css'; target: string; files: Array<{ path: string; size: number; sha256: string }> }) {
  // The supported target set comes from the same authority as producers.
  productTarget(input.module, input.target);
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 128) throw Error('Bounded actual native files required');
  const seen = new Set<string>();
  const files = input.files.map(row => {
    const actual = realpathSync(row.path);
    if (seen.has(actual) || !Number.isSafeInteger(row.size) || row.size < 4 || row.size > 256 * 1024 ** 2 || !/^[a-f0-9]{64}$/u.test(row.sha256)) throw Error('Invalid native binding');
    seen.add(actual);
    const fd = openSync(actual, 'r');
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== row.size) throw Error('Native file size mismatch');
      const bytes = readFileSync(fd);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== row.size || sha256 !== row.sha256) throw Error('Native bytes differ from installed inventory');
      verifyNativeMaterialTarget(bytes, input.target);
      const after = fstatSync(fd);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('Native file changed during verification');
      return { path: row.path, size: bytes.length, sha256 };
    } finally { closeSync(fd); }
  });
  return { target: input.target, files, nativeHeaderTargetVerified: true, nativeAdmission: false };
}
if (import.meta.main) {
  try { console.log(JSON.stringify(verifyConsumerNative(JSON.parse(readFileSync(0, 'utf8'))))); }
  catch { console.error('Installed native byte/target check failed'); process.exitCode = 1; }
}
