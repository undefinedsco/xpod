import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useId, useMemo, useState } from 'react';
import { Button, Input } from '@undefineds.co/shared-ui';
const defaultLoginTitle = 'Connect Solid Pod';
const safeLoginErrorMessage = '登录失败，请重试。';
function normalizeLoginError() {
    return safeLoginErrorMessage;
}
function AuthSurface({ children, labelledBy, }) {
    return (_jsx("section", { className: "flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground", "aria-labelledby": labelledBy, "data-auth-boundary": "surface", children: _jsx("div", { className: "w-full max-w-md rounded-lg border border-border bg-layout-content px-8 py-7 shadow-sm", children: children }) }));
}
export function LoginView({ title, description, defaultIssuer = '', logo, error, onLogin, }) {
    const titleId = useId();
    const issuerId = useId();
    const errorId = useId();
    const [issuer, setIssuer] = useState(defaultIssuer);
    const [pending, setPending] = useState(false);
    const [submitError, setSubmitError] = useState();
    const normalizedIssuer = issuer.trim();
    const visibleError = submitError ?? error;
    const describedBy = useMemo(() => (visibleError ? errorId : undefined), [errorId, visibleError]);
    async function handleSubmit(event) {
        event.preventDefault();
        if (!normalizedIssuer || pending) {
            return;
        }
        setPending(true);
        setSubmitError(undefined);
        try {
            await onLogin(normalizedIssuer);
        }
        catch {
            setSubmitError(normalizeLoginError());
        }
        finally {
            setPending(false);
        }
    }
    return (_jsx(AuthSurface, { labelledBy: titleId, children: _jsxs("div", { className: "flex flex-col gap-6", children: [_jsxs("div", { className: "flex flex-col gap-3 text-center", children: [logo ? (_jsx("div", { className: "flex justify-center", "aria-hidden": "true", children: logo })) : null, _jsxs("div", { className: "flex flex-col gap-2", children: [_jsx("h1", { id: titleId, className: "text-2xl font-semibold leading-8 tracking-normal", children: title }), description ? (_jsx("p", { className: "text-sm leading-6 text-muted-foreground", children: description })) : null] })] }), _jsxs("form", { className: "flex flex-col gap-4", onSubmit: (event) => void handleSubmit(event), children: [_jsxs("div", { className: "flex flex-col gap-2 text-left", children: [_jsx("label", { className: "text-sm font-medium leading-5 text-foreground", htmlFor: issuerId, children: "Solid issuer" }), _jsx(Input, { id: issuerId, value: issuer, disabled: pending, "aria-describedby": describedBy, placeholder: "https://solidcommunity.net", onChange: (event) => setIssuer(event.currentTarget.value) })] }), visibleError ? (_jsx("p", { id: errorId, className: "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-5 text-destructive", role: "alert", children: visibleError })) : null, _jsx(Button, { type: "submit", className: "w-full", disabled: !normalizedIssuer || pending, children: pending ? '登录中...' : '登录' })] })] }) }));
}
export function AuthBoundary({ state, login, children, loginView, }) {
    if (state.status === 'authenticated') {
        return _jsx(_Fragment, { children: children });
    }
    if (state.status === 'loading') {
        return (_jsx(AuthSurface, { children: _jsxs("div", { className: "flex flex-col items-center gap-3 text-center text-sm leading-6 text-muted-foreground", role: "status", "aria-label": "\u8BA4\u8BC1\u72B6\u6001", children: [_jsx("span", { className: "h-8 w-8 rounded-full border-2 border-border border-t-primary", "aria-hidden": "true" }), _jsx("span", { children: "\u6B63\u5728\u68C0\u67E5\u767B\u5F55\u72B6\u6001" })] }) }));
    }
    return (_jsx(LoginView, { title: loginView?.title ?? defaultLoginTitle, description: loginView?.description, defaultIssuer: loginView?.defaultIssuer, logo: loginView?.logo, error: state.status === 'error' ? state.message : undefined, onLogin: login }));
}
