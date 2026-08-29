import { describe, expect, test } from 'vitest';
import { gatewayAccessKeyDescriptor, gatewayAccessKeyResource, UDFS } from '@undefineds.co/models';

describe('UI shared model contract', () => {
  test('resolves the reversible API Key state from the installed shared model', () => {
    // Keep this in the UI workspace: a stale nested install can shadow the root package.
    const column = gatewayAccessKeyResource.columns.disabledAt;
    expect(column).toBeDefined();
    expect(column.getPredicate()).toBe(UDFS.disabledAt);
    expect(gatewayAccessKeyDescriptor.writableFields).toContain('disabledAt');
  });
});
