# Pod 接口密钥（Pod Interface Key）

> 状态：现行机制。取代已删除的 `/.internal/pod-data` 内部通道与服务身份（service identity）。
> 相关：[`multi-channel-access.md`](multi-channel-access.md)、[`ai-connections-storage-model.md`](ai-connections-storage-model.md)、
> [`superpowers/specs/2026-08-09-caller-owned-ai-connections-access-design.md`](superpowers/specs/2026-08-09-caller-owned-ai-connections-access-design.md)

## 1. 一句话

服务端组件访问用户 Pod，一律走 **Pod 自己的标准 Solid 接口**，凭据就是 **用户自己的接口访问密钥**（CSS client credentials，浏览器里包装成 `sk-base64(client_id:client_secret)`）。
不存在"因为请求来自 loopback / 带了内部签名，所以 Solid 服务器必须放行"的路径。

## 2. 曾经的内部通道，以及为什么删掉

旧实现：API sidecar 把请求发到 CSS 的 `/.internal/pod-data`，带上 runtime HMAC 签名（owner、method、资源 URL、principal、scope、时间戳、nonce），
由 `InternalPodDataHttpHandler` 校验后**绕过调用方凭据**直接落到 `ResourceStore`。

它的问题不是"实现有 bug"，而是**授权模型错了**：

- 它把授权建立在**调用方的位置**（loopback）和一个**部署级共享密钥**上，而不是 Pod 自己的授权判断；
- API sidecar 可以为任意 owner 读写任意被 allowlist 覆盖的 Pod 文档，Pod 侧无从审计"这是谁授权的"；
- 它与已经确定的 "caller-owned access" 方向相反（该设计明确拒绝部署级服务身份与全局密钥）。

因此该路由、handler、配置挂载、`handleTrustedInternalSelect/Update` 一起删除：路由不存在，就不需要再证明"没有签名打不进来"。

## 3. 现在的凭据来源

`src/api/ai-gateway/pod/OwnerPodAccess.ts` 实现 `PodAccessFetchProvider`：

```ts
const podFetch = await podAccess.getPodFetch(owner, { auth, podBaseUrl });
if (!podFetch) throw new Error(podAccessError(owner, auth));
```

三种凭据来源，**都是 owner 自己的接口密钥**，按优先级：

| # | 来源 | 何时使用 | 实现 |
|---|------|----------|------|
| 1 | 调用方带来的接口密钥 | 请求由 `sk-*` 包装器认证（`viaApiKey` + `clientId`/`clientSecret`） | 用本进程自己生成的 DPoP 密钥重新换取 token |
| 2 | 调用方持有的可复用 token | 调用方已持有 Bearer token（`viaApiKey` + `tokenType: 'Bearer'`） | 直接作为 `Authorization: Bearer` 转发 |
| 3 | owner 授权给本部署的接口密钥 | 后台/无会话路径（配额刷新、模型选择、FTS/VEC 重建、遗留网关 Key 校验） | 从 vault 解封后交换 token |

浏览器 DPoP 会话本身**不能**被转发：它的 proof 绑定在生成它的那个 URL 上，且私钥在浏览器里。这正是需要第 3 种来源的原因。

任一来源都遵守两条不变量：

1. **请求打到 Pod 自己的 URL 上**：本地模式下通过 `HostedPodRoute` 把请求目标换成 loopback Gateway
   （`x-xpod-canonical-*` 头保持 canonical 身份），DPoP proof 仍然按 **canonical URL** 生成；
2. **授权由 Pod 决定**：API 侧不再做资源 allowlist 绕过——owner 本来就有自己 Pod 的完整权限，Pod 的 WAC/ACP 判断就是最终判断。

## 4. 密钥的发放与保存

- **发放点在浏览器**：账户侧创建 CSS client credential（账号应用的标准能力），包装成 `sk-*`。这就是产品里的 "API Key"，浏览器用它访问 `/v1`，服务端用同一把钥匙访问 Pod —— 一把钥匙，两个消费者。
- **服务端留存点在注册时**：`POST /api/ai/gateway/keys` 校验 wrapper（CSS token endpoint 换取 token，WebID 必须等于调用方 owner）之后，
  在写入 Key 记录**之前**调用 `podInterfaceKeys.saveKey(owner, { clientId, clientSecret })`。
  顺序是硬要求：写入第一条记录本身就需要这把钥匙。
- **存储位置**：`identity_pod_interface_key` 表（`owner_web_id` 主键、`client_id`、`sealed_secret`），密文由 `CredentialVault` 封存（`credentialIri = urn:xpod:pod-interface-key`，`provider = solid`）。
  密钥不进 Pod：它是打开 Pod 的东西。也不进环境变量。
- **吊销**：账号侧撤销 CSS client credential 即可；交换失败会以 `pod_interface_key_rejected` 暴露出来。删除网关 Key 记录只删配置，不代表撤销凭据。

## 5. 失败语义

| stable code | 含义 | 用户该做什么 |
|-------------|------|--------------|
| `caller_pod_access_unavailable` | 请求没有可用身份（无 auth / 非 Solid 身份） | 先登录 |
| `caller_owner_mismatch` | 凭据 WebID 与被请求的 Pod owner 不一致 | 用 Pod 所属账号操作 |
| `caller_dpop_replay_unsupported` | 只持有浏览器 DPoP 会话，服务端无法为另一个 URL 重放该 proof | 授予接口密钥 |
| `pod_interface_key_missing` | 该 owner 名下没有可用接口密钥 | 在账号侧创建 API Key 并应用 |
| `pod_interface_key_rejected` | 已保存的密钥被 Pod 拒绝（撤销/过期/错配） | 重新创建并应用 API Key |

对外 wire 码保持 `service_access_missing`（HTTP 403，见 `src/api/ai-gateway/errors.ts` 与网关错误映射）：调用方看到的稳定错误没有变化，
新增的 reason 只用于让 UI 说出"该做什么"。

## 6. 实现注意：route 在服务构建时解析

API 侧访问 Pod 的 route（canonical → loopback Gateway）必须在 runtime 构建服务时算好，不能在请求时读环境变量：
runtime 在服务启动完成后会 `environment.restore()`，把 `XPOD_MAIN_PORT` / `CSS_BASE_URL` 等恢复掉，请求时再读会拿到空值，
于是请求打到 canonical URL（例如 `https://<node>.nodes.undefineds.co/...`），在"本机就是节点"的场景下连接失败。

同理，route 的本地地址必须使用 Gateway **实际绑定**的地址（`API_HOST` → `localServiceUrl`），不能硬编码 `127.0.0.1`：
绑定到 `localhost` 时可能只监听 IPv6。两处都属于"地址只在已知处解析一次"的同一类问题。

## 7. 边界

- **不改变** Pod 的 canonical URL 与 RDF 身份；路由只替换请求目标（见 `multi-channel-access.md`）。
- **不引入** 部署级共享服务身份；`XPOD_GATEWAY_INTERNAL_CLIENT_ID/SECRET` 之类的全局密钥不再是任何路径的回退。
- **不做** owner 维度以外的越权：`getPodFetch` 对 `auth.webId !== owner` 一律返回 `undefined`，不会退回到 owner 自己的密钥。
- 仍属特权的运维面（`/service/logs`、`/service/restart/*`、`/service/stop`）继续按 operator 授权判断，与 Pod 数据通道无关。

## 8. 验收

- 单元：`tests/api/ai-gateway/OwnerPodAccess.test.ts`（三种来源、缓存、401 重换、canonical `htu`）、
  `tests/api/ai-gateway/PodInterfaceKeyStore.test.ts`（封存/读取/轮换/撤销/损坏信封）、
  `tests/api/ai-gateway/HostedPodRoute.test.ts`（route 解析与绑定地址）。
- 集成（真实 Xpod 栈、真实 CSS、真实 DPoP）：`tests/integration/localQleverCredentialRepository.test.ts`、
  `tests/integration/chatkit-pod-store.integration.test.ts`（vault 中的接口密钥 → 标准接口读写）、
  `tests/integration/AiGatewayPodIsolation.integration.test.ts`（owner 隔离）。
- 路由不存在：`tests/runtime/service-endpoint-gate.test.ts`、`tests/gateway/proxy-headers.test.ts`（`/.internal/pod-data` 不再提供任何 Pod 数据）。
- 真实实例（浏览器 + 真实 Cloud 账号 + Local Pod）：`bun run smoke:tunnel:ngrok:inrupt -- --local-only` 的
  `pod-interface-key-granted` 阶段断言 `before=unsupported/not_configured` → `registration=201` → `after=available` → `listed>=1`，
  并确认 `/.internal/pod-data` 不返回 Pod 数据。
