import { describe, expect, test } from 'vitest';

import { XPOD_LAYOUT_BREAKPOINTS, resolveAppletPanePlan } from '../src/layout';

/**
 * §8.3 页型与断点契约：概览、固定配置、诊断永不出现对象列；只有"真正集合"在宽窗才有对象列。
 */
describe('applet pane plan', () => {
  test('never gives overview, configuration or diagnostics an object column, however wide', () => {
    for (const pageType of ['overview', 'configuration', 'diagnostics'] as const) {
      const plan = resolveAppletPanePlan({ pageType, contentWidth: 1600, hasObjectCollection: true });
      expect(plan, pageType).toEqual({ pageType, navigation: 'rail', panes: 'single', showObjectColumn: false });
    }
  });

  test('adds the object column only for a real collection at the wide breakpoint', () => {
    const wide = resolveAppletPanePlan({ pageType: 'collection', contentWidth: 1440, hasObjectCollection: true });
    expect(wide).toEqual({ pageType: 'collection', navigation: 'rail', panes: 'list-detail', showObjectColumn: true });

    const wideWithoutCollection = resolveAppletPanePlan({ pageType: 'collection', contentWidth: 1440 });
    expect(wideWithoutCollection.showObjectColumn).toBe(false);
    expect(wideWithoutCollection.panes).toBe('single');

    const justBelow = resolveAppletPanePlan({
      pageType: 'collection', contentWidth: XPOD_LAYOUT_BREAKPOINTS.wideObjects - 1, hasObjectCollection: true,
    });
    expect(justBelow.showObjectColumn).toBe(false);
    expect(justBelow.panes).toBe('stack');
  });

  test('uses the task bar and a single pane below the narrow breakpoint', () => {
    const narrow = resolveAppletPanePlan({ pageType: 'collection', contentWidth: 640, hasObjectCollection: true });
    expect(narrow).toEqual({ pageType: 'collection', navigation: 'task-bar', panes: 'single', showObjectColumn: false });
    expect(XPOD_LAYOUT_BREAKPOINTS).toEqual({ narrow: 768, wideObjects: 1100 });
  });

  test('keeps single-pane pages single at the middle breakpoint', () => {
    const middle = resolveAppletPanePlan({ pageType: 'configuration', contentWidth: 900 });
    expect(middle.panes).toBe('single');
    expect(middle.navigation).toBe('rail');
  });

  test('rejects a width that cannot be a viewport', () => {
    expect(() => resolveAppletPanePlan({ pageType: 'overview', contentWidth: 0 })).toThrow(/contentWidth/u);
    expect(() => resolveAppletPanePlan({ pageType: 'overview', contentWidth: Number.NaN })).toThrow(/contentWidth/u);
  });
});
