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
export type AppletLayoutDescriptor = SinglePaneAppletLayoutDescriptor | TwoPaneAppletLayoutDescriptor | ThreePaneAppletLayoutDescriptor;
export declare function defineAppletLayout<T extends AppletLayoutDescriptor>(descriptor: T): T;
