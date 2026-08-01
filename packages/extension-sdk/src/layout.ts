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
