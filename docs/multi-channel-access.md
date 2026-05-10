# 多渠道访问设计

## 目标

用户无论在**本机**、**局域网**还是**外网**访问 Xpod，都应看到同一个 SP 地址和同一个 WebID。网络条件变化只切换访问渠道，不改变 Solid 语义身份。

核心约束：

- **SP canonical URI 不变**：WebID、Pod Root、ACL、OIDC resource audience 都以 canonical URL 为准。
- **访问渠道可变**：本机、局域网、公网直连、隧道只是不同 access route。
- **不要求用户改路由器 DNS**：桌面 App / CLI 可自动选择 route；普通浏览器能力降级。
- **不分叉身份和权限**：不能为本机、局域网、外网生成三套 WebID 或权限。
- **Local 首次启动不依赖公网**：没有公网和隧道时，本机和局域网仍可完成验证和使用。

---

## 核心模型：canonical URL + access route

```text
Solid 层看到的资源地址:
  https://node-0000.undefineds.co/

客户端实际选择的 access route:
  ┌──────────────────────────────────────────────┐
  │ same-device  -> http://127.0.0.1:5737        │
  │ lan          -> http://192.168.1.100:5737    │
  │ public       -> https://node-0000.undefineds.co
  │ tunnel       -> https://user-tunnel.example  │
  └──────────────────────────────────────────────┘
```

`canonicalUrl` 是产品和 Solid 语义里的稳定 SP 地址。`accessRoute` 是客户端或本地网关为了连通性选择的物理通道。

不能把这个方案描述成“HTTPS DNS 劫持后直接连 HTTP”。如果 URL 是 `https://node-0000.undefineds.co/`，单纯把 DNS 解析到 `127.0.0.1` 后，目标服务仍必须满足 HTTPS、证书和 SNI 约束。Local HTTP route 必须通过 App 内 fetch adapter / 本地网关 / 受控代理来承接，不能假装普通浏览器也能透明工作。

---

## 部署形态

| 形态 | IDP | SP | canonical URL | access route | 用户感知 |
|------|-----|----|---------------|--------------|----------|
| Cloud 全套 | Cloud | Cloud | 平台分配域名 | 公网 | 自动生成 SP 域名 |
| Cloud IDP + Local SP，公网可直连 | Cloud | Local | 平台分配域名 | 公网直连、本机、局域网 | 自动生成 SP 域名 |
| Cloud IDP + Local SP，公网不可直连 | Cloud | Local | 平台分配域名或用户域名 | 本机、局域网、隧道 | 无隧道也可本地用；外网需要隧道 |
| Standalone 全本地 | Local | Local | 本地 canonical URL | 本机、局域网 | 不承诺公网身份 |

说明：

- `Cloud IDP + Local SP` 不应把局域网 IP 当 canonical URL。局域网 IP 只能作为 access route，否则 WebID 会绑定到不稳定地址，后续加公网或隧道就需要迁移。
- 如果平台能控制域名和隧道入口，优先从创建时分配 `node-xxxx.undefineds.co` 作为 canonical URL。
- 如果用户使用平台不可控的第三方隧道域名，且必须让普通浏览器通过该域名访问，则该用户域名应在创建 Pod 前确定为 canonical URL。已创建后再切换 canonical URL 属于 WebID 迁移，不是 route 切换。

---

## Route 表

客户端维护 route 表，而不是改 Solid URI。

```json
{
  "canonicalUrl": "https://node-0000.undefineds.co/",
  "routes": [
    {
      "id": "same-device",
      "scope": "same-device",
      "targetUrl": "http://127.0.0.1:5737",
      "priority": 10,
      "requiresManagedClient": true
    },
    {
      "id": "lan",
      "scope": "lan",
      "targetUrl": "http://192.168.1.100:5737",
      "priority": 20,
      "requiresManagedClient": true
    },
    {
      "id": "public",
      "scope": "public",
      "targetUrl": "https://node-0000.undefineds.co",
      "priority": 50,
      "requiresManagedClient": false
    }
  ]
}
```

字段含义：

- `canonicalUrl`：Solid SDK、WebID、ACL、OIDC resource audience 使用的稳定 URL。
- `targetUrl`：客户端实际连接的 URL。
- `scope`：route 的可用范围，避免把 `127.0.0.1` 暴露成所有客户端都可用的 endpoint。
- `requiresManagedClient`：表示普通浏览器不能直接使用，需要 LinX Desktop / CLI / App 网关参与。

当 `targetUrl` 与 `canonicalUrl` host 不一致时，客户端或网关必须保留 canonical 语义：对上层 SDK 暴露 canonical URL，对下游 Xpod 传递 canonical host / resource origin。不能让业务层认为资源换了域名。

---

## Route 来源

Local 首次启动不能依赖公网 discovery，因此 route 来源分层处理。

| 来源 | 内容 | 适用场景 |
|------|------|----------|
| 本地配置 | `canonicalUrl`、loopback route、LAN route、tunnel token | Local SP 启动时写入 |
| Local 服务 API | 当前监听端口、LAN IP、健康状态 | Desktop / CLI 同机发现 |
| Cloud 控制面 | 分配的 canonical 域名、公网直连状态、平台隧道状态 | Cloud IDP + Local SP |
| Public discovery | 仅发布 public route | 已有公网或隧道时 |

不建议把 `127.0.0.1` 和 LAN IP 无条件写进 public `/.well-known/solid`。这些地址对远端客户端没有意义，还可能造成误连。若需要发布 route 信息，应使用 Xpod 自有 discovery，例如 `/.well-known/xpod-routes`，并按客户端位置、认证状态和 node proof 过滤。

---

## Local 隧道职责

`cloudflared` 属于 Local SP 运行时进程，由 xpod local 在启动时根据本地配置拉起，不由 LinX Web、Cloud IDP 或用户手工启动链路承担。

职责边界：

- xpod local runtime：读取 `CLOUDFLARE_TUNNEL_TOKEN` / 其他 provider token，启动和停止本机隧道客户端。
- tunnel provider：只负责本机隧道进程，例如 `cloudflared tunnel run --token ... --url http://localhost:5737`。
- LocalNetworkManager：只做公网直连检测和 DNS/DDNS 同步；没有公网时保持本机/局域网 route 可用，不隐式启停隧道。
- DdnsManager / Cloud 控制面：维护 canonical 域名对应的 public route 状态，例如直连 IP、平台隧道或用户隧道。
- LinX Desktop / CLI：触发 Local 启动、读取 route 表、选择 access route，不直接管理 `cloudflared` 进程。

因此，有 tunnel token 时，xpod local 应在启动阶段确定性拉起隧道。没有 tunnel token 时，Local 仍必须能通过 same-device / LAN route 登录和读写；只是 public route 不可用。

---

## 客户端选择逻辑

主流程不等待探测。客户端先用可用 route 启动，再后台优化。

```ts
type AccessRoute = {
  id: string;
  scope: 'same-device' | 'lan' | 'public';
  targetUrl: string;
  priority: number;
  requiresManagedClient: boolean;
};

async function chooseRoute(routes: AccessRoute[]): Promise<AccessRoute | null> {
  const candidates = routes
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const probes = candidates.map(async route => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(`${route.targetUrl}/.well-known/solid`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      if (res.ok || res.status === 401) return route;
      throw new Error(`Route ${route.id} returned ${res.status}`);
    } finally {
      clearTimeout(timeout);
    }
  });

  try {
    return await Promise.any(probes);
  } catch {
    return null;
  }
}
```

要求：

- 使用 `Promise.any` 或带总超时的 race，避免全部失败时永久 pending。
- route 探测失败只影响优化，不阻塞登录页面和本地服务启动。
- route 切换不触发 WebID 改写。只有 canonical URL 变化才需要重新登录或迁移。

---

## 平台能力边界

| 平台 | 可做 | 不承诺 |
|------|------|--------|
| LinX Desktop / Electron | 通过主进程、本地服务或 fetch adapter 选择 route | 不承诺 Chromium 原生 fetch 对 HTTPS->HTTP 透明改写 |
| Agent CLI / Node.js | 可包装 fetch / undici dispatcher / 本地代理 | 不假设所有依赖都会自动吃到全局 dispatcher |
| 桌面 Web 浏览器 | 使用 public route；可选 `/etc/hosts` 辅助本机调试 | 不做局域网透明加速 |
| 移动 App | 可在 native 网络层选择 route | 不要求移动 Web 支持 |
| 普通移动 Web | 使用 public route | 不支持本机 agent 场景 |

Inrupt / Solid SDK 不需要修改源码，但调用侧可以传入受控 `fetch` 或让 SDK 请求经过本地网关。这里的“不改 SDK”不是“不允许我们在 App 边界做 fetch 适配”。

---

## OIDC 与权限

route 切换不应该改变 OIDC resource audience。

- access token 面向 canonical resource origin。
- 本机 / 局域网 / 隧道只是 transport route，不生成新的 resource identity。
- 如果 route 需要通过不同 TLS host 连接，例如用户隧道域名，网关必须把请求映射回 canonical resource，并让 Xpod 的 identifier / authorization 层按 canonical URL 判定资源。
- `allowedHosts` 只能解决“服务端接受哪些 host 形式”的一部分问题，不能替代 OIDC audience、DPoP、CORS 和 WebID 绑定验证。

静默重授权只在 canonical URL 或 IDP session 确实变化时发生。单纯从 `public` route 切到 `same-device` route 不应重授权。

---

## 推荐流程

```text
Local SP 启动
  │
  ├─ 读取/创建 canonicalUrl
  │    ├─ 平台可分配域名: https://node-xxxx.undefineds.co/
  │    └─ Standalone: 本地 canonical URL
  │
  ├─ 启动本地服务
  │    ├─ loopback route: http://127.0.0.1:5737
  │    └─ lan route: http://192.168.x.x:5737
  │
  ├─ 写入本地 route 表
  │
  ├─ Desktop / CLI 立即可用
  │
  └─ 后台检测公网
       ├─ 可直连: public route 可用，DNS 指向公网地址
       ├─ 不可直连且有平台隧道: public route 指向平台隧道
       └─ 不可直连且无隧道: 保持本机/局域网可用，提示用户配置隧道文档
```

---

## 验收标准

- 创建 Pod 后，WebID 和 Pod Root 在本机、局域网、公网访问时保持一致。
- Cloud IDP + Local SP 在无公网时仍能通过 Desktop / CLI 完成登录和读写。
- 局域网 IP 只出现在 route 表中，不成为 WebID 或 Pod Root。
- 加入隧道后只新增/启用 public route，不迁移 Pod 数据。
- 普通浏览器只承诺访问 public route；无 public route 时显示明确的隧道/域名配置指引。

---

## 明确放弃

| 放弃项 | 理由 |
|--------|------|
| 把 HTTPS canonical URL 直接 DNS 到 HTTP Local 服务 | 违反 TLS/SNI/证书模型 |
| 把 LAN IP 当 canonical URL | IP 不稳定，后续外网化需要迁移 WebID |
| 在 public discovery 中无条件暴露 `127.0.0.1` | 远端无意义且有误连风险 |
| 内嵌 DNS 服务器 | 53 端口权限、杀软误报和跨平台成本过高 |
| 普通浏览器局域网透明加速 | 浏览器无法安全劫持 fetch/DNS/TLS |
| route 切换触发 OIDC audience 改写 | route 不是新的 Solid resource identity |
