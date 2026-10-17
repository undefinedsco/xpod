import { modulePackageName } from '../../xpod-cli/src/module-catalog';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { planCssResources, materializeCssResources, type CssResourcePlan } from './component-resources';

/** CSS-specific declarations consumed by the common physical module producer. */
export function cssProducerConfig(repoRoot: string, target: string, components?: { plan: CssResourcePlan; metadataRoot: string }) {
  const parts = target.split('-');
  const name = parts.length === 2 ? modulePackageName('css', parts[0], parts[1]) : undefined;
  if (!name) throw new Error('Unsupported CSS target');
  const sourceManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const plan = components?.plan ?? planCssResources(repoRoot);
  return {
    entry: 'src/runtime/css-entry.ts',
    extraSourceRoots: [...plan.componentExports.map(item => item.source), 'src/runtime/css-auth-config.ts'],
    materializeResources: (stage: string) => { materializeCssResources(repoRoot, stage, name, plan, components?.metadataRoot); },
    moduleId: 'css' as const,
    packageName: name,
    resourcePlan: plan,
    manifest: {
      main: './dist/css-components.cjs',
      exports: { '.': './dist/css-components.cjs', './auth-config': './src/runtime/css-auth-config.js' },
      ...Object.fromEntries(Object.entries(sourceManifest).filter(([key]) => key.startsWith('lsd:'))),
    },
  };
}
