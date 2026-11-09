import { MODULE_API_VERSION, MODULE_TARGETS, modulePackageName, type ModuleId } from '../../../packages/xpod-cli/src/module-catalog';
import { exactVersion } from '../../independent-release-plan';
import type { CollectedArtifactMember } from './artifact-contract';

/** Pure physical-schema check. This result grants no origin or admission. */
export function verifyModuleProductInventory(input: {
  module: ModuleId; target: string; version: string;
  manifest: any; members: readonly CollectedArtifactMember[];
}): void {
  const fail = (): never => { throw new Error('Module product inventory: platform/ABI/member binding mismatch'); };
  const target = MODULE_TARGETS.find(row => `${row.platform}-${row.arch}` === input.target);
  const { manifest, members } = input, module = manifest?.xpodModule;
  if (!target || !exactVersion(input.version) || manifest?.name !== modulePackageName(input.module, target.platform, target.arch)
    || manifest.version !== input.version || module?.id !== input.module || module.schemaVersion !== 1
    || module.cliApiVersion !== MODULE_API_VERSION || module.platform !== target.platform || module.arch !== target.arch
    || !Array.isArray(module.files) || module.files.length !== members.length - 1) return fail();
  const indexed = new Map(members.map(row => [row.path, row]));
  if (indexed.size !== members.length || !indexed.has('package.json')) return fail();
  const seen = new Set<string>();
  for (const row of module.files) {
    const member = indexed.get(row.path);
    if (row.path === 'package.json' || seen.has(row.path) || !member || member.sha256 !== row.sha256
      || member.bytes !== row.size || member.mode !== row.mode) return fail();
    seen.add(row.path);
  }
  if (!seen.has(module.entry)) return fail();
}
