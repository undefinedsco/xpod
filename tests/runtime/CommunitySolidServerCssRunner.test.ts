import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/runtime/package-root';
import { createPackageRootPreferredModuleState } from '../../src/runtime/runner/node/CommunitySolidServerCssRunner';

describe('CommunitySolidServerCssRunner module loading', () => {
  it('prefers the current package root components over same-version parent workspace packages', async () => {
    const moduleState = await createPackageRootPreferredModuleState(PACKAGE_ROOT);
    const moduleIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod';
    const contextIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld';
    const componentsImportIri = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/';

    expect(moduleState.componentModules[moduleIri]?.[0]).toBe(`${PACKAGE_ROOT}/dist/components/components.jsonld`);
    expect(moduleState.contexts[contextIri]).toEqual(expect.objectContaining({
      '@context': expect.any(Array),
    }));
    expect(moduleState.importPaths[componentsImportIri]).toBe(`${PACKAGE_ROOT}/dist/components/`);
  });
});
