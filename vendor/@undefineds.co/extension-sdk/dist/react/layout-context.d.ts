export type WorkspaceLayoutMode = 'split' | 'stack';
export type WorkspaceLayoutPane = 'list' | 'main' | 'context';
export interface WorkspaceLayoutNavigation {
    mode: WorkspaceLayoutMode;
    activePane: WorkspaceLayoutPane;
    openList(): void;
    openMain(): void;
    openContext(): void;
}
export declare const WorkspaceLayoutContext: import("react").Context<WorkspaceLayoutNavigation | null>;
export declare function useWorkspaceLayout(): WorkspaceLayoutNavigation;
