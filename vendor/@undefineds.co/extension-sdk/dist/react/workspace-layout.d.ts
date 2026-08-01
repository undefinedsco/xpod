import { type ReactNode } from 'react';
import { type WorkspaceLayoutMode, type WorkspaceLayoutPane } from './layout-context';
export type TwoPaneLayoutMode = 'auto' | WorkspaceLayoutMode;
export interface TwoPaneLayoutProps {
    header?: ReactNode;
    list: ReactNode;
    main: ReactNode;
    mode?: TwoPaneLayoutMode;
    history?: WorkspaceLayoutHistoryAdapter;
    className?: string;
}
export interface SinglePaneLayoutProps {
    header?: ReactNode;
    main: ReactNode;
    className?: string;
}
export interface ThreePaneLayoutContextConfig {
    collapsible?: boolean;
    initiallyCollapsed?: boolean;
}
export interface ThreePaneLayoutProps {
    header?: ReactNode;
    list: ReactNode;
    main: ReactNode;
    context: ReactNode;
    mode?: TwoPaneLayoutMode;
    history?: WorkspaceLayoutHistoryAdapter;
    contextConfig?: ThreePaneLayoutContextConfig;
    className?: string;
}
export interface WorkspaceLayoutHistoryAdapter {
    push(pane: WorkspaceLayoutPane): void;
    subscribe(listener: (pane: WorkspaceLayoutPane) => void): () => void;
}
export declare function TwoPaneLayout({ header, list, main, mode, history, className, }: TwoPaneLayoutProps): import("react").JSX.Element;
export declare function SinglePaneLayout({ header, main, className, }: SinglePaneLayoutProps): import("react").JSX.Element;
export declare function ThreePaneLayout({ header, list, main, context, mode, history, contextConfig, className, }: ThreePaneLayoutProps): import("react").JSX.Element;
