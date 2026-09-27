export type AppletLayoutType = 'single-pane' | 'two-pane' | 'three-pane';

export type SinglePaneAppletLayoutDescriptor = {
  readonly type: 'single-pane';
};

export type TwoPaneAppletLayoutDescriptor = {
  readonly type: 'two-pane';
};

export type ThreePaneAppletLayoutDescriptor = {
  readonly type: 'three-pane';
  readonly context?: {
    readonly collapsible?: boolean;
    readonly initiallyCollapsed?: boolean;
  };
};

export type AppletLayoutDescriptor =
  | SinglePaneAppletLayoutDescriptor
  | TwoPaneAppletLayoutDescriptor
  | ThreePaneAppletLayoutDescriptor;

export function defineAppletLayout<T extends AppletLayoutDescriptor>(descriptor: T): T;
export function defineAppletLayout(descriptor: unknown): AppletLayoutDescriptor {
  if (!isPlainDescriptorObject(descriptor)) {
    throw new Error('Applet layout descriptor must be an object');
  }
  if (typeof descriptor.type !== 'string') {
    throw new Error('Applet layout descriptor type must be a string');
  }

  switch (descriptor.type) {
    case 'single-pane':
    case 'two-pane':
      assertValidLayoutContext(descriptor.context);
      return descriptor as AppletLayoutDescriptor;
    case 'three-pane':
      assertValidLayoutContext(descriptor.context);
      return descriptor as AppletLayoutDescriptor;
    default:
      throw new Error(`Unsupported applet layout type: ${descriptor.type}`);
  }
}

function isPlainDescriptorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValidLayoutContext(context: unknown): void {
  if (context === undefined) {
    return;
  }
  if (!isPlainDescriptorObject(context)) {
    throw new Error('Applet layout descriptor context must be an object');
  }
  if ('collapsible' in context && typeof context.collapsible !== 'boolean') {
    throw new Error('Applet layout descriptor context.collapsible must be a boolean');
  }
  if ('initiallyCollapsed' in context && typeof context.initiallyCollapsed !== 'boolean') {
    throw new Error('Applet layout descriptor context.initiallyCollapsed must be a boolean');
  }
}

/**
 * §8.3 的四种页型。与上面的 pane 描述符并存：既有 applet 仍可用 three-pane，新页面按页型声明，
 * 由 {@link resolveAppletPanePlan} 结合实际宽度与"是否真有对象集合"决定是否出现对象列。
 */
export type AppletPageType = 'overview' | 'collection' | 'configuration' | 'diagnostics';

/**
 * §8.3 断点的唯一来源，单位是内容视口 CSS px。页面不得自选断点。
 */
/**
 * 宽窗口导航列宽度（§8.3）。`AppLayout` 的 Tailwind 类必须与它一致
 * （`md:grid-cols-[184px_minmax(0,1fr)]`），`packages/extension-sdk/test/app-layout.test.tsx` 两边都断言。
 */
export const XPOD_LAYOUT_RAIL_WIDTH = 184;

export const XPOD_LAYOUT_BREAKPOINTS = {
  /** 低于此宽度使用任务栏 + 导航抽屉，不强制底部 Tab。 */
  narrow: 768,
  /** 只有达到此宽度且确有对象集合，才增加对象列。 */
  wideObjects: 1100,
} as const;

export interface AppletPanePlanInput {
  readonly pageType: AppletPageType;
  /** 当前内容视口宽度（CSS px），不含原生标题栏与安全区。 */
  readonly contentWidth: number;
  /** 该页是否真有需要持续比较/切换的对象集合；概览、固定配置、诊断恒为 false。 */
  readonly hasObjectCollection?: boolean;
}

export interface AppletPanePlan {
  readonly pageType: AppletPageType;
  readonly navigation: 'rail' | 'task-bar';
  readonly panes: 'single' | 'stack' | 'list-detail';
  readonly showObjectColumn: boolean;
}

/**
 * 把页型、宽度与集合事实映射成布局计划（spec §8.3）：
 * - <768px：任务栏 + 导航抽屉，单面板；
 * - 768–1099px：184px 文字导航，集合页用堆叠；
 * - ≥1100px：只有真正集合才额外出现对象列。
 */
export function resolveAppletPanePlan(input: AppletPanePlanInput): AppletPanePlan {
  const { pageType, contentWidth } = input;
  const hasCollection = input.hasObjectCollection === true;
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
    throw new Error('Applet pane plan needs a positive contentWidth');
  }
  if (contentWidth < XPOD_LAYOUT_BREAKPOINTS.narrow) {
    return { pageType, navigation: 'task-bar', panes: 'single', showObjectColumn: false };
  }
  const showObjectColumn =
    contentWidth >= XPOD_LAYOUT_BREAKPOINTS.wideObjects && pageType === 'collection' && hasCollection;
  if (showObjectColumn) {
    return { pageType, navigation: 'rail', panes: 'list-detail', showObjectColumn: true };
  }
  return {
    pageType,
    navigation: 'rail',
    panes: pageType === 'collection' && contentWidth < XPOD_LAYOUT_BREAKPOINTS.wideObjects ? 'stack' : 'single',
    showObjectColumn: false,
  };
}
