import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Input } from '@undefineds.co/shared-ui';
import { Search } from 'lucide-react';
import { useProviderSearch, } from './controller.js';
export function AiConnectionHeader({ controller, }) {
    const searchQuery = useProviderSearch(controller);
    return (_jsxs("div", { className: "flex h-full min-w-0 items-center gap-4 px-4", children: [_jsx("h1", { className: "shrink-0 text-sm font-medium text-foreground", children: "AI Connection" }), _jsxs("div", { className: "relative ml-auto w-full max-w-xs", children: [_jsx(Search, { "aria-hidden": "true", className: "pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" }), _jsx(Input, { type: "search", "aria-label": "\u641C\u7D22 Provider", placeholder: "\u641C\u7D22 Provider", value: searchQuery, onChange: (event) => controller.setSearchQuery(event.target.value), className: "h-8 border-transparent bg-muted/50 pl-8 text-xs focus-visible:bg-background" })] })] }));
}
