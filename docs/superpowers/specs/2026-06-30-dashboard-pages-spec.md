# Xpod Dashboard Pages Spec

- Status: Active spec
- Date: 2026-06-30
- Scope: `/dashboard/status`, `/dashboard/logs`, `/dashboard/settings`
- Source of truth: `DESIGN.md` plus this spec

## Product positioning

The dashboard is a local Xpod runtime console. It is not the primary product configuration center.

Primary posture:

1. Status and diagnostics first.
2. Settings are an advanced fallback.
3. LinX remains the preferred configuration UX for normal users.
4. Xpod console can expose safe, allowlisted runtime controls only.

The three pages are organized as:

```text
/dashboard
  ├─ status    primary entry, decide whether Xpod is usable and where to access data
  ├─ logs      diagnostic evidence and sanitized export
  └─ settings  advanced fallback for local runtime configuration
```

## Shared shell

Desktop:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  ● 运行中   CSS: 正常   API: 正常   检查: 10:08        [重启] [打开 Pod]      │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ Xpod          │                                                              │
│               │  page content                                                │
│  ▌ 状态        │                                                              │
│    日志        │                                                              │
│    设置        │                                                              │
│               │                                                              │
│ Xpod Runtime  │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Mobile:

```text
┌────────────────────────────────────┐
│ ●                         [重启] [↗] │
├────────────────────────────────────┤
│ page content                        │
├────────────────────────────────────┤
│  状态          日志          设置    │
└────────────────────────────────────┘
```

Rules:

- Desktop uses left sidebar navigation.
- Mobile uses bottom navigation.
- Top status bar exposes runtime health and operational actions.
- Runtime settings must not be mounted under `/.account/*`.

## Status page

### Job

The status page answers three questions in order:

1. Is Xpod usable right now?
2. What is the stable data entry URL?
3. If access fails, what path or configuration should the user inspect next?

### Layout decision

Do not use tabs. Do not force the entire page to fit exactly one viewport.

Use:

```text
first screen: decision
second screen: evidence
last section: diagnostic background
```

Reason:

- Tabs hide the evidence behind a second action.
- A forced one-page layout breaks across different screen heights.
- The correct target is first-screen decision, scroll-for-evidence.

### Desktop layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 状态                                      [刷新] [复制状态 JSON] [打开入口]    │
│ 查看 Xpod 是否可用，以及当前应该从哪里访问资料。                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ [决策卡]                                                                      │
│                                                                              │
│ 可用 / 降级 / 失败                                                            │
│ 稳定资料入口: https://node-0000.undefineds.co/                                │
│ 当前建议路径: User tunnel / Public / LAN / Loopback                           │
│ 最后检查: 10:08:42                                                            │
│                                                        [复制 URL] [打开入口]  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [需要处理] 仅异常时出现                                                        │
│ 当前稳定入口不可达。公网失败，但用户隧道可用。                 [查看日志]      │
├──────────────────────────────────────────────────────────────────────────────┤
│ [访问路径] 主证据                                                              │
│ ┌──────────┬──────────┬──────────┬─────────────┬──────────┐                  │
│ │ Loopback │ LAN      │ Public   │ User tunnel │ P2P      │                  │
│ │ 可用     │ 可用     │ 失败      │ 可用         │ 未知      │                  │
│ │ 本机访问  │ 局域网    │ 稳定域名  │ ngrok        │ 原生备用  │                  │
│ └──────────┴──────────┴──────────┴─────────────┴──────────┘                  │
│                                                                              │
│ 完整路径详情                                                                  │
│ ┌─────────────┬────────────────────────────────────┬────────┬─────────────┐ │
│ │ Loopback    │ http://127.0.0.1:3000               │ 可用    │ 本机访问可用 │ │
│ │ LAN         │ http://192.168.x.x:3000             │ 可用    │ 局域网地址   │ │
│ │ Public      │ https://node-0000.undefineds.co/    │ 失败    │ 公网探测失败 │ │
│ │ User tunnel │ https://xxx.ngrok-free.dev          │ 可用    │ ngrok        │ │
│ │ P2P backup  │ 信令协调的原生客户端                 │ 未知    │ 备用路径     │ │
│ └─────────────┴────────────────────────────────────┴────────┴─────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Cloud 协调]                                                                  │
│ nodeId: node-0000                                                             │
│ spDomain: node-0000.undefineds.co                                             │
│ DDNS: 已分配                                                                  │
│ heartbeat: 30 秒前                                                            │
│ 模式: tunnel                                                                  │
│ 说明: Cloud 负责稳定域名和 IDP，本地 SP 负责数据存储与实际接入。               │
├──────────────────────────────────────────────────────────────────────────────┤
│ [配置摘要] 诊断附录                                                            │
│ edition local  |  storage ./data  |  provider ngrok  |  secrets 2 configured │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Status page rules

- The decision card owns the stable data entry URL.
- The stable data entry URL should not be buried in config summary.
- Access paths are evidence, not primary navigation.
- Cloud coordination gets its own section because it explains stable domain, DDNS, heartbeat, and node identity.
- Config summary is lower-priority diagnostic background and should be visually lighter than Cloud coordination.
- No tab split for overview/access/cloud/config.
- Optional page anchors are acceptable only if they do not hide content.

### Stable URL rules

Managed local mode:

```text
ddns.baseUrl
  -> https://{ddns.fqdn}/
  -> CSS_BASE_URL
  -> current origin fallback
```

Standalone mode:

```text
CSS_BASE_URL
  -> ddns.baseUrl
  -> https://{ddns.fqdn}/
  -> current origin fallback
```

The public reachability check must use the resolved stable URL. It must not blindly use `CSS_BASE_URL`.

### Recommended path rules

Recommended path is the best usable data path at the time of check.

Priority when healthy:

```text
Public stable URL
  -> User tunnel
  -> LAN
  -> Loopback
```

Native clients may use direct/P2P optimizations when available, but browser-facing UI should keep the stable data URL as the user-visible entry.

### Empty and loading states

- Before service status is loaded, access path rows are `unknown`, not failed.
- Missing DDNS or heartbeat shows `unknown` with explicit reason.
- A failing status API keeps last-known state if available and marks it stale.

## Logs page

### Job

The logs page is for inspection and support handoff, not monitoring dashboards.

### Desktop layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 日志                                             [暂停] [导出日志] [清空视图] │
│ 实时检查运行时输出，并导出不包含 secret 的诊断证据。                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ [诊断导出]                                                   [导出诊断]       │
│ 导出可交给开发者的脱敏运行时证据，默认不包含用户 Pod 内容。                    │
│                                                                              │
│ 包含: /service/status、隧道、DDNS、配置摘要、最近错误、日志尾部                 │
│ 排除: Token、API key、数据库密码、cookie、client secret、用户 Pod 内容          │
│                                                        日志文件: logs/xpod.log │
├───────────────┬───────────────┬───────────────────────────────┬──────────────┤
│ 全部模块       │ 全部等级       │ 按关键词过滤                   │ ☑ 自动滚动    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [已识别问题提示]                                                              │
│ ERR_NGROK_8001: ngrok agent 无法连接 ngrok edge，通常是本机网络或代理限制。    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [日志视窗]                                                                    │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ 10:08:31  [INFO]  [xpod]    runtime started with managed base url         │ │
│ │ 10:08:31  [WARN]  [tunnel]  ERR_NGROK_8001 sample diagnostic hint         │ │
│ │                                                                          │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Logs page rules

- Keep diagnostics export at the top.
- Keep filters compact.
- The log viewport should own most vertical space.
- Do not add a secondary right sidebar.
- Known error hints should be visible between filters and logs.
- Log rows stay monospace.
- Long log lines may overflow horizontally.
- Cap in-memory log rows.

### Diagnostics export

Include:

- `/service/status` summary
- admin status summary
- access routes
- tunnel status
- DDNS, heartbeat, provision state
- sanitized config summary
- recent errors and log tail
- version/build/runtime info

Exclude:

- tokens
- API keys
- database passwords
- auth cookies
- client secrets
- user Pod content
- ngrok/cloudflare/frp credentials

MVP export format: JSON.

ZIP export can be added later only if support workflow needs multiple files.

## Settings page

### Job

Settings are an advanced fallback for local runtime configuration.

Do not make this page the primary configuration product.

### Desktop layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 设置                                                                  │
│ 高级运行时设置。大多数用户应在 LinX 中完成配置。                       │
├──────────────────────────────────────────────────────────────────────┤
│ ⚠ 高级运行时设置                                                       │
│ 这里修改的是本地 Xpod 运行时，不是用户 Pod 资料，也不是 Cloud IDP 账号。│
├──────────────────────────────────────────────────────────────────────┤
│ [运行时]                                                              │
│                                                                      │
│ 部署模式                         存储目录                             │
│ ┌──────────────┐                 ┌────────────────────────────────┐  │
│ │ 边缘部署      │                 │ ./data                          │  │
│ └──────────────┘                 └────────────────────────────────┘  │
│                                                                      │
│ 资料入口 URL                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ https://node-0000.undefineds.co/                                  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ 托管模式下由 Cloud 分配稳定域名，本地只上报状态和隧道入口。            │
├──────────────────────────────────────────────────────────────────────┤
│ [网络访问]                                           外网: 可直连      │
│                                                                      │
│ 隧道供应商                                                            │
│ ┌──────────────────────────────┐                                     │
│ │ ngrok                    ▼    │                                     │
│ └──────────────────────────────┘                                     │
│ 同一时间只启用一个隧道。状态页会根据本机、局域网、公网、隧道判断接入。 │
│                                                                      │
│ 隧道入口 URL                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ https://xxx.ngrok-free.dev                                        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ 访问密钥                                             [已配置]         │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ 填写新 secret                                                     │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ [高级参数] 折叠                                                       │
├──────────────────────────────────────────────────────────────────────┤
│ [Cloud 协调]                                                          │
│ Cloud API endpoint / nodeId / spDomain / Node token / Service token   │
├──────────────────────────────────────────────────────────────────────┤
│ [展开高级设置]                                                        │
├──────────────────────────────────────────────────────────────────────┤
│ [待应用变更]                                           [重置未保存]    │
│ 没有未保存的变更。                                                     │
├──────────────────────────────────────────────────────────────────────┤
│ [保存配置] [保存并重启]                                                │
└──────────────────────────────────────────────────────────────────────┘
```

### Network access abstraction

Main fields are unified across providers:

```text
provider
publicEndpointUrl
credential
```

User-facing labels:

```text
隧道供应商
隧道入口 URL
访问密钥
```

Do not call the second field simply `域名`; some providers use full URLs and some tokens may imply a host configured elsewhere.

### Provider-specific labels

```text
none
  shows no endpoint or credential fields
  shows explanation that no user tunnel is enabled

ngrok
  publicEndpointUrl label: ngrok 固定入口 URL
  credential label: ngrok authtoken

cloudflare
  publicEndpointUrl label: Cloudflare Tunnel 公开入口
  credential label: Cloudflare Tunnel Token

frp
  publicEndpointUrl label: FRP 公开入口 URL
  credential label: FRP Token

sakura_frp
  publicEndpointUrl label: Sakura FRP 公开入口 URL
  credential label: Sakura FRP Token
```

### Provider form rules

- Use one provider selector.
- Show only the current provider's fields.
- Never show all provider forms at once.
- Validate only the current provider's required fields.
- Switching provider does not need to delete previous provider config immediately.
- Saving activates only the selected provider through `XPOD_TUNNEL_PROVIDER`.
- `none` is an explicit state.
- If `DDNS mode = tunnel` and provider is `none`, show the red warning.
- If provider is not `none`, do not show “please enable a tunnel” warning.
- Advanced provider parameters stay hidden behind a provider-specific advanced fold.

### Stable URL versus tunnel URL

Keep these concepts visually and semantically separate:

```text
稳定资料 URL
  https://node-0000.undefineds.co/alice/

隧道入口 URL
  https://xxx.ngrok-free.dev
```

Stable data URL:

- User-facing data path.
- Used by browser apps and Inrupt SDK expectations.
- Owned by Cloud allocation in managed local mode.

Tunnel entry URL:

- Actual data-plane ingress for reaching local SP under current network constraints.
- User-provided or heartbeat-reported.
- Does not replace the stable data URL in UI copy.

### Settings rules

- Managed local mode makes the stable data URL read-only.
- Standalone mode may allow editing the base URL.
- Secrets are write-only.
- Secret state displays only `已配置` or `未配置`.
- No arbitrary env editor by default.
- Only allowlisted runtime keys can be saved.
- Save must say whether restart is required.
- Save and Restart is allowed only through guarded admin APIs.

## Mobile behavior

Status mobile:

```text
┌────────────────────────────────────┐
│ ●                         [重启] [↗] │
├────────────────────────────────────┤
│ 状态                                │
│ 查看 Xpod 是否可用...               │
│ [刷新] [复制状态 JSON]              │
│ [打开入口]                          │
├────────────────────────────────────┤
│ [决策卡]                            │
│ 可用                                │
│ 稳定资料入口                         │
│ 当前建议路径                         │
├────────────────────────────────────┤
│ [访问路径] 横向滚动或紧凑卡片         │
├────────────────────────────────────┤
│ [Cloud 协调]                        │
├────────────────────────────────────┤
│ [配置摘要]                          │
├────────────────────────────────────┤
│  状态          日志          设置    │
└────────────────────────────────────┘
```

Rules:

- Mobile keeps page switching usable through bottom nav.
- Status decision remains above the fold when possible.
- Tables may scroll horizontally if full row evidence is clearer than stacking.
- Critical actions must remain at least 40px hit target.

## Visual and content rules

- Use flat taro/lavender primary accent.
- Do not use gradients for dashboard chrome, buttons, cards, or status accents.
- Use status colors only for status semantics.
- Labels sit above inputs.
- Placeholders are hints, not labels.
- Buttons must be one-line on desktop.
- Buttons should have tactile pressed feedback.
- Visible admin copy must not use em dash or en dash characters.
- Chinese copy is preferred for the admin console when surrounding UI is Chinese.

## Acceptance criteria

### Status page

- Shows stable data entry URL in the decision area.
- Shows recommended path.
- Does not use tabs for overview/access/cloud/config.
- Shows access path summary and full route evidence.
- Cloud coordination is its own section.
- Config summary is visually lower priority than Cloud coordination.
- Managed local uses DDNS/stable URL before loopback URL.
- Unknown loading state does not render as failed.

### Logs page

- Diagnostics export is available at top.
- Filters include source, level, keyword, and auto-scroll.
- Known tunnel/network errors produce actionable hints.
- Log viewport has most of the vertical area.
- Diagnostics export is sanitized.
- MVP export is JSON.

### Settings page

- Network access uses a single provider selector.
- Only the selected provider's fields are visible.
- Main provider fields are provider, tunnel entry URL, and credential.
- Stable data URL and tunnel entry URL are visually distinct.
- Managed local stable data URL is read-only.
- Secrets are write-only and redacted.
- Only allowlisted runtime keys are saved.
- Provider `none` is explicit.
- DDNS tunnel warning appears only when provider is `none`.

### Tests and smoke checks

- Source tests assert route structure, mobile navigation, flat taro palette, and no high-saturation purple defaults.
- Source tests assert no em/en dash in visible admin copy.
- API tests assert config sanitization and mutation guard.
- Browser smoke captures status, logs, settings, and mobile status after rebuilding dashboard.

## Deferred decisions

- Diagnostics export remains JSON for MVP. ZIP can be added if support needs multi-file bundles.
- Dark mode follows existing theme behavior. A manual toggle is not part of this spec.
- Long-term ownership of advanced settings may move further into LinX, leaving Xpod console more read-only.
