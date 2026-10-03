// Keep the supported service runtime in package.json; the single-file build
// bundles this manifest together with the check.
const { engines } = require('../../../package.json') as { engines: { bun: string } };

/** Fail before opening services on runtimes with broken WebSocket shutdown. */
export function ensureSupportedBun(version: string | undefined = process.versions.bun): void {
  if (version === undefined) { return; }
  const minimum = engines.bun.slice(2).split('.').map(Number);
  const parsed = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.*)?$/u.exec(version);
  if (parsed) {
    const actual = parsed.slice(1, 4).map(Number);
    const difference = actual.map((value, index) => value - minimum[index]).find((value) => value !== 0) ?? 0;
    if (difference > 0 || (difference === 0 && !parsed[4])) { return; }
  }
  throw new Error(`Xpod requires Bun ${engines.bun}; found ${version}. Older Bun versions can hang during WebSocket shutdown. Upgrade Bun before starting Xpod.`);
}
