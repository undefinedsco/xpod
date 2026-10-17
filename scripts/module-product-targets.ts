/** Producer capabilities projected from the canonical installation target catalog. */
import { MODULE_TARGETS, modulePackageName } from '../packages/xpod-cli/src/module-catalog';
import inngestPins from '../packages/xpod-api/scripts/inngest-input-pins.json';

/** Native CI routing only; this does not declare any product/native source available. */
export function moduleProductRunner(platform: string, arch: string): string {
  if (!MODULE_TARGETS.some(row => row.platform === platform && row.arch === arch)) throw Error('Unsupported runner target');
  return platform === 'darwin' ? (arch === 'arm64' ? 'macos-15' : 'macos-15-intel')
    : (arch === 'arm64' ? 'ubuntu-24.04-arm' : 'ubuntu-24.04');
}

/** Source build routing is separate from module acquisition/acceptance. Every
 * declared route invokes a real producer; availability below stays conservative
 * until the CSS acquisition contract can consume its complete material format. */
export function cssNativeProducer(target: string) {
  const row = MODULE_TARGETS.find(value => `${value.platform}-${value.arch}` === target);
  if (!row) throw Error('Unsupported CSS native producer target');
  return {target, platform: row.platform, arch: row.arch, runner: moduleProductRunner(row.platform,row.arch),
    workflow: '.github/workflows/css-native-source.yml',
    producerWorkflow: row.platform === 'darwin' ? '.github/workflows/build-qlever-macos-runtime.yml'
      : '.github/workflows/publish-qlever-runtime-sdk.yml',
    materialFormat: row.platform === 'darwin' ? 'macos-native-materials' : 'linux-native-materials',
    ...(row.platform === 'linux' ? {sdkProfile: 'module-bookworm-gcc12'} : {}),
    scope: 'producer-routing-only' as const};
}

export function productTargets(module: string) {
  if (module !== 'api' && module !== 'css') throw Error('Unsupported product module');
  return MODULE_TARGETS.map(({ platform, arch }) => {
    const target = `${platform}-${arch}`;
    const runner = moduleProductRunner(platform, arch);
    // CSS currently has one actual native producer; a supported layout is not a native source.
    const nativeSourceAvailable = module === 'api' ? Object.prototype.hasOwnProperty.call(inngestPins.assets, target) : target === 'darwin-arm64';
    return { ...(module === 'css' ? {nativeProducer:cssNativeProducer(target)} : {}), target, platform, arch, runner, name: modulePackageName(module, platform, arch)!, nativeSourceAvailable,
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
