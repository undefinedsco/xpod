# Pod Agent 授权（设计草案）

> 状态：**待评审**。目标是把"服务端组件访问用户 Pod"从"借用 owner 的接口密钥"改成"以 agent 身份访问，
> 权限由 owner 在 Pod 里授予"。实现尚未开始。
> 相关：[`pod-interface-key.md`](pod-interface-key.md)（现行机制）、[`multi-channel-access.md`](multi-channel-access.md)、
> [`superpowers/specs/2026-08-09-caller-owned-ai-connections-access-design.md`](superpowers/specs/2026-08-09-caller-owned-ai-connections-access-design.md)

## 1. 结论

服务端组件以 **agent** 身份访问 Pod：

- **身份**（agent WebID）：部署签发的公开标识，自身不带任何权限；
- **认证**（凭据）：每个 agent 一把，只回答"你是不是这个 agent"，可随时轮换；
- **授权**（权限）：**只认 agent 身份**，写在 Pod 自己的 ACP 里（`acp:agent <agentWebId>` + 资源集），
  由 owner 在浏览器里授予、可单独撤销。

一句话：**权限跟着 agent_id 走，不跟着密钥走。**

## 2. 现状的问题（`pod-interface-key.md` 的遗留）

现在的模型是"owner 把接口密钥授予本部署"，于是：

| 症状 | 原因 |
|---|---|
| 没有主语 | 用钥匙的是"这个部署"，Pod 侧看到的是 owner 本人，无法区分是哪个组件 |
| 轮换即权限事件 | 权限长在密钥上，换钥匙、撤销密钥都会改变权限 |
| 没有资源级最小权限 | 一把 owner 级密钥可以读写整个 Pod；额度校验和索引重建权限相同 |
| 审计只能到"某把钥匙被用了" | 授权判断里没有 agent，Pod 的 ACR/日志也反映不出组件 |
| 回退分支没有主语 | `getPodFetch(owner, {auth?})` 里"没有 auth ⇒ 用 owner 授予的密钥"，把"谁在请求"和"用哪份凭据"混在一起 |

`/v1` 与后台路径的具体表现与逐调用点核对见 `docs/pod-interface-key.md` §3、§6。

## 3. 模型：三个关注点分开

| 关注点 | 载体 | 谁决定 | 变更语义 |
|---|---|---|---|
| 身份 | agent WebID（如 `…/agents/xpod-index/profile/card#me`） | 部署（公开可解析） | 新增/下线组件 = 增删一个 agent |
| 认证 | 每个 agent 一把 CSS client credential，`CredentialVault` 封存 | 部署 | 轮换、泄露恢复；**不影响权限** |
| 授权 | owner Pod 内的 ACP：`acp:agent <agentWebId>` + 资源集 + 权限（read / read+write） | owner（浏览器授权） | 撤销 = 删授权块；与凭据无关 |

关键推论：

- **长短期之分消失**：权限不在密钥里，凭据可以很短命、可以随意轮换，Pod 的判断不变；
- **主语恒在**：`getPodFetch(owner, { agent })` 的 agent 必填，没有"没有主语的回退"这一分支；
- **HTTP 层与 Pod 层分工清晰**：HTTP 层回答"这个调用方能不能为 owner O 触发操作 X"（现有中间件/处理器），
  Pod 层回答"组件 A 能不能碰 O 的 Pod 里的资源 R"（ACP）。

## 4. agent 清单与资源集

按**能力模块**划分（不按任务、不按调用点），随程序发布声明，符合 `AGENTS.md` 的"schema 进 models、内容跟能力走"。
资源 IRI 一律取自 `@undefineds.co/models` 与各能力模块的资源声明，本仓库不复制一份路径表。

| agent | 代表资源 | 权限 | 覆盖的调用点 |
|---|---|---|---|
| `xpod-ai-connections` | `credentialResource`、`aiProviderResource`、provider 文档、`gatewayAccessKeyResource`（读） | read + write | `connect/index.ts`、`PodModelSelectionRepository` |
| `xpod-ai-config` | `aiConfigResource` / `xpodAiConfigResource` | read + write | `AiConfigStore` |
| `xpod-gateway-keys` | `gatewayAccessKeyResource` 及其凭证文档 | read + write（校验需要 touch `lastUsedAt`） | `PodGatewayAccessKeyRepository` |
| `xpod-quota` | `quotaSnapshotResource`、`credentialResource`（读） | read + write（快照）/ read（凭证） | `ProviderQuotaAdapter` |
| `xpod-index` | 整个 Pod（重建需要遍历） | read | `routes.ts` FTS/VEC 重建 |
| `xpod-chatkit` | chatkit 容器（thread/message/run/task） | read + write | `chatkit/pod-store.ts` |
| `xpod-matrix` | matrix 存储容器 | read + write | `src/api/matrix/*`（另一位 agent 在做的部分） |
| `xpod-settings-status` | `credentialResource` 计数读取 | read | `PodSettingsHandler` 状态读取 |

粒度取舍：**按组件类、不按任务**。任务级 agent 会让每个用户授权 N 次；组件类让"一次授权一组 Xpod 组件"成为可能，
撤销仍可按 agent 逐项。

## 5. 凭据与 agent 账号

- agent WebID 由本部署的 IdP 签发；仓库已有该形态的先例：applet 的 `service.webId`
  （`AiGatewayManagementHandler` 的 `servicePrincipal.getServicePrincipal()`，本地部署允许回退到当前 WebID）。
- 每个 agent 一把 CSS client credential，**与 owner 无关**（部署级），封存在 identity DB 的 vault 里；
  轮换/泄露恢复不动 Pod 里的任何授权。
- 现有 ACP 工具已按"agent"命名：`ui/src/api/service-access-acp.ts` 的
  `ensureAgentAccess(request)` / `buildServiceAccessAcrTurtle(...)`（容器级 ACR，
  `acp:accessControl` + `acp:memberAccessControl`，owner 自己始终保留 Read+Write+Control）。

## 6. 代码形态

```ts
// 声明（随程序发布；能力模块里）
interface PodAgent {
  id: PodAgentId;
  resources(podRoot: string): Array<{ url: string; access: 'read' | 'read+write' }>;
}

// 访问（agent 必填，漏传 = 编译错误）
getPodFetch(owner: string, { agent, podBaseUrl }): Promise<typeof fetch | undefined>;
```

- `OwnerPodAccess` 内部只剩一条路径：按 `(owner, agent)` 取该 agent 的凭据 → 换 DPoP token →
  走标准 Solid 接口（沿用 `HostedPodRoute` 的 canonical→loopback 路由与 proof 规则）；
- 删除"调用方自己的 sk-/Bearer"分支：调用方凭据只用于 HTTP 层鉴权，不再进入 Pod 层；
- `auth?` 可选参数消失，上一轮讨论的"忘了传 auth 就走了 owner 密钥"整类问题不再存在。

## 7. 授权与撤销（产品面）

1. owner 在设置页看到"Xpod 组件"清单（显示 agent 名称、能访问什么），一键授权 → 写 ACP；
2. 每项可单独撤销 → 重写该容器 ACR（移除对应 agent 块）；
3. 撤销后立刻生效（Pod 自己判断）；凭据仍在 vault 里，但对那个 Pod 已无用；
4. 授权状态可回读（复用 `ensureAgentAccess` 的状态返回，设置页显示"已授权/缺失"）。

## 8. 迁移

- 现有 owner 接口密钥（`identity_pod_interface_key`）保留为 **legacy 路径**，设明确截止版本；
- 过渡期行为：有 agent 授权 → 用 agent；没有 → 用 legacy 密钥（并记日志/在设置页提示"建议授权 Xpod 组件"）；
- 机会式迁移：用户打开设置/首次触发某组件时提示授权，避免要求所有人立刻重做一次；
- 截止后：legacy 分支删除，`pod_interface_key_missing` 之类的原因码由"未授权 agent"取代。

## 9. 验收

- **单测**：未授权 agent → 403 且不发起 Pod 请求；授权后 → 200；撤销后 → 立即 403；轮换凭据后 → 权限不变；
  `getPodFetch` 少传 agent → 编译失败（类型测试）；
- **集成**（真实栈 + 真实 ACP）：用 `XpodTestStack` 起真实 CSS，写 ACR 后以 agent 身份读写；越权资源必须 403；
- **真机 smoke**：在现有 `pod-interface-key-granted` 阶段旁加 `pod-agent-granted`
  （授权前 403 → 授权后可用 → 撤销后 403），沿用 `scripts/ngrok-inrupt-oidc-smoke.ts` 的既有骨架；
- **发布验收**：RC 的 `pod-read-write` / `ai-connections` / `models` / `chat` 检查必须继续全过。

## 10. 待验证（动手前必须先确认）

1. agent 账号的签发链路：能否给"组件类 agent"建 CSS 账号并签发 client credentials，以及轮换路径；
2. drizzle-solid 经标准接口读写时，ACP 的 `acp:agent` 授权是否完全生效（applet 走同一套 ACP + 同一数据面，前景乐观）；
3. 容器级 ACR 的继承对非 RDF 文档（如 `.json` 凭证文件）是否与 RDF 文档一致；
4. `acp:memberAccessControl` 与"新写入资源"的交互（组件写入新文档时是否自动继承授权）。

## 11. 需要拍板的决策

| # | 决策 | 建议 |
|---|---|---|
| 1 | agent 粒度：组件类 vs 每任务 | 组件类（见 §4），撤销仍可按 agent |
| 2 | legacy owner 密钥：保留多久 | 保留一个版本周期 + 设置页提示，下个版本删除 |
| 3 | 授权交互：设置页显式授权 vs 首次使用引导 | 两者都要：设置页是主入口，首次使用给一次性引导 |
| 4 | agent 身份是部署级共享，还是每 owner 一份 | 部署级共享（身份公开、无权限），授权逐 owner 写在各自 Pod |
