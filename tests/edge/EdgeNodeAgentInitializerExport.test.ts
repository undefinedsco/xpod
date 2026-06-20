import { describe, expect, it } from 'vitest';
import * as xpod from '../../src';

describe('EdgeNodeAgentInitializer export', () => {
  it('exports the initializer so Components.js can generate its component definition', () => {
    expect(xpod.EdgeNodeAgentInitializer).toBeTypeOf('function');
  });
});
