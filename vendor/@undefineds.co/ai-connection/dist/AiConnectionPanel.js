import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, } from '@undefineds.co/shared-ui';
import { normalizeAiConnectionThrownError, } from './ai-connection-client.js';
import { PROVIDERS, } from './controller.js';
import { Check, Copy, KeyRound, Loader2, Trash2, } from 'lucide-react';
import { AI_CLIENT_LABELS, AiClientConfigurationSection, } from './AiClientConfigurationSection.js';
import { AiProviderCard, } from './AiProviderCard.js';
const EMPTY_PROVIDER_SUMMARIES = {};
export function AiConnectionPanel({ client, openExternal = openExternalUrl, clientConfigurationBridge, selectedProvider, providerSummaries: providerSummariesInput = EMPTY_PROVIDER_SUMMARIES, providerLoadError, serviceAccessGranted = false, onProviderStateChange, }) {
    const [keys, setKeys] = useState([]);
    const [keysLoading, setKeysLoading] = useState(true);
    const [keyName, setKeyName] = useState('');
    const [creatingKey, setCreatingKey] = useState(false);
    const [oneTimeKey, setOneTimeKey] = useState();
    const [keyError, setKeyError] = useState();
    const [connectionStates, setConnectionStates] = useState({});
    const [models, setModels] = useState([]);
    const [attempts, setAttempts] = useState({});
    const [apiKeyInputs, setApiKeyInputs] = useState({});
    const [busyProviders, setBusyProviders] = useState({});
    const [providerErrors, setProviderErrors] = useState({});
    const [quotas, setQuotas] = useState({});
    const [copied, setCopied] = useState(false);
    const pollingGeneration = useRef(0);
    const updateConnectionState = useCallback((provider, state) => {
        setConnectionStates((current) => ({ ...current, [provider]: state }));
        onProviderStateChange?.(provider, productStateFromConnection(state));
    }, [onProviderStateChange]);
    useEffect(() => {
        setConnectionStates(Object.fromEntries(Object.values(providerSummariesInput).filter(isDefined).map((summary) => [
            summary.provider,
            summary.status === 'connected' && summary.authMode === 'browserAssistedApiKey'
                ? 'configured'
                : summary.status,
        ])));
    }, [providerSummariesInput]);
    useEffect(() => {
        let active = true;
        setKeysLoading(true);
        void client.listGatewayKeys()
            .then((records) => {
            if (active)
                setKeys(records);
        })
            .catch((error) => {
            if (active)
                setKeyError(errorMessage(error));
        })
            .finally(() => {
            if (active)
                setKeysLoading(false);
        });
        void client.listModels()
            .then((availableModels) => {
            if (active)
                setModels(availableModels);
        })
            .catch((error) => {
            if (active)
                setKeyError(errorMessage(error));
        });
        return () => {
            active = false;
            pollingGeneration.current += 1;
        };
    }, [client]);
    const setBusy = (provider, value) => {
        setBusyProviders((current) => ({ ...current, [provider]: value }));
    };
    const setProviderError = (provider, value) => {
        setProviderErrors((current) => ({ ...current, [provider]: value }));
    };
    const openAttemptUrl = useCallback(async (attempt) => {
        const target = attempt.verificationUriComplete
            ?? attempt.authorizationUrl
            ?? attempt.verificationUri;
        if (target)
            await openExternal(target);
    }, [openExternal]);
    const beginApiKey = async (provider) => {
        if (!serviceAccessGranted)
            return;
        setBusy(provider, true);
        setProviderError(provider);
        try {
            const attempt = await client.beginConnect(provider, 'browserAssistedApiKey');
            setAttempts((current) => ({ ...current, [provider]: attempt }));
            const pending = isPendingAttempt(attempt.status);
            updateConnectionState(provider, pending ? 'pending' : attempt.status === 'completed' ? 'configured' : 'failed');
            if (!pending && attempt.status !== 'completed') {
                setProviderError(provider, attempt.message ?? connectFailureMessage(attempt.status));
                return;
            }
            await openAttemptUrl(attempt);
        }
        catch (error) {
            updateConnectionState(provider, 'failed');
            setProviderError(provider, errorMessage(error));
        }
        finally {
            setBusy(provider, false);
        }
    };
    const beginBrowserConnect = async (definition) => {
        if (!serviceAccessGranted)
            return;
        if (definition.browserMode === 'connectUnsupported')
            return;
        if (definition.browserMode === 'browserAssistedApiKey') {
            await beginApiKey(definition.id);
            return;
        }
        setBusy(definition.id, true);
        setProviderError(definition.id);
        const generation = pollingGeneration.current + 1;
        pollingGeneration.current = generation;
        try {
            const attempt = await client.beginConnect(definition.id, definition.browserMode);
            setAttempts((current) => ({ ...current, [definition.id]: attempt }));
            if (!isPendingAttempt(attempt.status)) {
                const connected = attempt.status === 'completed';
                updateConnectionState(definition.id, connected ? 'connected' : 'failed');
                if (!connected) {
                    setProviderError(definition.id, attempt.message ?? connectFailureMessage(attempt.status));
                }
                setBusy(definition.id, false);
                return;
            }
            updateConnectionState(definition.id, 'pending');
            await openAttemptUrl(attempt);
            void pollDeviceConnect(client, definition.id, attempt, generation, pollingGeneration, {
                onAttempt: (next) => setAttempts((current) => ({ ...current, [definition.id]: next })),
                onConnected: () => updateConnectionState(definition.id, 'connected'),
                onFailed: (message) => {
                    updateConnectionState(definition.id, 'failed');
                    setProviderError(definition.id, message);
                },
                onFinished: () => setBusy(definition.id, false),
            });
        }
        catch (error) {
            updateConnectionState(definition.id, 'failed');
            setProviderError(definition.id, errorMessage(error));
            setBusy(definition.id, false);
        }
    };
    const saveApiKey = async (definition) => {
        if (!serviceAccessGranted)
            return;
        const apiKey = apiKeyInputs[definition.id]?.trim();
        const attempt = attempts[definition.id];
        if (!apiKey || !attempt)
            return;
        setBusy(definition.id, true);
        setProviderError(definition.id);
        try {
            const result = await client.completeApiKey(definition.id, attempt, apiKey);
            setAttempts((current) => ({ ...current, [definition.id]: result }));
            setApiKeyInputs((current) => ({ ...current, [definition.id]: '' }));
            updateConnectionState(definition.id, 'configured');
        }
        catch (error) {
            setProviderError(definition.id, errorMessage(error));
            updateConnectionState(definition.id, 'failed');
        }
        finally {
            setBusy(definition.id, false);
        }
    };
    const disconnect = async (provider) => {
        if (!serviceAccessGranted)
            return;
        setBusy(provider, true);
        setProviderError(provider);
        try {
            await client.disconnect(provider);
            setAttempts((current) => ({ ...current, [provider]: undefined }));
            setQuotas((current) => ({ ...current, [provider]: undefined }));
            updateConnectionState(provider, 'disconnected');
        }
        catch (error) {
            setProviderError(provider, errorMessage(error));
        }
        finally {
            setBusy(provider, false);
        }
    };
    const refreshQuota = async (provider) => {
        setBusy(provider, true);
        setProviderError(provider);
        try {
            const quota = await client.quota(provider, true);
            setQuotas((current) => ({ ...current, [provider]: quota }));
        }
        catch (error) {
            setProviderError(provider, errorMessage(error));
        }
        finally {
            setBusy(provider, false);
        }
    };
    const createKey = async () => {
        if (!serviceAccessGranted)
            return;
        setCreatingKey(true);
        setKeyError(undefined);
        setOneTimeKey(undefined);
        try {
            const created = await client.createGatewayKey({
                ...(keyName.trim() ? { name: keyName.trim() } : {}),
            });
            setOneTimeKey(created.plaintext);
            setKeys((current) => [created.record, ...current]);
            setKeyName('');
        }
        catch (error) {
            setKeyError(errorMessage(error));
        }
        finally {
            setCreatingKey(false);
        }
    };
    const revokeKey = async (keyId) => {
        if (!serviceAccessGranted)
            return;
        setKeyError(undefined);
        try {
            const record = await client.revokeGatewayKey(keyId);
            setKeys((current) => current.map((item) => item.id === keyId
                ? (record ?? { ...item, revokedAt: new Date().toISOString() })
                : item));
        }
        catch (error) {
            setKeyError(errorMessage(error));
        }
    };
    const copyOneTimeKey = async () => {
        if (!oneTimeKey)
            return;
        await navigator.clipboard?.writeText(oneTimeKey);
        setCopied(true);
    };
    const createManagedGatewayKey = useCallback(async (targetClient) => {
        if (!serviceAccessGranted) {
            throw new Error('AI Connection service access is not granted');
        }
        const created = await client.createGatewayKey({
            name: `AI Connection · ${AI_CLIENT_LABELS[targetClient]}`,
        });
        setKeys((current) => [
            created.record,
            ...current.filter((record) => record.id !== created.record.id),
        ]);
        return {
            gatewayKey: created.plaintext,
            revoke: async () => {
                await client.revokeGatewayKey(created.record.id);
                setKeys((current) => current.map((record) => record.id === created.record.id
                    ? { ...record, revokedAt: new Date().toISOString() }
                    : record));
            },
        };
    }, [client, serviceAccessGranted]);
    return (_jsxs("div", { className: "mx-auto w-full max-w-3xl px-6 py-6", children: [_jsxs("section", { children: [providerLoadError ? (_jsxs("p", { className: "mb-4 rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive", children: ["Provider \u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A", providerLoadError] })) : null, PROVIDERS.filter((definition) => definition.id === (selectedProvider ?? 'openai')).map((definition) => (_jsx(AiProviderCard, { definition: definition, status: connectionStates[definition.id] ?? 'unknown', accountLabel: providerSummariesInput[definition.id]?.accountLabel, attempt: attempts[definition.id], apiKey: apiKeyInputs[definition.id] ?? '', busy: Boolean(busyProviders[definition.id]), disabled: !serviceAccessGranted, error: providerErrors[definition.id], quota: quotas[definition.id], models: models.filter((model) => model.provider === definition.id), onApiKeyChange: (value) => setApiKeyInputs((current) => ({
                            ...current,
                            [definition.id]: value,
                        })), onBeginApiKey: () => void beginApiKey(definition.id), onBeginBrowser: () => void beginBrowserConnect(definition), onSaveApiKey: () => void saveApiKey(definition), onDisconnect: () => void disconnect(definition.id), onRefreshQuota: () => void refreshQuota(definition.id) }, definition.id)))] }), _jsxs("details", { className: "border-t border-border/60 py-5", children: [_jsx("summary", { className: "cursor-pointer list-none text-sm font-medium", children: "\u5BA2\u6237\u7AEF\u63A5\u5165" }), _jsxs("div", { className: "mt-4 space-y-6", children: [_jsx(AiClientConfigurationSection, { bridge: clientConfigurationBridge, endpoint: client.apiBase, createGatewayKey: createManagedGatewayKey }), _jsxs("details", { className: "border-t border-border/60 pt-4", children: [_jsx("summary", { className: "cursor-pointer text-sm font-medium text-muted-foreground", children: "\u9AD8\u7EA7\uFF1AGateway Keys" }), _jsx("div", { className: "mt-3", children: _jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsxs(CardTitle, { className: "flex items-center gap-2 text-base", children: [_jsx(KeyRound, { className: "h-4 w-4" }), "Gateway Keys"] }), _jsx(CardDescription, { children: "\u7F16\u7801\u5BA2\u6237\u7AEF\u53EA\u4F7F\u7528 Gateway Key\uFF1B\u65B0\u5BC6\u94A5\u660E\u6587\u4EC5\u5728\u521B\u5EFA\u540E\u663E\u793A\u4E00\u6B21\u3002" })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { "aria-label": "Gateway Key \u540D\u79F0", placeholder: "\u540D\u79F0\uFF0C\u4F8B\u5982 Codex", value: keyName, onChange: (event) => setKeyName(event.target.value) }), _jsxs(Button, { onClick: () => void createKey(), disabled: creatingKey || !serviceAccessGranted, children: [creatingKey ? _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }) : _jsx(KeyRound, { className: "mr-2 h-4 w-4" }), "\u521B\u5EFA Gateway Key"] })] }), oneTimeKey ? (_jsxs("div", { className: "space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4", children: [_jsx("p", { className: "text-sm font-medium", children: "\u8BF7\u7ACB\u5373\u4FDD\u5B58\uFF1B\u5173\u95ED\u540E\u65E0\u6CD5\u518D\u6B21\u67E5\u770B\u3002" }), _jsx("code", { className: "block overflow-x-auto rounded bg-background p-3 text-xs", children: oneTimeKey }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: () => void copyOneTimeKey(), children: [copied ? _jsx(Check, { className: "mr-2 h-4 w-4" }) : _jsx(Copy, { className: "mr-2 h-4 w-4" }), copied ? '已复制' : '复制'] }), _jsx(Button, { size: "sm", onClick: () => {
                                                                                setOneTimeKey(undefined);
                                                                                setCopied(false);
                                                                            }, children: "\u6211\u5DF2\u4FDD\u5B58\uFF0C\u9690\u85CF\u5BC6\u94A5" })] })] })) : null, keyError ? _jsx("p", { className: "text-sm text-destructive", children: keyError }) : null, keysLoading ? (_jsxs("div", { className: "flex items-center gap-2 text-sm text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "\u6B63\u5728\u8BFB\u53D6 Gateway Keys"] })) : keys.length === 0 ? (_jsx("p", { className: "text-sm text-muted-foreground", children: "\u5C1A\u672A\u521B\u5EFA Gateway Key\u3002" })) : (_jsx("div", { className: "space-y-2", children: keys.map((key) => (_jsxs("div", { className: "flex items-center justify-between gap-3 rounded-lg border p-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm font-medium", children: key.name || key.id }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground", children: [key.scopes.join(' · '), key.revokedAt ? ' · 已撤销' : ''] })] }), _jsx(Button, { variant: "ghost", size: "icon", "aria-label": `撤销 ${key.name || key.id}`, disabled: Boolean(key.revokedAt) || !serviceAccessGranted, onClick: () => void revokeKey(key.id), children: _jsx(Trash2, { className: "h-4 w-4" }) })] }, key.id))) }))] })] }) })] })] })] })] }));
}
async function pollDeviceConnect(client, provider, initial, generation, generationRef, callbacks) {
    let attempt = initial;
    try {
        while (generationRef.current === generation && isPendingAttempt(attempt.status)) {
            await delay(Math.max(1, attempt.intervalSeconds ?? 2) * 1000);
            if (generationRef.current !== generation)
                return;
            attempt = await client.pollDevice(provider, attempt);
            callbacks.onAttempt(attempt);
        }
        if (attempt.status === 'completed') {
            callbacks.onConnected();
        }
        else if (generationRef.current === generation) {
            callbacks.onFailed(attempt.message || `连接${attempt.status === 'expired' ? '已过期' : '失败'}`);
        }
    }
    catch (error) {
        if (generationRef.current === generation)
            callbacks.onFailed(errorMessage(error));
    }
    finally {
        if (generationRef.current === generation)
            callbacks.onFinished();
    }
}
function isPendingAttempt(status) {
    return status === 'pending' || status === 'authorization_pending' || status === 'slow_down';
}
function connectFailureMessage(status) {
    if (status === 'expired')
        return '连接已过期，请重新开始';
    if (status === 'cancelled')
        return '连接已取消';
    if (status === 'unsupported')
        return '当前 Provider 不支持此连接方式';
    return '连接失败';
}
function productStateFromConnection(state) {
    if (state === 'configured')
        return 'configured';
    if (state === 'connected')
        return 'connected';
    if (state === 'failed' || state === 'reauthRequired')
        return 'attention';
    if (state === 'pending')
        return 'loading';
    return 'unconfigured';
}
function openExternalUrl(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
}
function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
function errorMessage(error) {
    return normalizeAiConnectionThrownError(error);
}
function isDefined(value) {
    return value !== undefined;
}
