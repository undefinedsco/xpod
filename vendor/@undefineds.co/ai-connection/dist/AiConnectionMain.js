import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { PROVIDERS, useProviderLoadError, useProviderSummaries, useServiceAccessState, useSelectedProvider, } from './controller.js';
import { AiConnectionPanel } from './AiConnectionPanel.js';
import { Button } from '@undefineds.co/shared-ui';
export function AiConnectionMain({ controller }) {
    const selectedProvider = useSelectedProvider(controller);
    const providerSummaries = useProviderSummaries(controller);
    const providerLoadError = useProviderLoadError(controller);
    const serviceAccessState = useServiceAccessState(controller);
    const provider = PROVIDERS.find((item) => item.id === selectedProvider);
    if (!controller.client) {
        const expired = controller.sessionStatus === 'expired';
        const opening = controller.sessionStatus === 'authenticating'
            || controller.podStatus === 'opening';
        const error = controller.error
            ?? (controller.sessionStatus === 'authenticated' && controller.podStatus !== 'ready'
                ? new Error('当前 Pod 尚未就绪')
                : undefined);
        if (opening) {
            return (_jsx("section", { "aria-label": "AI Connection", className: "space-y-3 p-6", children: _jsx("p", { role: "status", children: "\u6B63\u5728\u6253\u5F00\u5F53\u524D Pod..." }) }));
        }
        if (error) {
            return (_jsxs("section", { "aria-label": "AI Connection", className: "space-y-3 p-6", children: [_jsx("p", { className: "text-sm text-destructive", children: error.message }), _jsx(Button, { size: "sm", onClick: () => void controller.login(), children: "\u91CD\u8BD5\u767B\u5F55" })] }));
        }
        return (_jsxs("section", { "aria-label": "AI Connection", className: "space-y-3 p-6", children: [_jsx("p", { children: expired
                        ? '当前登录已过期，请重新登录后继续。'
                        : '登录后即可管理当前 Pod 的 AI 连接。' }), _jsx(Button, { size: "sm", onClick: () => void controller.login(), children: expired ? '重新登录' : '登录' })] }));
    }
    return (_jsxs("section", { role: "region", "aria-label": `${provider?.name ?? selectedProvider} 详情`, children: [_jsx("p", { className: "px-6 pt-4 text-xs text-muted-foreground", role: "status", children: serviceAccessStateLabel(serviceAccessState) }), _jsx(AiConnectionPanel, { client: controller.client, selectedProvider: selectedProvider, openExternal: controller.openExternal, clientConfigurationBridge: controller.clientConfigurationBridge, providerSummaries: providerSummaries, providerLoadError: providerLoadError, serviceAccessGranted: serviceAccessState === 'granted', onProviderStateChange: controller.setProviderState })] }));
}
function serviceAccessStateLabel(state) {
    if (state === 'granted')
        return '服务访问已授权';
    if (state === 'checking')
        return '服务访问检查中';
    return '服务访问未授权';
}
