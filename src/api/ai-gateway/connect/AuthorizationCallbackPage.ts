import { createHash } from 'node:crypto';

export type AuthorizationCallbackPageState = 'received' | 'invalid' | 'denied' | 'failed';

const COPY: Record<AuthorizationCallbackPageState, { title: string; description: string }> = {
  received: {
    title: '授权结果已送达 Xpod',
    description: '切回应用继续完成连接。连接进度会在 Xpod 中显示。',
  },
  invalid: {
    title: '授权链接已失效',
    description: '此授权链接无效或已过期。请返回 Xpod，重新发起连接。',
  },
  denied: {
    title: '授权未完成',
    description: '本次授权没有完成。请返回 Xpod，检查连接状态后重试。',
  },
  failed: {
    title: '暂时无法接收授权',
    description: 'Xpod 未能接收本次授权结果。请返回应用，重新发起连接。',
  },
};

// The standalone loopback listener cannot depend on the user's gateway or
// load external resources. Tokens match packages/shared-ui/src/theme.css.
const STYLE = `
:root{color-scheme:light dark;--canvas:#F7F4ED;--text:#2B2621;--muted:#655D53;--action:#563E84;--on-action:#F7F4ED;--hover:#4B3672;--pressed:#402E61}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;background:var(--canvas);color:var(--text);font-family:'PingFang SC','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC','Helvetica Neue',Arial,sans-serif}
.page{min-height:100vh;min-height:100dvh;display:grid;grid-template-rows:auto 1fr auto;max-width:1120px;margin:auto;padding:36px 48px 28px}
.brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;letter-spacing:-.6px;line-height:1.2}
.brand svg{width:28px;height:28px;flex:none}
main{align-self:center;width:100%;max-width:560px;margin:64px auto 96px}
h1{font-size:36px;font-weight:600;line-height:1.4;letter-spacing:-1px;margin:0 0 20px;text-wrap:balance}
.description{font-size:17px;line-height:1.9;color:var(--muted);max-width:30em;margin:0 0 36px}
.return{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 24px;background:var(--action);color:var(--on-action);border:1px solid transparent;border-radius:8px;font-size:16px;font-weight:600;line-height:1.4;text-decoration:none;white-space:nowrap}
.return:hover{background:var(--hover)}
.return:active{background:var(--pressed);transform:translateY(1px)}
.return:focus-visible{outline:3px solid var(--action);outline-offset:5px}
footer{font-size:13px;line-height:1.8;color:var(--muted)}
@media(prefers-color-scheme:dark){:root{--canvas:#211D19;--text:#F7F4ED;--muted:#C7BEB2;--action:#B7ABC3;--on-action:#211D19;--hover:#C7BDD0;--pressed:#A79ABA}}
@media(max-width:600px){.page{padding:28px 24px 24px}.brand{font-size:20px}main{margin:56px auto 72px}h1{font-size:28px;letter-spacing:-.6px}.description{font-size:16px;margin-bottom:28px}.return{width:100%}}
@media(forced-colors:active){.return{border-color:ButtonText}}
`;

const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
export const AUTHORIZATION_CALLBACK_PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

/** Static source brand asset from ui/public/brand/xpod-app-24.svg. */
const XPOD_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="1" y="1" width="22" height="22" rx="5" fill="#563E84"/><g fill="#F7F4ED"><path d="M7 5H12V11H18V19H7Z"/><path d="M14 5L19 9H14Z"/></g></svg>';

/** Never pass provider values into this document; only a fixed status is accepted. */
export function renderAuthorizationCallbackPage(state: AuthorizationCallbackPageState): string {
  const { title, description } = COPY[state];
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${title} · Xpod</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header class="brand">${XPOD_MARK}<span>Xpod</span></header>
<main aria-labelledby="callback-title">
<h1 id="callback-title">${title}</h1>
<p class="description">${description}</p>
<a class="return" href="xpod://ai-connections">返回 Xpod</a>
</main>
<footer>你可以关闭此页面，并在 Xpod 中继续操作。</footer>
</div>
</body>
</html>`;
}
