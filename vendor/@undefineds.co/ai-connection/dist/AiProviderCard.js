import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Badge, Button, Input, } from '@undefineds.co/shared-ui';
import { ExternalLink, KeyRound, Loader2, LogOut, RotateCw, } from 'lucide-react';
import { AiQuotaCard } from './AiQuotaCard.js';
export function AiProviderCard({ definition, status, accountLabel, attempt, apiKey, busy, disabled = false, error, quota, models, onApiKeyChange, onBeginApiKey, onBeginBrowser, onSaveApiKey, onDisconnect, onRefreshQuota, }) {
    const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending';
    const isConfigured = status === 'configured';
    const isConnected = status === 'connected';
    return (_jsxs("div", { children: [_jsxs("header", { className: "flex items-start justify-between gap-4 pb-5", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h2", { className: "text-lg font-semibold text-foreground", children: definition.name }), _jsx("p", { className: "mt-1 text-sm text-muted-foreground", children: providerDescription(definition.id) })] }), _jsx(Badge, { variant: isConnected || isConfigured ? 'default' : 'secondary', children: connectionStatusLabel(status) })] }), _jsxs("section", { className: "border-t border-border/60 py-5", "aria-label": "\u5F53\u524D\u8FDE\u63A5", children: [_jsxs("div", { className: "mb-4", children: [_jsx("h3", { className: "text-sm font-medium", children: "\u5F53\u524D\u8FDE\u63A5" }), accountLabel ? (_jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: maskAccountLabel(accountLabel) })) : (_jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Provider \u51ED\u8BC1\u52A0\u5BC6\u4FDD\u5B58\u5728\u5F53\u524D Pod\u3002" }))] }), attempt?.userCode ? (_jsxs("div", { className: "mb-4 border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm", children: ["\u9A8C\u8BC1\u7801\uFF1A", _jsx("strong", { className: "font-mono", children: attempt.userCode })] })) : null, _jsx("div", { className: "flex flex-wrap gap-2", children: isConnected ? (_jsxs(_Fragment, { children: [_jsxs(Button, { variant: "outline", size: "sm", disabled: busy || disabled, onClick: onBeginBrowser, children: [busy ? _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }) : _jsx(RotateCw, { className: "mr-2 h-4 w-4" }), "\u91CD\u65B0\u8FDE\u63A5"] }), _jsxs(Button, { variant: "ghost", size: "sm", disabled: busy || disabled, onClick: onDisconnect, children: [_jsx(LogOut, { className: "mr-2 h-4 w-4" }), "\u65AD\u5F00\u8FDE\u63A5"] })] })) : isConfigured ? (_jsxs(_Fragment, { children: [_jsxs(Button, { variant: "outline", size: "sm", "aria-label": "\u66F4\u65B0 API Key", disabled: busy || disabled, onClick: onBeginApiKey, children: [_jsx(KeyRound, { className: "mr-2 h-4 w-4" }), "\u66F4\u65B0 API Key"] }), _jsx(Button, { variant: "ghost", size: "sm", disabled: busy || disabled, onClick: onDisconnect, children: "\u79FB\u9664\u914D\u7F6E" })] })) : (_jsxs(_Fragment, { children: [_jsxs(Button, { variant: "outline", size: "sm", disabled: busy || disabled || definition.browserMode === 'connectUnsupported', onClick: onBeginBrowser, children: [busy ? _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }) : _jsx(ExternalLink, { className: "mr-2 h-4 w-4" }), definition.browserLabel] }), _jsxs(Button, { variant: "outline", size: "sm", "aria-label": `${definition.name} API Key`, disabled: busy || disabled, onClick: onBeginApiKey, children: [_jsx(KeyRound, { className: "mr-2 h-4 w-4" }), "\u914D\u7F6E API Key"] })] })) }), apiKeyAttempt ? (_jsxs("div", { className: "mt-4 space-y-2", children: [_jsx(Input, { type: "password", autoComplete: "off", "aria-label": `${definition.name} API Key 输入`, placeholder: "\u4ECE\u5B98\u65B9\u63A7\u5236\u53F0\u590D\u5236 API Key", value: apiKey, onChange: (event) => onApiKeyChange(event.target.value) }), _jsx(Button, { size: "sm", "aria-label": `保存 ${definition.name} API Key`, disabled: !apiKey.trim() || busy || disabled, onClick: onSaveApiKey, children: "\u4FDD\u5B58 API Key" })] })) : null, error ? _jsx("p", { className: "mt-3 text-sm text-destructive", children: error }) : null] }), _jsx("section", { className: "border-t border-border/60 py-5", children: _jsx(AiQuotaCard, { providerName: definition.name, quota: quota, busy: busy, disabled: disabled, onRefresh: onRefreshQuota }) }), _jsxs("section", { className: "border-t border-border/60 py-5", children: [_jsx("h3", { className: "text-sm font-medium", children: "\u53EF\u7528\u6A21\u578B" }), models.length === 0 ? (_jsx("p", { className: "mt-2 text-xs text-muted-foreground", children: "\u5F53\u524D\u8EAB\u4EFD\u6682\u65E0\u53EF\u7528\u6A21\u578B" })) : (_jsx("ul", { className: "mt-3 divide-y divide-border/50 text-sm", children: models.map((model) => (_jsxs("li", { className: "flex items-center justify-between gap-4 py-2.5", children: [_jsx("span", { children: model.displayName ?? model.id }), model.displayName ? (_jsx("span", { className: "truncate font-mono text-xs text-muted-foreground", children: model.id })) : null] }, model.id))) }))] })] }));
}
function providerDescription(provider) {
    switch (provider) {
        case 'openai': return 'OpenAI 模型与编码能力';
        case 'anthropic': return 'Claude 模型与编码能力';
        case 'kimi': return 'Moonshot AI 模型服务';
        case 'bailian': return '阿里云百炼模型服务';
        case 'deepseek': return 'DeepSeek 模型服务';
    }
}
function connectionStatusLabel(status) {
    switch (status) {
        case 'pending': return '连接中';
        case 'configured': return '已配置';
        case 'connected': return '已连接';
        case 'disconnected': return '未设置';
        case 'reauthRequired': return '需要重新鉴权';
        case 'failed': return '连接失败';
        default: return '未检查';
    }
}
function maskAccountLabel(value) {
    const at = value.indexOf('@');
    if (at > 0) {
        const accountName = value.slice(0, at);
        const visible = accountName.length > 1
            ? `${accountName[0]}***${accountName[accountName.length - 1]}`
            : `${accountName[0]}***`;
        return `${visible}${value.slice(at)}`;
    }
    if (value.length <= 2)
        return `${value[0] ?? ''}***`;
    return `${value[0]}***${value[value.length - 1]}`;
}
