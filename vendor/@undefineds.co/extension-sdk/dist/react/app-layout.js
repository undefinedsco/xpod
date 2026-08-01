import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '@undefineds.co/shared-ui';
const appLayoutGridStyle = {
    gridTemplateColumns: '240px minmax(0, 1fr)',
};
export function AppLayout({ navigation, header, children, className, }) {
    return (_jsxs("section", { className: cn('grid h-screen min-h-0 bg-background', className), style: appLayoutGridStyle, "data-app-layout": "workspace", children: [_jsx("aside", { className: "min-h-0 overflow-y-auto border-r border-border bg-layout-list-item", children: navigation }), _jsxs("div", { className: "flex min-h-0 min-w-0 flex-col bg-layout-content", children: [header ? (_jsx("header", { className: "h-16 shrink-0 border-b border-border", children: header })) : null, _jsx("div", { className: "min-h-0 min-w-0 flex-1 overflow-y-auto", children: children })] })] }));
}
