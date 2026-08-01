import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, } from '@undefineds.co/shared-ui';
import { MonitorCog, RotateCcw } from 'lucide-react';
import { normalizeAiConnectionThrownError } from './ai-connection-client.js';
export const AI_CONNECTION_CLIENTS = ['codex', 'claude-code', 'pi', 'codebuddy'];
export const AI_CLIENT_LABELS = {
    codex: 'Codex',
    'claude-code': 'Claude Code',
    pi: 'Pi',
    codebuddy: 'CodeBuddy',
};
export function AiClientConfigurationSection({ bridge, endpoint, createGatewayKey, }) {
    const [statuses, setStatuses] = useState({});
    const [plans, setPlans] = useState({});
    const [confirmations, setConfirmations] = useState({});
    const [busy, setBusy] = useState();
    useEffect(() => {
        if (!bridge)
            return;
        let active = true;
        void Promise.all(AI_CONNECTION_CLIENTS.map(async (client) => {
            let status;
            try {
                status = await bridge.inspect(client);
            }
            catch (error) {
                status = { status: 'unavailable', message: errorMessage(error) };
            }
            if (active) {
                setStatuses((current) => ({ ...current, [client]: status }));
            }
        }));
        return () => {
            active = false;
        };
    }, [bridge]);
    const plan = async (client) => {
        if (!bridge)
            return;
        setBusy(client);
        try {
            const dryRun = await bridge.plan({
                client,
                endpoint,
            });
            setPlans((current) => ({ ...current, [client]: dryRun }));
            setConfirmations((current) => ({ ...current, [client]: '' }));
        }
        catch (error) {
            setStatuses((current) => ({
                ...current,
                [client]: { status: 'unavailable', message: errorMessage(error) },
            }));
        }
        finally {
            setBusy(undefined);
        }
    };
    const apply = async (client) => {
        const dryRun = plans[client];
        if (!bridge || !dryRun || !createGatewayKey)
            return;
        setBusy(client);
        let lease;
        let applied = false;
        try {
            lease = await createGatewayKey(client);
            await bridge.apply({
                client,
                planId: dryRun.planId,
                gatewayKey: lease.gatewayKey,
                ...(dryRun.confirmation?.required ? {
                    confirmation: {
                        token: dryRun.confirmation.token,
                        targetHash: dryRun.confirmation.targetHash,
                    },
                } : {}),
            });
            applied = true;
            const status = await bridge.verify({ client, planId: dryRun.planId });
            setStatuses((current) => ({ ...current, [client]: status }));
            setPlans((current) => ({ ...current, [client]: undefined }));
        }
        catch (error) {
            let recoveryMessage = errorMessage(error);
            if (lease && !applied) {
                try {
                    await lease.revoke();
                }
                catch (revokeError) {
                    recoveryMessage = `${recoveryMessage}；自动撤销 Gateway Key 失败：${errorMessage(revokeError)}。请在“高级：Gateway Keys”中手动撤销。`;
                }
            }
            setStatuses((current) => ({
                ...current,
                [client]: failedAndRestoredError(error)
                    ? { status: 'failedAndRestored', message: '配置验证失败，已自动恢复原配置。' }
                    : { status: 'unavailable', message: recoveryMessage },
            }));
        }
        finally {
            setBusy(undefined);
        }
    };
    const restore = async (client) => {
        if (!bridge)
            return;
        setBusy(client);
        try {
            const status = await bridge.restore(client);
            setStatuses((current) => ({ ...current, [client]: status }));
        }
        catch (error) {
            setStatuses((current) => ({
                ...current,
                [client]: { status: 'unavailable', message: errorMessage(error) },
            }));
        }
        finally {
            setBusy(undefined);
        }
    };
    return (_jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsxs(CardTitle, { className: "flex items-center gap-2 text-base", children: [_jsx(MonitorCog, { className: "h-4 w-4" }), "\u7F16\u7801\u5BA2\u6237\u7AEF"] }), _jsx(CardDescription, { children: "AI Connection \u81EA\u52A8\u7BA1\u7406\u5BA2\u6237\u7AEF\u8BBF\u95EE\u5BC6\u94A5\uFF1BProvider \u51ED\u8BC1\u4E0D\u4F1A\u79BB\u5F00 Pod\u3002" })] }), _jsx(CardContent, { className: "space-y-2", children: AI_CONNECTION_CLIENTS.map((client) => {
                    const status = statuses[client] ?? {
                        status: bridge ? 'notConfigured' : 'unavailable',
                        message: bridge ? undefined : '当前 Host 不支持修改本机客户端配置。',
                    };
                    const dryRun = plans[client];
                    const confirmation = dryRun?.confirmation;
                    const confirmationValue = confirmations[client] ?? '';
                    const confirmationSatisfied = !confirmation?.required || confirmationValue === confirmation.token;
                    return (_jsxs("div", { className: "space-y-3 rounded-lg border p-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: AI_CLIENT_LABELS[client] }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: status.message ?? statusLabel(status.status) })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Badge, { variant: "secondary", children: statusLabel(status.status) }), _jsx(Button, { variant: "outline", size: "sm", disabled: !bridge || Boolean(busy), onClick: () => void plan(client), children: "\u914D\u7F6E" }), _jsx(Button, { variant: "ghost", size: "icon", "aria-label": `恢复 ${AI_CLIENT_LABELS[client]} 配置`, disabled: !bridge || status.status === 'notConfigured' || Boolean(busy), onClick: () => void restore(client), children: _jsx(RotateCcw, { className: "h-4 w-4" }) })] })] }), dryRun ? (_jsxs("div", { className: "space-y-2 rounded-md border bg-muted/20 p-3", children: [_jsx("div", { className: "text-xs font-medium", children: "\u5C06\u6267\u884C\u4EE5\u4E0B\u66F4\u6539" }), dryRun.changes.map((change) => (_jsxs("div", { className: "text-xs text-muted-foreground", children: [_jsx("span", { className: "font-mono", children: change.target }), ' · ', changeActionLabel(change.action), change.backup ? ' · 创建备份' : ''] }, `${change.target}:${change.action}`))), confirmation?.required ? (_jsxs("div", { className: "space-y-2", children: [confirmation.message ? (_jsx("div", { className: "text-xs text-muted-foreground", children: confirmation.message })) : null, _jsx(Input, { "aria-label": `输入确认码以应用 ${AI_CLIENT_LABELS[client]} 配置`, value: confirmationValue, onChange: (event) => setConfirmations((current) => ({
                                                    ...current,
                                                    [client]: event.target.value,
                                                })) })] })) : null, _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { size: "sm", "aria-label": confirmation?.required
                                                    ? `确认并应用 ${AI_CLIENT_LABELS[client]} 配置`
                                                    : `应用 ${AI_CLIENT_LABELS[client]} 配置`, disabled: !createGatewayKey || Boolean(busy) || !confirmationSatisfied, onClick: () => void apply(client), children: confirmation?.required ? '确认并应用' : '应用更改' }), _jsx(Button, { variant: "ghost", size: "sm", disabled: Boolean(busy), onClick: () => {
                                                    setPlans((current) => ({ ...current, [client]: undefined }));
                                                    setConfirmations((current) => ({ ...current, [client]: undefined }));
                                                }, children: "\u53D6\u6D88" })] })] })) : null] }, client));
                }) })] }));
}
function changeActionLabel(action) {
    switch (action) {
        case 'update': return '更新';
        case 'delete': return '删除';
        default: return '创建或更新';
    }
}
function statusLabel(status) {
    switch (status) {
        case 'configured': return '已配置';
        case 'drifted': return '配置已变化';
        case 'unverifiable': return '无法验证';
        case 'failedAndRestored': return '已恢复';
        case 'unavailable': return '当前不可用';
        default: return '未配置';
    }
}
function failedAndRestoredError(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error &&
        error.code === 'verification_failed_restored');
}
function errorMessage(error) {
    return normalizeAiConnectionThrownError(error);
}
