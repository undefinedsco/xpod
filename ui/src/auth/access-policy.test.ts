import { describe, expect, test } from 'vitest';
import { accessRequirementForPathname } from './access-policy';

describe('Xpod access policy', () => {
  test.each([
    ['/status/overview', 'account'],
    ['/status/usage/storage', 'account'],
    ['/network/https', 'local-host'],
    ['/settings/storage', 'local-host'],
    ['/settings/runtime', 'local-host'],
    ['/settings/cloud', 'local-host'],
    ['/settings/advanced', 'local-host'],
    ['/settings/system/storage', 'local-host'],
    ['/settings/system/runtime', 'local-host'],
    ['/settings/pod', 'webid'],
    ['/settings/identity-access', 'webid'],
    ['/settings/system/pod', 'webid'],
    ['/settings/system/identity-access', 'webid'],
    ['/ai-config/model-assignments', 'webid'],
    ['/ai-connections', 'webid'],
  ] as const)('maps %s to %s', (pathname, requirement) => {
    expect(accessRequirementForPathname(pathname)).toBe(requirement);
  });
});
