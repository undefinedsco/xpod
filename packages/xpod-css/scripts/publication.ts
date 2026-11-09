import path from 'node:path';
import { valid } from 'semver';
import { verifyPhysicalNativeMaterials } from '../../../scripts/lib/physical-module-native';
import { verifyPhysicalNotices } from '../../../scripts/lib/physical-module-notices';

export interface CssPublicationOptions {
  publication: { mode: 'preview' | 'release'; version: string };
  materialsRoot?: string;
}

/** Publication options only; identities and material rules belong to shared producers. */
export function cssPublicationOptions(args: string[], previewVersion: string): CssPublicationOptions {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--') || args.lastIndexOf(name) !== index) throw new Error('Invalid CSS publication option: ' + name);
    return value;
  };
  const mode = option('--publication') ?? 'preview';
  if (mode !== 'preview' && mode !== 'release') throw new Error('Invalid CSS publication mode');
  const declaredVersion = option('--version');
  if (mode === 'release' && !declaredVersion) throw new Error('Release requires explicit version');
  const version = declaredVersion ?? previewVersion;
  if (!valid(version)) throw new Error('Invalid CSS publication version');
  const materials = option('--materials-root');
  if (mode === 'release' && !materials) throw new Error('Release requires explicit external materials root');
  if (mode === 'preview' && materials) throw new Error('External materials root requires release mode');
  return { publication: { mode, version }, materialsRoot: materials ? path.resolve(materials) : undefined };
}

export function verifyCssReleaseMaterials(productRoot: string, options: CssPublicationOptions): void {
  if (options.publication.mode !== 'release' || !options.materialsRoot) throw new Error('Explicit CSS release material authority required');
  verifyPhysicalNotices(productRoot, true);
  verifyPhysicalNativeMaterials(productRoot, { materialsRoot: options.materialsRoot });
}
