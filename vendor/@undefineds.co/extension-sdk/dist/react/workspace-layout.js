import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, } from 'react';
import { cn } from '@undefineds.co/shared-ui';
import { WorkspaceLayoutContext, } from './layout-context.js';
const stackMediaQuery = '(max-width: 767px)';
const twoPaneGridStyle = {
    gridTemplateColumns: '210px minmax(0, 1fr)',
};
const threePaneGridStyle = {
    gridTemplateColumns: '210px minmax(0, 1fr) minmax(240px, 320px)',
};
function mapContextPaneToMain(pane) {
    return pane === 'context' ? 'main' : pane;
}
function subscribeToStackModeChange(onStoreChange) {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
    }
    const media = window.matchMedia(stackMediaQuery);
    media.addEventListener('change', onStoreChange);
    return () => media.removeEventListener('change', onStoreChange);
}
function getAutoModeSnapshot() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return 'split';
    }
    return window.matchMedia(stackMediaQuery).matches ? 'stack' : 'split';
}
function getServerAutoModeSnapshot() {
    return 'split';
}
function useResolvedMode(mode) {
    const autoMode = useSyncExternalStore(subscribeToStackModeChange, getAutoModeSnapshot, getServerAutoModeSnapshot);
    return mode === 'auto' ? autoMode : mode;
}
function useStackNavigation({ resolvedMode, history, resolvePane, }) {
    const [activePane, setActivePane] = useState('list');
    const focusPaneRef = useRef(null);
    const listRef = useRef(null);
    const mainRef = useRef(null);
    const contextRef = useRef(null);
    const paneRefs = useMemo(() => ({
        list: listRef,
        main: mainRef,
        context: contextRef,
    }), []);
    const navigate = useCallback((requestedPane, options = {}) => {
        const nextPane = resolvePane?.(requestedPane) ?? requestedPane;
        setActivePane(nextPane);
        if (resolvedMode !== 'stack') {
            return;
        }
        focusPaneRef.current = nextPane;
        if (!options.fromHistory) {
            history?.push(nextPane);
        }
    }, [history, resolvePane, resolvedMode]);
    const openList = useCallback(() => navigate('list'), [navigate]);
    const openMain = useCallback(() => navigate('main'), [navigate]);
    const openContext = useCallback(() => navigate('context'), [navigate]);
    useLayoutEffect(() => {
        if (resolvedMode !== 'stack') {
            focusPaneRef.current = null;
            return;
        }
        const pane = focusPaneRef.current;
        if (!pane) {
            return;
        }
        focusPaneRef.current = null;
        paneRefs[pane].current?.focus();
    }, [activePane, paneRefs, resolvedMode]);
    useLayoutEffect(() => {
        if (resolvedMode !== 'stack' || !history) {
            return undefined;
        }
        return history.subscribe((pane) => {
            navigate(pane, { fromHistory: true });
        });
    }, [history, navigate, resolvedMode]);
    return {
        activePane,
        paneRefs,
        openList,
        openMain,
        openContext,
    };
}
export function TwoPaneLayout({ header, list, main, mode = 'auto', history, className, }) {
    const resolvedMode = useResolvedMode(mode);
    const { activePane, paneRefs, openList, openMain, openContext, } = useStackNavigation({
        resolvedMode,
        history,
        resolvePane: mapContextPaneToMain,
    });
    const navigation = useMemo(() => ({
        mode: resolvedMode,
        activePane,
        openList,
        openMain,
        openContext,
    }), [activePane, openContext, openList, openMain, resolvedMode]);
    const isStack = resolvedMode === 'stack';
    const listHidden = isStack && activePane !== 'list';
    const mainHidden = isStack && activePane !== 'main';
    return (_jsx(WorkspaceLayoutContext.Provider, { value: navigation, children: _jsxs("section", { className: cn('flex min-h-0 flex-1 flex-col bg-background', className), "data-workspace-layout": "two-pane", "data-workspace-mode": resolvedMode, children: [header ? (_jsx("header", { className: "h-16 shrink-0 border-b border-border bg-layout-content", children: header })) : null, _jsxs("div", { className: cn('grid min-h-0 flex-1', isStack ? 'grid-cols-1' : null), style: isStack ? undefined : twoPaneGridStyle, "data-workspace-layout-mode": mode, "data-workspace-active-pane": activePane, children: [_jsx("aside", { ref: paneRefs.list, className: cn('min-h-0 overflow-y-auto bg-layout-list-item @container', isStack ? 'border-r-0' : 'border-r border-border'), "data-testid": "workspace-list-pane", "data-workspace-pane": "list", hidden: listHidden, tabIndex: isStack ? -1 : undefined, children: list }), _jsxs("main", { ref: paneRefs.main, className: "min-h-0 overflow-y-auto bg-layout-content @container", "data-testid": "workspace-main-pane", "data-workspace-pane": "main", hidden: mainHidden, tabIndex: isStack ? -1 : undefined, children: [isStack ? (_jsx("button", { type: "button", className: "inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground", onClick: openList, children: "\u8FD4\u56DE\u5217\u8868" })) : null, main] })] })] }) }));
}
export function SinglePaneLayout({ header, main, className, }) {
    return (_jsxs("section", { className: cn('flex min-h-0 flex-1 flex-col bg-background', className), "data-workspace-layout": "single-pane", children: [header ? (_jsx("header", { className: "h-16 shrink-0 border-b border-border bg-layout-content", children: header })) : null, _jsx("main", { className: "min-h-0 flex-1 overflow-y-auto bg-layout-content @container", "data-testid": "workspace-content-pane", "data-workspace-pane": "content", children: main })] }));
}
export function ThreePaneLayout({ header, list, main, context, mode = 'auto', history, contextConfig, className, }) {
    const resolvedMode = useResolvedMode(mode);
    const [contextCollapsed, setContextCollapsed] = useState(contextConfig?.initiallyCollapsed ?? false);
    const { activePane, paneRefs, openList, openMain, openContext, } = useStackNavigation({ resolvedMode, history });
    const toggleContextCollapsed = useCallback(() => {
        setContextCollapsed((collapsed) => !collapsed);
    }, []);
    const navigation = useMemo(() => ({
        mode: resolvedMode,
        activePane,
        openList,
        openMain,
        openContext,
    }), [activePane, openContext, openList, openMain, resolvedMode]);
    const isStack = resolvedMode === 'stack';
    const listHidden = isStack && activePane !== 'list';
    const mainHidden = isStack && activePane !== 'main';
    const contextHidden = isStack
        ? activePane !== 'context'
        : Boolean(contextConfig?.collapsible && contextCollapsed);
    return (_jsx(WorkspaceLayoutContext.Provider, { value: navigation, children: _jsxs("section", { className: cn('flex min-h-0 flex-1 flex-col bg-background', className), "data-workspace-layout": "three-pane", "data-workspace-mode": resolvedMode, children: [header ? (_jsx("header", { className: "h-16 shrink-0 border-b border-border bg-layout-content", children: header })) : null, contextConfig?.collapsible && !isStack ? (_jsx("div", { className: "shrink-0 border-b border-border bg-layout-content px-3 py-2", children: _jsx("button", { type: "button", "aria-expanded": !contextCollapsed, className: "inline-flex items-center rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground", onClick: toggleContextCollapsed, children: contextCollapsed ? '展开上下文面板' : '折叠上下文面板' }) })) : null, _jsxs("div", { className: cn('grid min-h-0 flex-1', isStack ? 'grid-cols-1' : null), style: isStack ? undefined : threePaneGridStyle, "data-workspace-layout-mode": mode, "data-workspace-active-pane": activePane, children: [_jsx("aside", { ref: paneRefs.list, className: cn('min-h-0 overflow-y-auto bg-layout-list-item @container', isStack ? 'border-r-0' : 'border-r border-border'), "data-testid": "workspace-list-pane", "data-workspace-pane": "list", hidden: listHidden, tabIndex: isStack ? -1 : undefined, children: list }), _jsxs("main", { ref: paneRefs.main, className: "min-h-0 overflow-y-auto bg-layout-content @container", "data-testid": "workspace-main-pane", "data-workspace-pane": "main", hidden: mainHidden, tabIndex: isStack ? -1 : undefined, children: [isStack ? (_jsx("button", { type: "button", className: "inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground", onClick: openList, children: "\u8FD4\u56DE\u5217\u8868" })) : null, main] }), _jsxs("aside", { ref: paneRefs.context, className: cn('min-h-0 overflow-y-auto bg-layout-content @container', isStack ? 'border-l-0' : 'border-l border-border'), "data-testid": "workspace-context-pane", "data-workspace-pane": "context", hidden: contextHidden, tabIndex: isStack ? -1 : undefined, children: [isStack ? (_jsx("button", { type: "button", className: "inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground", onClick: openMain, children: "\u8FD4\u56DE\u4E3B\u533A\u57DF" })) : null, context] })] })] }) }));
}
