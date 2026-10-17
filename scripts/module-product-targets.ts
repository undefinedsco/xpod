/** Producer capabilities projected from the canonical installation target catalog. */
import { MODULE_TARGETS, modulePackageName } from '../packages/xpod-cli/src/module-catalog';
import inngestPins from '../packages/xpod-api/scripts/inngest-input-pins.json';

export function productTargets(module: string) {
  if (module !== 'api' && module !== 'css') throw Error('Unsupported product module');
  return MODULE_TARGETS.map(({ platform, arch }) => {
    const target = `${platform}-${arch}`;
    const runner = platform === 'darwin' ? (arch === 'arm64' ? 'macos-15' : 'macos-15-intel')
      : (arch === 'arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04');
    // CSS currently has one actual native producer; a supported layout is not a native source.
    const nativeSourceAvailable = module === 'api' ? Object.prototype.hasOwnProperty.call(inngestPins.assets, target) : target === 'darwin-arm64';
    return { target, platform, arch, runner, name: modulePackageName(module, platform, arch)!, nativeSourceAvailable,
      status: nativeSourceAvailable ? 'production-declared-unverified' : 'pending-native-source',
      ...(nativeSourceAvailable ? {} : { reason: 'No current same-source native producer declared; no product archive or acceptance inferred' }) };
  });
}

export function productTarget(module: string, target: string, host?: { platform: string; arch: string }) {
  const row = productTargets(module).find(row => row.target === target);
  if (!row) throw Error('Unsupported product target');
  if (host && (row.platform !== host.platform || row.arch !== host.arch)) throw Error('Native producer host/target mismatch');
  return row;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const module = args[0];
  if (!module || args.length > 3 || (args[2] && args[2] !== '--require-host')) throw Error('Usage: module-product-targets.ts api|css [target [--require-host]]');
  console.log(JSON.stringify(args[1] ? productTarget(module, args[1], args[2] ? { platform: process.platform, arch: process.arch } : undefined)
    : { include: productTargets(module) }));
}
