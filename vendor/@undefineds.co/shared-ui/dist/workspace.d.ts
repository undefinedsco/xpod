import { type ComponentProps, type ReactNode } from 'react';
interface WorkspaceNavigation {
    mode: 'split' | 'stack';
    activePane: 'list' | 'main';
    mobilePane: 'list' | 'main';
    showMain(): void;
    showList(): void;
    openMain(): void;
    backToList(): void;
}
export declare function TwoPaneWorkspace({ header, list, main, className, layoutMode, }: {
    header: ReactNode;
    list: ReactNode;
    main: ReactNode;
    className?: string;
    layoutMode?: 'auto' | 'wide' | 'narrow';
}): import("react").JSX.Element;
export declare function useAppletLayout(): Pick<WorkspaceNavigation, 'mode' | 'activePane' | 'openMain' | 'backToList'>;
export declare function AppletList(props: ComponentProps<'nav'>): import("react").JSX.Element;
export declare function AppletListItem({ selected, className, onClick, ...props }: ComponentProps<'button'> & {
    selected?: boolean;
}): import("react").JSX.Element;
export {};
