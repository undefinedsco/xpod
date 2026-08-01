import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AppletList, AppletListItem } from '@undefineds.co/shared-ui';
import { PROVIDERS, useProviderLoadError, useProviderSearch, useProviderStates, useSelectedProvider, } from './controller.js';
export function AiConnectionList({ controller }) {
    const selectedProvider = useSelectedProvider(controller);
    const searchQuery = useProviderSearch(controller).trim().toLocaleLowerCase();
    const providerStates = useProviderStates(controller);
    const providerLoadError = useProviderLoadError(controller);
    const providers = searchQuery
        ? PROVIDERS.filter((provider) => provider.name.toLocaleLowerCase().includes(searchQuery))
        : PROVIDERS;
    return (_jsxs(AppletList, { "aria-label": "AI \u670D\u52A1", children: [providers.map((provider) => (_jsx(ProviderListItem, { provider: provider, selected: selectedProvider === provider.id, state: providerStates[provider.id] ?? 'loading', onSelect: () => controller.selectProvider(provider.id) }, provider.id))), providers.length === 0 ? (_jsx("p", { className: "px-3 py-6 text-center text-xs text-muted-foreground", children: "\u6CA1\u6709\u5339\u914D\u7684 Provider" })) : null, providerLoadError ? (_jsxs("p", { className: "px-3 py-2 text-xs text-destructive", children: ["Provider \u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A", providerLoadError] })) : null] }));
}
function ProviderListItem({ provider, selected, state, onSelect, }) {
    const statusId = `ai-connection-provider-${provider.id}-status`;
    const stateLabel = providerStateLabel(state);
    return (_jsxs(AppletListItem, { selected: selected, "aria-label": provider.name, "aria-describedby": statusId, onClick: onSelect, className: "gap-3 py-2.5", children: [_jsx("span", { "aria-hidden": "true", className: "flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground", children: providerMark(provider.id) }), _jsx("span", { className: "min-w-0 flex-1 truncate", children: provider.name }), _jsx("span", { id: statusId, role: "status", "aria-live": "polite", className: "shrink-0 text-[11px] font-normal text-muted-foreground", children: stateLabel })] }));
}
function providerMark(provider) {
    switch (provider) {
        case 'openai': return 'OA';
        case 'anthropic': return 'A';
        case 'kimi': return 'K';
        case 'bailian': return '百';
        case 'deepseek': return 'DS';
    }
}
function providerStateLabel(state) {
    switch (state) {
        case 'unconfigured': return '未设置';
        case 'configured': return '已配置';
        case 'connected': return '已连接';
        case 'attention': return '需处理';
        default: return '读取中';
    }
}
