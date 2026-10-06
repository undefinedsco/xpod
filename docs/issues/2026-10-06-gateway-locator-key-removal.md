# 移除 `XPOD_GATEWAY_LOCATOR_SECRET`（及其整套 Gateway API Key 逻辑）

**状态**：待后续分支执行（本文档给出完整范围、红线与验收）
**决策**：用户拍板 —— 这个键与围绕它的逻辑**都不应存在**；所有 API 请求一律凭**用户凭据**代查，不需要服务端自签凭据与寻址状态。
**撰写日期**：2026-10-06
**已存在的参考实现**：`release/0.4.19` 上有两个先行提交（见文末「已完成的部分」），其中「彻底移除」由一次子代理任务起草（提交号见文末，若尚未回填即为进行中）。

---

## 1. 它到底是什么（先纠正命名误解）

名字里的 **gateway ≠ nginx 网关**，而是**模型/AI 网关**（那套 API key 要打开的东西）。仓库里的类名已写明关系：`PodGatewayAccessKeyRepository` = 「存在 Pod 里、用于访问 gateway 的 key」。

- 它是一把 **AES-256-GCM 对称密钥**，只把 `{owner WebID, keyId, deployment}` 加密成 API key 字符串里那段不透明 key id（locator）。
- 网关收到 key 后**先解 locator 得到 owner**，再**去该 owner 的 Pod 里**取行校验：`secretHash`(scrypt) + deployment 一致 + 未 revoke/disable/expire + scopes。
- **授权判定始终在 Pod 内**；locator 只是服务端私有的**寻址状态**（系统里没有集中的 key 索引表，所以不透明 id 必须自带「该问哪个 owner」的信息）。

证据（HEAD = `release/0.4.19`）：

| 环节 | 位置 |
|---|---|
| 定义与 cloud 抛错 | `src/runtime/gateway-locator-secret.ts:14-15`（0.4.29 为 `:8-9`） |
| 唯一装配点 | `src/api/container/common.ts:140-147` → `:273` → `AesGatewayKeyLocatorCodec`（`:270-276`）→ `PodGatewayAccessKeyRepository`（`:269`） |
| 加密实现 | `src/api/ai-gateway/auth/GatewayKeyLocatorCodec.ts:48-63`（AES-256-GCM+AAD）、`:65-72`（kid 环）、`:112`（`sha256(secret)[:32]`） |
| 校验与授权 | `src/api/ai-gateway/auth/GatewayApiKeyAuthenticator.ts:120-152`、哈希格式 `GatewayApiKey.ts:97-109` |
| 「API key 主体不能管理 provider/keys」 | `GatewayPrincipal.ts:27-41`、`AiGatewayManagementHandler.ts:1046-1049` |
| 跨副本必须稳定 | `docs/issues/2026-08-28-gateway-key-restart-durability.md:18-25,59-60`、`docs/RELEASE.md:167-176` |

## 2. 为什么「只删配置」不行（今天已实测）

cloud 模式下缺该 env 是**启动失败**，不是某条路由失败：
`src/api/runtime.ts:604` → `src/api/container/routes.ts:144`，装配期同步解析并抛错。

> 实测：线上镜像缺该 key 时 API 报 `Failed to start API Service: XPOD_GATEWAY_LOCATOR_SECRET is required for Cloud Gateway API keys…`，整个 API 起不来。

**所以顺序必须是：先落代码，再摘配置。**

## 3. 顺带一个关键发现（决定能不能删干净）

HEAD 生产代码里**已经没有任何地方签发** `xpod_gw_v1_...` key（`createGatewayApiKey` / `formatGatewayApiKey` 只剩测试调用），且 API key 主体被**明确排除在 Pod 访问之外**：

- `src/api/auth/CallerPodAccess.ts:20-31` 排除 `viaGatewayApiKey`
- `src/api/auth/OwnerPodAccess.ts:119-132` 只认调用者自己的 Bearer / client credentials / task grant
- 校验路径根本没传 auth（`PodGatewayAccessKeyRepository.ts:290-294`）

静态读码推断（**未动态验证**）：HEAD 上 API key 主体读 Pod 会 503，即**这套功能已不可用**。执行前建议先跑一次集成用例确认，或直接按「下线产品线」处理。

## 4. 🔴 红线：不要把 AI-Connections 的 invocation token 一起删掉

`GatewayApiKeyAuthenticator` **同时**承担 **AI-Connections invocation token**（`xpod_inv_v1.*`，scopes `models:read` / `inference:write`）的校验，`GatewayPrincipal.isInternalGatewayInvocationPrincipal` 依赖它。

**要求**：先把 invocation 路径的校验代码定位清楚，只剥离 Gateway API Key 分支；invocation 分支的行为（错误码、scopes、principal 判定）必须逐字保持，并保留其测试。**若做不到不破坏它，就停下并说明卡点，不要硬删。**

## 5. 移除范围（以执行分支自行复核为准）

**删除文件**
- `src/runtime/gateway-locator-secret.ts`
- `src/api/ai-gateway/auth/GatewayKeyLocatorCodec.ts`
- `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts`
- 仅服务该功能的 `GatewayApiKey` 类型/格式（若确认无其它消费者）

**装配与路由**
- `src/api/container/common.ts`（约 `:12`、`:140-147`、`:267-280`、`:585-644`）
- `src/api/container/index.ts`（约 `:181-183`）
- `src/api/container/types.ts`（约 `:142-145`，含轮换环）
- `src/api/container/routes.ts`（约 `:144`、`:209-225`）

**调用方**
- `src/api/ai-gateway/AiGatewayManagementHandler.ts`（约 `:118`、`:144`、`:215`、`:255`、`:1046`）
- `src/api/ai-gateway/GatewayPrincipal.ts`（约 `:27-41`）
- `src/api/ai-gateway/AiConnectionsServiceAccess.ts`（约 `:34`、`:77-78`、`:93-112`）

**配置 / 文档 / CI**
- `deploy/sealos/env/{cn,co,rc}.env.example`：移除该键
- `docs/RELEASE.md`（约 `:167-176`）、任何仍把它写成必需的运维文档
- `.github/workflows/candidate.yml`（约 `:276` 的必需键清单）

**测试**（约 15 个文件）
- 删除：`tests/runtime/gateway-locator-secret.test.ts`
- 修改：`tests/api/container/config.test.ts`（约 `:188-200` 及后加的用例）、`tests/api/ai-gateway/{PodGatewayAccessKeyRepository,GatewayApiKeyAuthenticator}.test.ts`、`tests/api/auth-authority-boundaries.test.ts`（约 `:28`）、`tests/scripts/{release-docs,candidate-workflow,integration-lite-local,accept-network-tunnel}.test.ts`、`tests/helpers/` 中相关 4 个文件

**前端**：仓库里若有引用该 key 的 UI（API KEYS 页面），**只报告不删**，交由产品决定；仅当删除后无法编译时才一并处理并说明。

## 6. 风险（执行前请确认已接受）

1. **存量 `xpod_gw_v1_*` key 立即全部失效**，不可追溯修复（参见 issue 文档 `:73-77`）。
2. **轮换环**（`types.ts:145`）随之作废。
3. **RC 门禁三处会红**，需要同步更新门禁断言。
4. **等于下线 Gateway API Key 产品线**，需与前端 API KEYS 页面、以及任何对外文档/客户沟通对齐。
5. 删完后**三份 env / GitHub 环境 secret / 集群 secret** 里的该键都可移除 —— 但**必须等新镜像部署完成之后**（顺序反了会让三个环境的 API 起不来，今天已实测）。
6. 「HEAD 上该功能已不可用」目前是**静态推断**，未跑集成用例动态验证。

## 7. 验收（执行分支须做到）

- `bunx vitest --run tests/api tests/runtime tests/scripts tests/gateway`：除既有失败外全绿；**任何因本次删除新增的失败都必须修掉**。
- `bunx tsc --noEmit` → exit 0；`bunx tsc --noEmit -p tsconfig.test.json` 错误数**不得增加**（2026-10-06 时为 56 个既有错误）。
- invocation token 路径有**测试证据**（`文件:行号` + 用例通过）。
- 集群侧冒烟：cloud 且**不配**该 env 时 API 正常启动；配了则行为与删除前一致（直到代码里不再引用它为止）。

## 8. 已完成的部分（2026-10-06，均在 `release/0.4.19`，未推送）

| 提交 | 内容 |
|---|---|
| `c0c28300f` | **让该键在 cloud 变为可选**：`resolvePersistentGatewayLocatorSecret()` 返回 `string \| undefined`，cloud 缺省时不再抛错（不派生、不落盘、不生成替代值）；`common.ts` 的 `gatewayAccessKeyRepository` 工厂缺省时 warn 一次并返回 `undefined`（不构造 codec/repository）。local 行为不变。**刻意保留认证器**正是为了第 4 节的红线。 |
| `5910f7b77` | 修 `tests/scripts/rc-deployment-manifest.test.ts` 的资源期望（`500m/1Gi/4/2Gi` → `250m/1536Mi`，因线上规格按 requests=limits 调整过）。 |
| 见文末回填 | **彻底移除**的参考实现（子代理起草，未推送）——供后续分支参考或直接 cherry-pick。 |

**注意**：这些提交只在我们这条 `release/0.4.19` 上，不会自动进入更新的 release 分支；后续分支若要采用，需 cherry-pick 或按本文档第 5 节重做。

---

### 相关文档
- `docs/issues/2026-08-28-gateway-key-restart-durability.md`（为什么必须跨副本稳定）
- `docs/superpowers/specs/2026-08-03-plaintext-pod-credentials-design.md`
- `docs/superpowers/plans/2026-08-04-client-credentials-convergence.md`
- 交接记录：`~/develop/undefineds/handover/DEPLOYMENT-STATE-2026-10-06.md`
