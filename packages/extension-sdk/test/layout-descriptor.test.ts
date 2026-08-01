import { describe, expect, it } from 'vitest';
import { defineAppletLayout } from '../src/layout';

describe('defineAppletLayout', () => {
  it('returns supported Applet layout descriptors unchanged', () => {
    const singlePane = { type: 'single-pane' } as const;
    const twoPane = { type: 'two-pane' } as const;
    const threePane = {
      type: 'three-pane',
      context: { collapsible: true },
    } as const;

    expect(defineAppletLayout(singlePane)).toBe(singlePane);
    expect(defineAppletLayout(twoPane)).toBe(twoPane);
    expect(defineAppletLayout(threePane)).toBe(threePane);
  });

  it('rejects unsupported layout descriptor types at runtime', () => {
    expect(() => defineAppletLayout({ type: 'grid' } as never)).toThrow(
      'Unsupported applet layout type: grid',
    );
  });

  it.each([
    [null, 'Applet layout descriptor must be an object'],
    [[], 'Applet layout descriptor must be an object'],
    [{}, 'Applet layout descriptor type must be a string'],
    [{ type: 'three-pane', context: null }, 'Applet layout descriptor context must be an object'],
    [{ type: 'three-pane', context: [] }, 'Applet layout descriptor context must be an object'],
    [
      { type: 'three-pane', context: { collapsible: 'yes' } },
      'Applet layout descriptor context.collapsible must be a boolean',
    ],
    [
      { type: 'three-pane', context: { initiallyCollapsed: 'no' } },
      'Applet layout descriptor context.initiallyCollapsed must be a boolean',
    ],
  ])('rejects malformed layout descriptor %#', (descriptor, message) => {
    expect(() => defineAppletLayout(descriptor as never)).toThrow(message);
  });
});
