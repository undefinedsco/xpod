import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useContext, useState } from 'react';
import { cn } from './utils.js';
const WorkspaceNavigationContext = createContext(null);
export function TwoPaneWorkspace({ header, list, main, className, layoutMode = 'auto', }) {
    const [mobilePane, setMobilePane] = useState('list');
    const showMain = () => setMobilePane('main');
    const showList = () => setMobilePane('list');
    const navigation = {
        mode: layoutMode === 'narrow' ? 'stack' : 'split',
        activePane: mobilePane,
        mobilePane,
        showMain,
        showList,
        openMain: showMain,
        backToList: showList,
    };
    return (_jsx(WorkspaceNavigationContext.Provider, { value: navigation, children: _jsxs("div", { className: cn('flex min-h-0 flex-1 flex-col bg-background', className), "data-applet-layout": "two-pane", children: [_jsx("header", { className: "h-16 shrink-0 border-b border-border bg-layout-content", "data-testid": "applet-header-pane", children: header }), _jsxs("div", { className: cn('grid min-h-0 flex-1', layoutMode === 'narrow'
                        ? 'grid-cols-1'
                        : 'grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)]', layoutMode === 'auto' && 'max-md:grid-cols-1'), "data-layout-mode": layoutMode, "data-mobile-pane": mobilePane, children: [_jsx("aside", { className: cn('min-h-0 overflow-y-auto border-r bg-card @container', layoutMode !== 'wide' && 'max-md:border-r-0', layoutMode === 'narrow' && mobilePane === 'main' && 'hidden', layoutMode === 'auto' && mobilePane === 'main' && 'max-md:hidden'), "data-applet-pane": "list", "data-testid": "applet-list-pane", children: list }), _jsxs("div", { className: cn('min-h-0 overflow-y-auto bg-background @container', layoutMode === 'narrow' && mobilePane === 'list' && 'hidden', layoutMode === 'auto' && mobilePane === 'list' && 'max-md:hidden'), "data-applet-pane": "main", "data-testid": "applet-main-pane", children: [_jsx("button", { type: "button", className: cn('items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground', layoutMode === 'narrow' ? 'inline-flex' : 'hidden', layoutMode === 'auto' && 'max-md:inline-flex'), onClick: navigation.showList, children: "\u2190 \u8FD4\u56DE\u5217\u8868" }), main] })] })] }) }));
}
export function useAppletLayout() {
    const navigation = useContext(WorkspaceNavigationContext);
    if (!navigation) {
        throw new Error('useAppletLayout must be used inside TwoPaneWorkspace');
    }
    return navigation;
}
export function AppletList(props) {
    return _jsx("nav", { className: cn('space-y-1 p-3', props.className), ...props });
}
export function AppletListItem({ selected, className, onClick, ...props }) {
    const navigation = useContext(WorkspaceNavigationContext);
    return (_jsx("button", { type: "button", "aria-current": selected ? 'page' : undefined, className: cn('flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium', className), onClick: (event) => {
            onClick?.(event);
            navigation?.showMain();
        }, ...props }));
}
