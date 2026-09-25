# Pod 接口密钥（Pod Interface Key）

> 状态：2026-09-24 审查修订。本文区分当前实现与已确认的目标设计；迁移清单尚未实施，不表示运行验收通过。
> 范围：API sidecar、普通浏览器交互、Inngest/任务执行层访问 Pod 的凭证边界。
> 相关：[`multi-channel-access.md`](multi-channel-access.md)、[`ai-connections-storage-model.md`](ai-connections-storage-model.md)、[`caller-owned access`](superpowers/specs/2026-08-09-caller-owned-ai-connections-access-design.md)。

## 1. 已确认的设计

一个 API Server 对应一个 CSS，既支持随部署 CSS，也支持外部 CSS。服务端访问 Pod 使用标准 Solid 接口和有效的调用者凭证；内部地址或部署签名不创造用户资源权限。

区分两类秘密：

- **CSS client credentials**：客户端以 `sk-base64(client_id:client_secret)` 包装后调用 API。API 向确定的 CSS issuer 换取 token，使用调用者权限访问 Pod。这不是第二种 Xpod 自签密钥。
- **Provider secret**：上游 AI API key / OAuth token，存于用户 Pod。任务不读取它；可信 API AI 执行层使用它调用上游。

职责与进程位置无关：

| 主体 | 目标职责 | 持久化边界 |
| --- | --- | --- |
| 浏览器 host | 当前 Session 访问 Pod，管理配置并发起普通交互 | 不因登录自动授予后台权限 |
| API sidecar | 验证调用者，提供统一模型路由和推理服务 | 请求级凭证和短期 token/DPoP 会话缓存；不建通用长期 CSS credential vault |
| Inngest/任务执行层（可信 Runtime） | 保管用户 CSS credential，检查 Agent/任务权限后代表用户调用工具及 API | 加密用户凭证、Agent 授权、任务绑定和持久执行注册；三者分别管理 |
| CSS | 验证 Solid 凭证并执行资源授权 | 不需要理解 Xpod taskId 或内部签名 |

普通交互在登录且模型已配置后即可使用，不要求先创建/导入 CSS sk。后台任务另行显式授权。

### 1.1 信任边界与授权归属

用户信任自动化软件保存并使用自己的 CSS client credentials。这符合服务端自动化认证的用途；持久化归任务 Runtime 是本产品的职责划分，不是 Solid 禁止软件保存用户凭证。API 继续以调用者的用户身份操作 Pod，不新增独立的 API 服务身份或每任务 WebID。

Agent 指自动化软件内部的模型/执行角色；它不是仅因具有一个名字就成为 CSS 可识别的独立主体。CSS 验证用户权限，可信 Runtime 检查用户对 Agent 的授权。当前设计不宣称普通外部 CSS 原生理解这些 Agent 策略。

| 对象 | 内容与用途 | 不应混入 |
| --- | --- | --- |
| 用户凭证记录 | owner、issuer、加密 CSS credential、credential version/status；由 Runtime 的受保护持久存储保管 | Agent 的文件/模型权限，不以密钥命名表达权限 |
| Agent 授权 | owner 与稳定 Agent 标识的绑定、资源范围、操作、模型使用范围、期限、status/policy version | 明文凭证、允许 Agent 自行修改的策略 |
| 任务执行绑定 | task/run 与 owner、Agent、credential 引用、目标 Pod/API 的绑定；可附加本任务限制 | 独立扩大 Agent 权限的授权快照 |

同一用户凭证可以被多个 Agent/任务引用。凭证轮换不自动改变 Agent 授权；授权变更也不要求重新生成 CSS key。以上是逻辑契约，实施复用已有模型；新增共享语义先进入 models，不能在 Xpod 复制共享 schema。

在 Runtime 侧，允许的操作是用户授予 Agent 的范围与任务附加限制的交集；CSS 再检查用户本身的资源权限。任务可以在已获准的后台授权内创建和执行，不要求每次 run 重复人工授权；扩大范围或从普通在线交互转为后台执行不能自动推导同意。

Agent 的模型输入、工具参数和事件 payload 都不决定执行身份。Runtime 从受保护的任务注册恢复 owner/Agent 绑定，并校验发起者与绑定归属；请求自报的 agentId、owner 或 credential 引用不能覆盖它。用户管理授权的入口须验证用户权限，Agent 不得通过普通文件工具修改自己的策略或执行绑定。

完整 CSS 凭证和 authenticated fetch 仅在可信 host/Runtime/API 适配器中使用，不放进 prompt、工具返回值或任意代码执行环境。自定义代码或 shell 若能读取 Runtime 的内存、凭证文件或注入凭证的环境变量，就不在这个受限 Agent 边界内；要执行此类代码，必须提供不暴露这些材料的隔离环境。此方案信任自动化软件本身，不保证软件整体被攻破后仍能约束用户凭证。

**静态秘密的信任边界（已定，2026-09-23）**：用户凭证、Provider secret 与任务授权信封都放在**用户自己的 Pod** 里，
Pod 即静态秘密的信任边界；因此不为 Pod 内数据再引入一层专用加密（`SecretCellCredentialVault` 只保留其历史解密用途）。
推论：**"Pod 里安全"只回答"秘密存哪"，不回答"Runtime 拿什么打开这个 Pod"**。后台任务要读 Pod 内的凭证信封，
而这份解锁材料不可能也放在同一个 Pod 里（自锁），因此它必须位于 Pod 之外：要么是部署侧解锁材料（环境/KMS 配置一次），
要么是 Pod 侧已授权的服务身份凭据（见第 9 节决策 5）。这不属于"给 Pod 数据加密"，属于部署密钥的管理。

**范围限定（必须与本文一起读）**：Agent 隔离是**进程内**保证，不是 Pod/CSS 级保证。因为没有 Pod 侧的 Agent 身份，组件最小权限只由 Runtime 的检查点表达，而 Runtime 持有 owner 级凭证；CSS 只看到"用户本人在访问"。它的价值是防误用、防越界、可审计，**不是**"凭证泄露后仍只能读受限资源"。需要后者时，必须走 Pod 侧资源授权（本仓库当前不采用该路线，理由见第 1 节：外部 CSS 无法理解 Xpod Agent 策略）。

**命名区分**：本文的 Agent 指自动化软件内部的模型/执行角色。Matrix 存储另有 `MatrixAgentGrant`（`src/api/matrix/PodMatrixStore.ts`，房间内协作 Agent 的授权），两者概念不同、不得混用。

## 2. 当前实现及待迁移偏差

以下为 2026-09-23 审查时的源码事实，不是目标授权来源的优先级：

| 当前实现 | 行为 | 待修正 |
| --- | --- | --- |
| `OwnerPodAccess.getPodFetch` | **已改**：调用方 sk 与 owner 存储密钥都走共享 `SolidSessionFactory`（同一凭证只交换一次，DPoP key 由 factory 持有）；再尝试 caller Bearer；最后读取 owner 存储密钥 | 去掉缺少出站能力时的通用 owner 密钥回退；任务应自行恢复授权 |
| `CallerPodAccess` | **已改**：`isCallerOwnPodBearer` 接受任何已通过 issuer 校验、owner 匹配的直接 Bearer，只排除网关 API key / 运行态 invocation 主体与 DPoP | 保持；后续按决策 4 拆分 `caller_outbound_capability_missing` |
| `PodInterfaceKeyStore` + `identity_pod_interface_key` | 用 `CredentialVault` 长期封存 owner 的 CSS secret | 这是 API 部署凭证库，即使按用户隔离，也不符合任务层持久化归属 |
| `credentialVaultForConfig`（`src/api/container/common.ts`） | 写入路径一律是 `PlaintextCredentialVault`（base64，非加密）；`SecretCellCredentialVault` 只作为 `legacyVault` 参与**解密** | 第 1.1/3.3 节要求"加密保存、解密 key 与密文分离"，与现状不符；新凭证存储须明确走 `SecretCellCredentialVault`（依赖 `XPOD_SECRET_CELL_KEY_ID` / `XPOD_SECRET_CELL_KEY`），否则改口径（见第 9 节决策 1） |
| 本轮已上线的 `identity_pod_interface_key` | 行数据存在 API 的 identity DB；API 通过 `storedKeyFetch` 机会式使用 | **迁出后删除**：把行数据迁入任务层凭据存储（第 7.4 节），随后删除该表与 API 侧读路径（`PodInterfaceKeyStore`、`storedKeyFetch`、注册时 `saveKey`）。表归任务层，API 不保留访问；过渡期只读、不再新增写入 |
| `POST /api/ai/gateway/keys` | 校验凭证后先 `saveKey`，再写 Pod 记录；后者失败没有补偿 | 注册配置与后台授权解耦；不以持久化密钥解决第一次 Pod 写入 |
| `OwnerPodAccess` 的身份保护 | 拒绝另一个 Solid WebID；无 auth 时仍可读取存储密钥 | owner 字符串不能成为后台授权；恢复须经过任务绑定状态校验 |

此前 09-21 的设计/TODO 文件在本次工作区中不存在，因此本文保留必要设计与迁移清单，不引用失效文件。旧文档与本文冲突的部分需在迁移时同步，不能用现行代码反向改写已确认边界。

## 3. 目标调用路径

### 3.1 CSS sk 与适用的 Bearer

```text
客户端 / 可信任务 Runtime（已检查 Agent/任务授权）
  → CSS sk 或适用的 caller token → API
  → 请求级 Solid authenticated fetch → CSS 资源授权
  → 读取所选模型及对应 Provider credential
  → 共用 AI 执行服务 → 返回结果
```

Bearer 与 DPoP 都支持，分开入口认证与出站能力：

- CSS sk 的 token exchange 与 authenticated fetch 使用统一 session factory，保留 API 自己生成的 DPoP key，为每个规范目标 URL/方法生成新 proof。
- 直接 Bearer 经过身份验证且适用于目标 Pod 时可以使用，不要求 `viaApiKey`。仍校验发行方、适用范围、有效期、owner 和目标资源授权，不能将任意 API token 转发到 Pod。
- 浏览器入站 DPoP 只证明当前 API 请求；API 不持有浏览器私钥，不能重放到 Pod，也不能将 DPoP 改名为 Bearer。
- token 缓存按 issuer、完整凭证的安全指纹及凭证版本隔离，与 DPoP key 配对；不只按 owner/clientId 缓存。日志和 cache key 不含明文秘密。
- 401 失效缓存并按操作幂等性决定是否受控重试；403 不更换身份重试。不得回退全局服务身份或 owner 存储密钥。

**本轮落地（§7.1 第 1 步）**：`src/api/auth/SolidSessionFactory.ts` 是唯一的 token exchange 实现，`ClientCredentialsAuthenticator`（入站）与 `OwnerPodAccess`（出站）在容器里共用一个实例（`src/api/container/common.ts` 的 `solidSessions`）。缓存 key = issuer + 完整凭证 SHA-256 指纹 + 凭证版本，会话与 DPoP key 同存；过期留 30s 余量，401 触发 `invalidate` 后按下一次请求重新交换。`buildAuthenticatedFetch` 用 factory 交回的 key 为每个规范 URL/方法现算 proof。

**已验证（2026-09-24，`scripts/accept-solid-bearer-pod-access.ts`，临时本地栈 10/10）**：CSS 对不带 DPoP proof 的请求签发**真 Bearer** access token；该 token 可直接读写 Pod（`PUT` 201）并访问 `/-/sparql`（200）；**API 接受它并用调用方自己的 token 读 Pod**（`GET /api/ai/gateway/keys` 经网关与直达 API 均 200，同 token 下 SPARQL 面 200）；同一用户的 **DPoP** token 在同一接口上 403 `service_access_missing`（API 不重放 DPoP）；无凭据 401。也就是说"API 用调用方自己的 Bearer 打开用户 Pod"这条链路**当前代码已支持，不需要改后端**。

同时发现两件必须记住的事：
- **浏览器会话目前是 DPoP**：`ui/src/solid/XpodSolidRuntimeProvider.tsx` 的 `session.login(...)` 没有传 `tokenType`，走 inrupt 默认 `DPoP`。所以"浏览器拿自己的凭据直调 chatkit/API 读 Pod"今天还不成立——要么登录时改 `tokenType: 'Bearer'`（前端一行，安全姿态变化：Bearer 无持有证明，API 在有效期内可重放），要么浏览器侧持有 sk（`ui/src/auth/account-client-credentials.ts` 已有创建/撤销能力）。
- **chatkit 曾掩盖 Pod 不可达（已修）**：`PodChatKitStore.getDb` 原来在拿不到 Pod 凭据时返回 `null`，26 个调用点据此返回空列表/空值，因此没有可用 Pod 凭据的调用方拿到 `200 {"data":[]}` 而不是原因码。现在 `getDb` 直接抛出原因码（无身份 → `caller_pod_access_unavailable`，不可用 → `podAccessError(...)`），`/v1/chatkit` 与 `/v1/chatkit/threads*` 通过 `src/api/handlers/PodAccessFailureResponse.ts` 映射为 401 `authentication_required` / 403 `service_access_missing` / 403 `pod_owner_mismatch`。验收脚本对应断言为 `chatkit-reports-dpop-caller`。

仍存在两处非本路径的交换，**未收敛，已记录原因**：
- `src/solidfs/PodSolidFsHttpClient.ts`：只产出 headers（`createAuthHeaders`），拿不到目标 URL/方法就无法生成 DPoP proof，因此仍以 body 传递 `client_id/client_secret` 换取 Bearer；随 §7.1 第 5 步（后台入口迁移到 Runtime 任务）改为 fetch 形态后并入 factory。
- `src/cli/lib/solid-auth.ts` 的 `getAccessToken`（已标 `@deprecated`）：CLI/桌面向 CSS 走 discovery 后自行交换并返回可重放的 Bearer，不在 API runtime 内；待其调用方迁移到 `authenticate()`/`Session.fetch` 后删除。

### 3.2 普通浏览器交互

将已有 caller-owned 的 probe/OAuth/quota 瞬时输入契约扩展到前台 Chat、模型测试与交互 embedding：

1. 可信 host 使用当前 Session.fetch、drizzle-solid 和 Pod store，读取所选模型及对应单个 credential。
2. host 通过经当前 session 认证的交互适配器提交 operation、必要模型/Provider/Offering 配置、推理参数和瞬时 credential。建议入口 `/api/ai/invoke`，属于待新增能力。
3. API 验证请求参数、能力组合及 endpoint/proxy 网络访问策略，接入同一模型路由和 AI 执行服务。此路径无需 API 再读取 Pod。
4. 返回结果或流；结束后释放请求级秘密。模型列表、聊天历史和前台工具 Pod 读写由 host 的 Session 能力完成。

复用 `AiConnectionsPodStore.readCredentialSecret`，向 Applet/agent 暴露窄的调用能力，不将原始秘密交给任务或工具。瞬时 Provider secret 不进入 URL、聊天记录、日志、trace、错误、普通响应、Inngest event/step 或持久缓存。OAuth 轮换仅通过专用一次性交接由 host 写回 Pod，不混入模型输出。

交互适配器的准入与秘密生命周期（实施时必须同时满足）：

- **准入**：必须 owner session（或与 host 同源的受信通道）；不接受机器 sk 之外的匿名/跨 owner 调用；客户端提交的配置不证明 Pod 所有权（§3.2 末段已述）。
- **秘密生命周期**：请求级持有，批次/流结束后显式释放；不写入任何持久缓存、不进入 Inngest step 返回值、不参与重试快照；日志/trace/错误只记录"使用了哪个 credential 引用"，不记录内容。
- **与 host Pod store 的边界**：`readCredentialSecret` 只对 host 的能力调用开放，返回窄结构；Applet/Agent 拿到的是"调用结果"，不是原始秘密。工具侧不得持有可回放任意请求的通用 HTTP client（§3.4）。

机器路径和交互路径仅配置/credential source 不同，不维护两套 Provider 注册表。客户端提交配置不证明 Pod 所有权，也不赋予服务器默认密钥或部署额度。

普通 Chat 若当前耦合持久 run/step，须拆出请求级在线执行适配器。断线取消前台调用，不承诺离线续跑，不静默把瞬时秘密转存为任务凭证。服务端工具需要 Pod 权限时，应接 host 能力或转入显式授权的后台任务。

### 3.3 后台任务

rebuild、定时任务、关闭浏览器后继续执行的 Chat/agent，由用户显式授权：

- Runtime 验证 CSS credential 对应的用户 WebID，按 §1.1 分开保存用户凭证、Agent 授权和任务绑定；固定目标 Pod/API/CSS，校验 owner 一致。
  三者都写成**用户 Pod 内的资源**（任务注册用 `taskResource`，凭证信封用 `task-auth` 凭证资源，与现有 `TaskRecordData` / `TaskAuthBinding` 一致）；
  这把"存哪"落在 Pod，"用什么打开"落在部署侧解锁材料（第 9 节决策 5）——两者不可互相替代。
- 用户 CSS credential 以信封形式存于用户 Pod（`task-auth` 凭证资源）；任务与 Inngest event 只带引用和版本，由可信 resolver 核对绑定后恢复，不把 secret 当 step 返回值、不放进事件载荷。
- **Runtime 侧另有一份"运行态钥匙"**：后台执行必须先能打开用户 Pod，而这份材料不能放在被打开的那个 Pod 里（自锁），也不能放进 Inngest 的事件/step 数据（见第 7.3 节）。它存在**任务层自己的表**里（`identity_task_credential` 草案见第 7.4 节），由任务层读写；Inngest 只通过引用与版本指向它。
- 恢复不能先要求读取 Pod 内的同一凭证，也不能依赖旧内存 registry。周期调度需要持久任务注册，不能仅靠 event 或内存 context 发现任务。
- 开始/恢复任务以及每次工具操作前，检查当前 Agent policy、task binding 和 credential 状态/版本/期限；执行中变更按 §4 撤销契约生效。旧事件不携带可覆盖当前授权的权限快照，不回退旧 context。
- tasks/ingest 使用受控 embeddings 工具；工具的可信适配器携带用户 CSS sk 调 `/v1/embeddings`。任务业务逻辑只取得向量等非秘密结果，不接收 sk 或 Provider secret。源数据读写走单独受控文件工具。

窄的任务 API client 是软件边界，不等于 CSS owner credential 已被缩权。持有 owner 凭证可能拥有 owner 的资源权限；本设计不声称被盗 CSS key 只能调用 embeddings，也不暗自增加每任务 WebID。

### 3.4 工具权限的执行点

所有 Agent 发起的文件或模型操作先经过 Runtime 的共同授权入口，再由持有用户凭证的工具适配器执行。同进程也不能直接向 Agent 暴露原始 Pod fetch、凭据仓库或注入了用户 sk 的通用 HTTP client。在线 Agent 的 host 工具同样检查授权，不因浏览器 Session 有 owner 权限就跳过。

| 工具操作 | 检查内容 |
| --- | --- |
| 读取文件、列举容器 | 规范资源 URI、目标 Pod、Read/List 范围；容器枚举不能泄露未授权成员的内容或元信息 |
| 新建、修改、删除、移动 | 实际受影响的资源和对应操作；递归/批量逐项检查，移动同时检查源与目标 |
| 搜索、索引检索 | 查询与返回资源都受范围约束，不能借摘要、片段或计数暴露无权访问的数据 |
| embedding / Chat | 所选服务与模型、允许的操作和配置的使用限额；不将调用权限转换为凭据文档的 Read |
| 任意 URL、SPARQL、shell | 未经过等价资源检查与执行隔离的通用入口不向受限 Agent 开放 |

规则以规范资源和明确操作表示，不用简单字符串前缀替代 URI/容器范围判断。重定向、批处理展开及重试后仍检查实际目标；不将用户认证头转发到未授权 origin。无法确定查询会访问哪些资源时，拒绝该通用查询或使用能证明范围的受控查询实现，不能只限制 SPARQL endpoint。

API 的 embeddings handler 在已获准调用后，以用户身份读取确定的模型/Provider credential 并调用上游。这是可信实现的内部步骤，不再次要求 Agent 获得密钥 Read。工具绑定经授权的服务/模型并验证参数；不接受 Agent 指定任意 credential URI、endpoint 或要求回显秘密。文件工具仍独立拒绝读取未授权的凭据资源。

程序支持哪些工具/操作是随程序发布的能力声明；用户授权只选择其范围，不能通过修改 Pod 配置安装新的特权实现。审计记录 owner、Agent、task/run、操作、目标、授权版本与结果，不记录凭证或敏感输入正文。

## 4. 注册、持久授权与失败恢复

### 普通客户端密钥登记

账户侧创建或客户端导入 CSS credentials。`POST /api/ai/gateway/keys` 登记客户端配置，不自动授权部署长期保存凭证：

1. 校验 wrapper，通过唯一 CSS issuer 验证真实 WebID 与已认证 owner 一致。
2. 用本次已验证 credential 创建请求级 Pod fetch，写入非秘密客户端配置；不先保存 owner 长期密钥。
3. 写入成功才返回成功；失败仅清理请求级材料，不留下新的后台授权，也不覆盖既有任务绑定。

写第一条 Pod 记录需要可用凭证，不需要先持久化凭证。不能继续将 `saveKey → repository.create` 描述为硬要求。

### 显式任务授权登记

任务授权是独立操作，与客户端配置登记分开。跨 Pod 与任务存储不能假定存在数据库事务，需定义可恢复状态流：

- 校验成功后以幂等请求标识暂存 `pending` 授权/绑定；新绑定不可被调度器使用。引用既有共享 credential 时，不改变其他 active 绑定的状态。
- 完成必要的 Pod 任务事实/引用写入，再在任务存储原子激活 binding、注册和待投递记录；只有 `active` 可执行。
- 失败保留可恢复状态或清理 pending；不得返回“未授权”却留下可执行凭证。重试复用同一操作，避免重复任务。
- 凭证轮换与授权变更分别做版本检查；失败不能覆盖旧的有效记录。切换共享 credential version 不改变 Agent policy；授权变更也不替换 credential。并发更新不得靠“恢复旧值”覆盖他人已完成的操作。
- 崩溃后由恢复流程补齐或终止 pending；投递使用幂等 executionKey，不能先响应成功再丢失注册或投递。

上述状态与适配器尚待实现，不要求直接修改 Inngest 私有表。

### 撤销

撤销具有不同作用域，不能通过删除共享密钥代替所有撤销操作：

| 动作 | 生效范围 | 凭证处理 |
| --- | --- | --- |
| 撤销一个任务 binding | 该任务及其后续 run/retry/continuation | 移除绑定的使用资格，保留其他引用 |
| 撤销/收窄 Agent 授权 | 该 Agent 所有任务的后续操作 | 保留其他 Agent 的凭证引用，不改 CSS 身份 |
| 从自动化软件删除用户凭证 | 该软件中所有引用它的任务/Agent | 标记不可用、拒绝后续使用并清理密文及相关会话；显示受影响对象 |
| 在 CSS 撤销 credential | 该 credential 在所有客户端的后续认证 | 不承诺立即废止已签发 token |
| 删除客户端配置记录 | 仅配置记录 | 不自动执行上述撤销 |

每次工具操作准入时，从可信权威存储读取当前授权和绑定状态，不使用无期限的正向权限缓存。状态读取失败则拒绝执行。多副本准入与撤销采用一致的版本/状态检查；撤销成功后才发起准入的操作必须被拒绝。先于撤销已获准的操作视为在途，尽力取消但不承诺追回。长任务的下一次文件访问、embedding 批次、重试和 continuation 都重新准入，不能以“run 已启动”跳过。

CSS token 缓存不等于 Agent 授权缓存；token 尚有效也不能绕过被撤销的 Runtime 绑定。撤销单个任务只清理它的派生执行状态，不清空其他任务仍使用的共享凭证。凭证记录只有在显式删除，或无保留需求且无有效引用的清理策略下才销毁；并发引用创建与清理需避免误删。

CSS credential 撤销后不得再次成功交换；已签发 token 的失效时间取决于 issuer。对旧部署 vault 的迁移不能仅凭 owner 自动创建 Agent/任务授权，需用户明确授权或可验证的既有授权来源。完成迁移/重新授权及清理验证后，再移除旧存储与回退。

## 5. 错误与产品行为

现有错误映射包含 `service_access_missing`（403）。它是待兼容迁移的 wire 契约，不应把所有身份、网络和授权失败都强制变成同一个错误。

| 情况 / 现有 reason | 目标处理 |
| --- | --- |
| 未认证或 token 无效 | 认证层提示登录/更新凭证，不尝试 owner 存储密钥 |
| `caller_owner_mismatch` | 拒绝请求，不能借用目标 owner 的授权 |
| `caller_pod_access_unavailable` | 已认证但缺少出站能力也可能发生；不能一律提示“先登录”。两类成因建议拆成独立 reason（如 `caller_outbound_capability_missing`），否则 UI 只能靠猜；兼容期内可先保留旧码并附 `details.capability` |
| `caller_dpop_replay_unsupported` | 直接请求需要出站 Pod 能力的接口时明确失败；普通交互应走 host 适配器，不引导用户额外托管密钥 |
| `pod_interface_key_missing` / `pod_interface_key_rejected` | 旧 vault 路径的迁移诊断，不作为普通交互的必经状态；后台指向具体任务重新授权 |
| Agent policy / 任务 binding 缺失、撤销、过期或操作越界 | 返回具体授权层和原因；不回退 owner key 或旧 registry，不改用其他 Agent |
| CSS 拒绝资源访问 | 保留权限拒绝含义；不能冒充空模型列表。现状补充：`AGENTS.md` 已记录"`/v1/models` 返回空数组不代表 Chat 可用"，即空列表可能掩盖 Pod 不可达；迁移时一并改为显式错误 |
| issuer/Pod 暂时不可达 | 返回可重试的上游故障，不提示用户重新创建密钥 |

实施时补齐错误到 HTTP/wire/reason 的兼容映射及测试，区分已有 reason 与新增任务状态；本文不宣称新错误码已实现。

## 6. 内部 transport 与外部 CSS

旧 `/.internal/pod-data` 通过内部 HMAC 意图直接调用 ResourceStore，绕过调用者资源授权。目标是不恢复这个旁路，同时保留 task → API、API → CSS 的正常内部 transport。

旧路由不存在只能证明旁路关闭；浏览器交互、任务恢复和外部 CSS 有完整替代证据后，才能宣称迁移完成。

同部署路由保留已有约束：

- `HostedPodRoute` 只替换已确定的本地请求目标，不改变 canonical URL/RDF 身份；DPoP 按规范 URL 签名，CSS 仍执行资源授权。
- route 在 runtime 构建服务时解析一次。启动后 `environment.restore()` 会恢复临时环境，不能在请求时重新读取 `XPOD_MAIN_PORT` / `CSS_BASE_URL`。
- 使用 Gateway 实际绑定地址，避免硬编码 `127.0.0.1` 与仅监听 IPv6 的 `localhost` 不匹配。
- canonical 转发头须来自受信任的路由层，不能让外部请求自行指定授权目标。

外部 CSS 走标准 URL，不依赖本地 Gateway、identity 账户记录或 Xpod 专用头。issuer、WebID、Pod root、API URL 不应从彼此的字符串路径猜测；复用规范配置和 discovery，避免重复配置。数据层优先 drizzle-solid，验证标准资源与集合访问，不假定外部 CSS 提供 Xpod SPARQL/vector 扩展；库能力缺口先记录 issue。

**支持范围（2026-09-24 确认）：只支持 CSS——随部署 CSS 与外部 CSS。** ESS/Inrupt PodSpaces、NSS 等不在范围内：它们没有 CSS 的 Account `client-credentials` 能力，"静默准备一把 API 可花的凭据"和 Xpod 扩展都无从谈起，浏览器直读之外的能力无法按同一口径验收。

由此得到两类 CSS 的分工（这一条决定第 2 步的实现范围）：

- **随部署 CSS（自家 Pod）**：浏览器与 Account API 同源，可以**静默**为当前 WebID 创建/持有一把 client credential，请求级携带给 API；API 代读、内部 transport、索引扩展都可用。
- **外部 CSS**：机制上是通的——`resolveHostedAccountControlUrl` 已支持"控制 URL 与**受信任账户索引**同源且都在 `/.account/` 下"的第三方 authority 分支（`ui/src/utils/account-control-url.ts`），CSS 默认中间件也带 CORS（`CorsHandler`，origin 反射 + `options_credentials: true`，作用于所有入站请求），所以浏览器可以跨源携带 `CSS-Account-Token` 调外部 CSS 的账户接口。**当前限制在"账户索引的来源"**：`resolveXpodAccountIndex()` 只认当前 Xpod 的 authority（公网用 `window.__XPOD__.idpIndex`，local 用 `/provision/status`），因此凭据总是创建在当前 Xpod 自己的 CSS 上。要把静默创建扩到外部 CSS，需要三件事：(1) 由用户的 WebID/issuer 解析**其 Pod authority** 的账户索引并按 issuer 校验；(2) 按 authority 保存/使用账户会话（现为单 authority：`xpod.cssAccountToken` + `xpod.cssAccountAuthority`）；(3) API 侧按 issuer 解析 token endpoint 才能用这把凭据代读（今天是单一 `config.cssTokenEndpoint`）。在三件事完成前，外部 CSS 的前台按"host 用当前会话直读 Pod、API 只做推理"工作，后台任务由用户显式导入一把该 issuer 的凭据存任务层（决策 5/7）。

外部 CSS 上的能力边界（实施与验收都以此为准，缺能力要显式报缺口而不是静默降级）：

| 能力 | 随部署 CSS | 外部 CSS |
| --- | --- | --- |
| 标准 LDP/RDF 读写（drizzle-solid，资源与集合） | 支持 | 支持 |
| 浏览器静默准备请求级 client credential（Account API） | 支持 | 机制可行（CORS 默认允许、`trustedAccountIndex` 分支存在），但需补"按 Pod authority 解析账户索引 + 多 authority 会话"；未补前改由 host 直读或用户显式导入 |
| API 用调用方凭据代读 Pod | 支持 | 需按 issuer 解析 token endpoint（待补），且 loopback transport 不适用 |
| 模型/凭证文档（由 host 写 Pod，路径来自 models） | 支持 | 支持（标准资源写入） |
| 内部 transport（`HostedPodRoute` + canonical 头） | 支持 | 不适用（直接用标准 URL） |
| FTS / VEC 索引与检索（`rdfEngine`、`rdfSearchIndexingService` 扩展） | 支持 | **不支持**：不得用 embeddings 成功掩盖索引缺失 |
| Xpod SPARQL 子图端点（`SubgraphSparqlHttpHandler`） | 支持 | 不假定存在 |
| `/.internal/*` 旁路 | 已删除 | 已删除 |
| `/provision/*`、identity 账户记录、Xpod 专用头 | 支持 | 不作为前提 |

运维接口 `/service/logs`、`/service/restart/*`、`/service/stop` 继续按 operator 授权，与 Pod 数据权限分开。

## 7. 实施清单

第 1 步已实施（2026-09-24），实现与验收见 §3.1、§8；其余条目为未来实施。

### 7.1 迁移顺序（每步都可运行，且不先删回退）

原则（2026-09-24 确认）：**API 只在用户在场的同步路径上工作——凭据随请求而来，API 不持久化 owner 凭据；异步任务自己管理凭据。**

现状：0.4.15 上线的 9 个 Pod 访问入口**全部**依赖 legacy owner vault（`identity_pod_interface_key` + `storedKeyFetch`）。因此在替代能力通过验收前，任何一步都不得删除该回退，否则前台或后台能力立刻退化。顺序与"每步的验收证据"绑定：

| 步 | 做什么 | 完成判据（验收） | 此时 legacy 状态 |
| --- | --- | --- | --- |
| 1 | **已完成**：收敛 token exchange / session factory；修直接 Bearer 的来源限制、DPoP key 生命周期、缓存隔离（§3.1） | 机器认证行（§8）：sk、直接 Bearer、服务器自持 key 的 DPoP 各自成功；错误 owner/proof/过期/缓存串用被拒 | 保留（唯一路径） |
| 2 | **前台改为请求级凭据**：前台的 Pod 访问由调用方在请求里带凭据（浏览器为当前 WebID 准备并持有自己的 client credential；Pod 直读仍走 Session，§3.2 的 host 适配器是这条路的实现形态之一），API 不再用存储的 owner 密钥给前台兜底 | 普通浏览器行：登录 + 模型已配置的真实 Chat 与 embedding 成功，且全程 `identity_pod_interface_key` 不新增；无凭据的调用方拿到 `service_access_missing` 而不是空结果 | 前台已不依赖；后台仍用 |
| 3 | **任务层凭据存储 + 显式授权**：Runtime 侧凭证表（§7.4，`sealed_secret` 按决策 6 加密）+ Agent 授权 + 任务绑定（pending/active、幂等投递、崩溃恢复，§4） | 授权状态行 + 任务执行行：pending 不执行、失败不留 active、重试/并发/轮换/撤销符合版本语义 | 保留（后台仍用） |
| 4 | **后台入口逐个迁移**：配额定时刷新、索引重建、chatkit 后台 run、Matrix/Reconciler（§3.3、7.2） | 每迁一个：该入口在无 API vault 的情况下完成一次真实执行；对应 legacy 调用点在同一提交内摘除 | 逐步缩小 |
| 5 | **收尾**：注册不再 `saveKey`；把 `identity_pod_interface_key` 的行迁出到任务层凭据存储；验证后删除 API 侧的表，并移除 `storedKeyFetch` | 迁移逐行核对（owner/issuer/credential_id 一一对应）+ 旁路退场行 + 全量 §8 通过；迁移失败时保持只读可回滚 | 移除（API 侧不再持有任何 owner 长期凭据） |

约束：第 2 步只改前台，不动后台（后台此时仍靠存储的密钥）；第 3 步必须先于第 5 步，否则新用户的**后台**任务会没有密钥；第 4 步每个入口必须"先有替代验收、再摘调用点"；第 5 步前 `pod_interface_key_*` 诊断码仍需保留，因为迁移期它们仍是有效状态。

**本阶段范围（2026-09-24 确认）**：第 2 步只做**随部署 CSS**。浏览器侧的静默凭据与请求级携带按"自家 Pod"实现。

**待办（不在本阶段）——外部 CSS 的静默凭据**：
1. 由用户的 WebID/issuer 解析**其 Pod authority** 的账户索引，并按 issuer 校验（不能采信 Pod 页面上任意 URL）；
2. 多 authority 的账户会话（现为单份 `xpod.cssAccountToken` + `xpod.cssAccountAuthority`，需按 authority 分别保存与失效）；
3. API 侧按 issuer 解析 token endpoint（现为单一 `config.cssTokenEndpoint`），否则该凭据换不到 token。
在此之前，外部 CSS 的前台按"host 用当前会话直读 Pod、API 只做推理"工作；需要后台能力时由用户显式导入一把该 issuer 的凭据，存任务层。

**前台请求级凭据的生命周期（第 2 步采用）**：登录后静默创建、**仅保存在内存**、登出即撤销。需要跨会话/跨设备复用时再改为存进用户自己的 Pod（那时浏览器用会话读取，凭据不进 API 侧存储）。

**前台凭据的携带方式（第 2 步实现）**：由**服务端**决定哪些调用需要 Pod 凭据——调用方自己的 context 打不开 Pod 时，API 返回 403 `service_access_missing`；host 的会话 fetch 捕获这一响应后准备本会话凭据并**重试一次**（`withRequestPodAuthorization`，`ui/src/auth/session-request-credential.ts`）。这样客户端不需要维护"哪些路由读 Pod"的名单：Pod 直读、capability 调用（`/api/applets/...` 需要交互式主体）与其他 origin 都不受影响；重试只发生在请求被拒绝、尚未产生副作用时。

### 7.2 现有入口的目标归属

| 入口 | 触发方式 | 目标归属 |
| --- | --- | --- |
| `AiConfigStore`（`src/api/ai-config/AiConfigStore.ts`） | 前台设置页 | host 适配器（浏览器 Session 读写）；后台配置读取随所属任务 |
| `PodGatewayAccessKeyRepository`（`src/api/ai-gateway/auth/`） | 机器（sk 校验）+ 前台登记 | 校验：调用者 sk 的请求级 fetch；登记：请求级 fetch（§4），不落部署密钥 |
| `PodModelSelectionRepository`（`src/api/ai-gateway/models/`） | 前台 + 机器 | 前台 host；机器路径用调用者 sk |
| `ProviderQuotaAdapter`（`src/api/ai-gateway/quota/`） | 前台手动刷新 + 定时 | 前台 host；定时迁 Runtime 任务（显式授权） |
| `connect/index.ts`（AI Connections 凭证） | 前台 OAuth/API key 连接 | host（沿用已有 caller-owned 瞬时契约） |
| 索引重建 `routes.ts`（FTS/VEC） | 前台触发、后台执行 | Runtime 任务；执行期不再读 API vault |
| `chatkit/pod-store.ts` | 前台聊天 + 后台 run | 前台 host；后台 Runtime 任务 |
| `PodSettingsHandler` 状态读取 | 前台设置页 | host（Session 读） |
| `src/api/matrix/*`（在途）、`src/api/reconciler/*`（在途） | 前台协作 + 后台 | 前台 host；后台 Runtime 任务；与在途改动的作者对齐后再摘调用点 |

### 7.3 权威存储与已有设施

- **任务绑定已有家**：`src/api/tasks/TaskAuthBinding.ts`（`TaskAuthBindingKind.SOLID_CLIENT_CREDENTIALS`、`TaskAuthBindingStatus.ACTIVE|REVOKED`、`TaskAuthBindingSnapshot`、`saveTaskAuthCredential` / `loadTaskAuthCredential`、`TaskAuthBindingService`）。§1.1 的"任务执行绑定"与 §4 的"显式任务授权登记"应写为**扩展它**，delta 至少包括：新增 `pending` 状态、授权/凭证版本字段、与 Agent 授权对象的引用关系。
- **Agent 授权对象目前没有载体**（`src/agents/` 只有执行器与类型）。需要先定它的存储位置（identity DB 独立表，还是任务存储内独立记录），否则 §4 的"三者分别管理"无法落地。
- **权威存储：Pod 资源为权威，Inngest 只带引用与运行状态**（2026-09-23 定）。任务注册与凭证信封已是 Pod 资源（`TaskRecordData.id` 形如 `index.ttl#task_*`；`TaskAuthBindingRepository.saveTaskAuthCredential` 写 `task-auth` 凭证资源），pending/active 与版本字段加在同一资源上。不把应用事实写进 Inngest 的表，理由是可核对的：
  - Inngest 在本部署是**我们自托管的 server**（`inngest-cli`，local 模式 spawn + `INNGEST_SQLITE_DIR=<root>/.inngest`，cloud 模式指向 `xpod-inngest:8288` 并把 `INNGEST_POSTGRES_URI` 设为同一个 Postgres URI + Redis），
    但它的表是 **Inngest server 的私有 schema**（event/run/step/queue 运行状态），会随 Inngest 版本演进——把授权/绑定语义写进去等于绑死在别人的内部结构上；
  - step 输出与事件载荷会出现在 Inngest 的 UI/调试面，正是 §3.3/§5 禁止秘密进入的地方；
  - Inngest 自己持有的 key 是**传输/认证**用的（`INNGEST_EVENT_KEY`、`INNGEST_SIGNING_KEY`），它不提供应用秘密保管语义：官方模型就是"应用自己保管秘密，Inngest 只传引用"。
- **"存 Inngest"落到基础设施上是什么**：cloud 模式下 Inngest server 用的就是我们交给它的那个 Postgres（`INNGEST_POSTGRES_URI = databaseUrl`）+ Redis；local 模式是 `<root>/.inngest` 下的 SQLite 目录。因此"密钥存 Inngest 侧"的可执行含义是：**存进任务层自己拥有的表**，与 Inngest server 管理的表并列在同一套基础设施里，双方都不读写对方的内部结构。运行态钥匙的表结构草案见第 7.4 节。
- **明确不做**：把 secret 放进 Inngest 的 event payload、`step.run` 返回值或 function state。这些是会被 Inngest 持久化并在其 UI/dev-server 调试面暴露的运行数据，且结构随 Inngest 版本演进；载荷里只允许出现引用（`credentialRef`、`credentialVersion`、`ownerWebId` 这类非秘密值）。
- **可靠性取舍**：Pod 内状态流与 Inngest 投递之间没有跨系统事务，因此 §4 的幂等 `executionKey`、pending→active 状态机与崩溃恢复必须建立在"Pod 为权威、Inngest 可重放"之上：先写 Pod 的 pending，再投递；恢复时以 Pod 状态为准补投或终止。

- [x] 收敛 token exchange/session factory；修复直接 Bearer 的来源限制、DPoP key 生命周期及缓存隔离。（2026-09-24：`SolidSessionFactory` + `isCallerOwnPodBearer`；`src/solidfs`、CLI 两处遗留交换已记录，见 §3.1）
- [ ] 新增 host 交互适配器，迁移模型测试与普通 Chat；拆开前台推理与持久 run/step。
- [ ] 将客户端配置登记改为请求级 Pod fetch；删除注册时自动保存部署 owner 密钥的行为。
- [ ] 分开用户凭证记录、Agent 授权和任务绑定；Runtime 恢复可信 owner/Agent 上下文，拒绝事件或参数伪造身份。
- [ ] 接入共同工具授权入口，覆盖文件/容器、批量、搜索、模型、重定向与重试；不暴露原始 fetch、secret 或可绕过限制的代码环境。
- [ ] 在任务层补齐加密凭证存储、pending/active 状态、持久注册、恢复、并发版本及幂等投递。
- [ ] 实现逐操作授权检查、多副本撤销、共享凭证引用与清理；凭证版本、Agent policy 和任务状态各自管理。
- [ ] tasks/ingest 改用 CSS sk 调标准 embeddings API；统一请求 model 与 Provider/Offering/credential 的解析。
- [ ] 逐一迁移当前使用 owner vault 的配额刷新、模型选择、重建及遗留 Key 校验入口，区分前台操作与后台授权。
- [ ] 替代功能通过后移除 `storedKeyFetch` 通用回退，处理旧 `identity_pod_interface_key` 数据及缓存；不得直接删除旧数据造成不可恢复任务。
- [ ] 更新 caller-owned、产品规范、错误映射、旧测试和 smoke 脚本，移除“普通交互注册前不可用才正确”的假设。

### 7.4 运行态钥匙的表草案（任务层自有表）

后台执行路径：`Inngest event(credentialRef, credentialVersion, taskId)` → resolver 读本表 → 开封 → 打开用户 Pod 读任务事实（Pod 为权威）→ 执行。

| 列 | 说明 |
| --- | --- |
| `owner_web_id` | 该钥匙代表的用户 WebID；与任务事实里的 owner 必须一致 |
| `issuer` | 签发该 credential 的 CSS issuer；换 issuer 不覆盖旧行，避免同名串用 |
| `credential_id` | 稳定引用 id，任务绑定只引用它，不引用明文 |
| `client_id` | CSS client id（非秘密） |
| `sealed_secret` | 信封；**按决策 6 用部署侧密钥（env/KMS）加密，只加密这一列** |
| `sealed_secret_key_id` | 加密该行所用的部署密钥标识；轮换时旧行仍可解，新行用新 key |
| `credential_version` | 轮换版本；绑定记录引用版本，版本不匹配即拒绝（§4） |
| `status` | `active` / `revoked` / `expired`；撤销只改状态，不删行 |
| `created_at` / `rotated_at` / `last_used_at` / `expires_at` | 轮换与审计 |

**已验证（第 4 步验收，2026-09-24，`scripts/accept-solid-bearer-pod-access.ts`，临时本地栈 15/15）**：脚本现在跑通"**没有 API 侧 owner 密钥也能执行后台任务**"这条链：`POST /api/ai/task-credentials` 只写任务层授权（201）→ 列表里是 `active` → `POST /api/ai/config/rebuild` 排队的 FTS 重建任务**执行成功**（`lifecycle.recent` 里 `succeeded`）→ `identity_pod_interface_key` **0 行**（API 侧从未存过 owner 密钥）→ 任务层凭据落在**独立文件** `tasks.sqlite`（1 行 `active`）。也就是说索引重建入口已经"在没有 API vault 的情况下完成一次真实执行"。

**落地（第 4 步第 3 片，2026-09-24）**：无人执行的 run 也改从任务层取凭据。`TaskAuthBindingService.resolveRunContext` 先看 binding id 是否**命名了一条任务层授权**（前缀 `taskcred_`，常量 `TASK_CREDENTIAL_REF_PREFIX`）：是则从任务层 `forRef` 取用，**完全不读 Pod**；不是则走原有的 Pod 内 `task-auth` 凭据（迁移期回退），无需改 models schema。两条规则保证不倒退：**形如授权的 id 解析失败即失败**（撤销/过期/版本不符不会退回 Pod 里那份旧凭据，否则等于让撤销失效）；**没有 owner 时不解析**（owner 来自运行恢复的上下文，不来自 binding id）。容器把 `createTaskCredentialSource` 注入绑定服务。

**落地（第 4 步第 2 片，2026-09-24）**：授权入口做成**用户可见的动作**，放在**维护索引 / 选择 embedding 的地方**（`ui/src/pages/settings/ai-config/`），不进 AI Connections applet。后端新增 `POST /api/ai/task-credentials`（body：用户的 `sk-` wrapper + 可选 name）：复用配置好的 CSS 认证器校验凭据、拒绝"凭据属于别的 WebID"、校验通过即写成 `active` 授权（**用户刚点的按钮就是显式授权**；程序发起、等用户确认的场景走 `pending`）。前端新增 `ui/src/api/task-credentials.ts`（列表/授权/撤销，响应不含秘密）+ `BackgroundPodAccess` 面板与 `useBackgroundPodAccess`：显示"已授权 · vN · 最近使用/到期"或"未授权"，一键授权（用本会话凭据）/撤销；索引重建按钮被 `service_access_missing` 拒绝时就地显示"需要后台 Pod 访问"，授权成功后**自动重试原操作**。会话凭据为此多暴露一个 `requestPodApiKey()`（只在这一次授权请求里离开浏览器）。

**落地（第 4 步第 1 片，2026-09-24）**：后台执行开始使用任务层授权。`PodAccessRequestContext.taskCredential`（`{ ownerGrant: true }` 或 `{ credentialRef, version }`）表示"这次读取必须用任务层授权"——**不设回退**：没有可用授权就直接失败，避免把"某次登记过"当成"这个任务被授权"。`OwnerPodAccess` 通过 `TaskCredentialSource` 取用（`activeFor(owner)` 取该 owner 在本部署 issuer 下的 active 授权、`forRef` 校验 owner 与冻结版本），适配器 `createTaskCredentialSource` 在 tasks 层实现，容器把二者接起来。首批迁移的入口是**索引重建**（`rebuildFts`/`rebuildVector`，`src/api/container/routes.ts`）——它们已经在用任务层授权取 Pod fetch。剩余入口（向量重建内部的 Provider 凭据读取、配额定时刷新、chatkit 后台 run、Matrix/Reconciler）仍需逐个迁移，判据仍是"在没有 API vault 的情况下完成一次真实执行"。

**落地（第 3 步第 2 片，2026-09-24）**：容器注册 `taskCredentialStore`（`src/api/container/common.ts`），只在部署配置了根密钥时存在——**无法加密就不保存**；任务库地址由 `CSS_TASK_DB_URL` 覆盖、否则按上面的派生规则。根密钥解析抽成 `loadDeploymentRootKeyProvider`（`src/api/container/index.ts`），与 API 侧的凭证 vault 共用同一份部署材料。`grant` 的 `credentialRef` 改为**按 owner+issuer 派生**（一个 owner 一个 issuer 一行，重复登记落在同一行）。

**显式授权入口**（`src/api/handlers/TaskCredentialHandler.ts`）：`GET /api/ai/task-credentials`（只回元数据，无秘密）、`POST /api/ai/task-credentials/:ref/activate`、`DELETE /api/ai/task-credentials/:ref`；全部按调用方 WebID 归属校验，别人的 ref 表现为 404。同时 `POST /api/ai/gateway/keys`（登记）在写完 legacy `saveKey` 之后**双写**一份任务层授权（`status: active`，因为登记本身就是用户的显式授权）；任务层写入失败只告警、不影响登记成功——迁移期以 legacy 为准。

**落地（第 3 步第 1 片，2026-09-24）**：`src/api/tasks/TaskCredentialStore.ts` 按上表实现，`src/api/tasks/TaskCredentialSchema.ts` 定义 `task_credential` 表（sqlite 与 pg 两套），`src/api/tasks/TaskCredentialDatabase.ts` 负责归属：显式 `CSS_TASK_DB_URL` 优先；SQLite 部署默认落在 identity 库**同目录的 `tasks.sqlite`**（独立文件，泄露其一不牵连另一）；PostgreSQL 目前仍复用同一 server 的独立连接，**独立 role/schema 属部署待办**（不在代码里猜）。

语义要点：`grant` 默认 `pending`（不执行），`activate` 后才可用；`rotate` 递增 `credential_version`，旧绑定版本不匹配即拒绝；`revoke` 只改状态留行；过期在 `lease` 时判定并落 `expired`；同一 `credentialRef` + 同密钥的重复 `grant` 视为幂等（不涨版本），换 owner/issuer 直接拒绝。`lease` 校验 owner、状态、版本与有效期，并按需记录 `last_used_at`。

约束与归属：

- 表在 Pod 之外，因此它的访问控制就是"能开多少个 Pod"的边界。决策 6 已定：`sealed_secret` **必须**再用部署侧密钥（env/KMS）加密，且只加密这一列——这样"读到表"与"能开 Pod"是两件事，DB 泄露或只读副本外流不再直接等于拿到所有用户 Pod 的钥匙。加密材料与密文分离（密钥在 env/KMS，密文在库），行内记 `sealed_secret_key_id` 以支持轮换与旧行回退解密。`Agent` 授权范围**不放这张表**，按决策 2 写在用户 Pod 里。
- **这张表归任务层，API 不共用**。共用一张表（哪怕约定"只有任务层引用"）等于 API 依然持有打开 Pod 的凭据，与第 1 节"API sidecar 不建通用长期 CSS credential vault"直接冲突。
- 因此边界必须是**强制**的，而不是命名约定：任务层使用独立 schema/表 + 独立 DB role（或独立逻辑库；RC overlay 已有"独立 logical database/schema"的先例），local 模式给任务层单独的 SQLite 文件，不复用 identity 库。
- 唯一消费者是后台执行；前台交互走 host Session，不读这份存储。API 需要触发后台工作时只传非秘密引用（`taskId` / `credentialRef` / `credentialVersion`），解析发生在任务层。

### 7.5 Inngest 侧的秘密边界与可用口子

Inngest **原生不是密钥保管方**：它只持有自己的传输/信任密钥 —— `INNGEST_EVENT_KEY`（投递事件时的认证）与 `INNGEST_SIGNING_KEY`（校验来自 Inngest 的请求），我们正是把这两个值交给自托管 server（`EmbeddedInngestService`）。应用密钥默认来自**你自己的运行环境或自有存储**；事件载荷与 step 输出会被持久化，并在 dashboard / traces 里可见，所以官方语义就是"不要把明文秘密放进去"。

它确实留了扩展口子，而且是官方维护的：

| 口子 | 内容 | 对本设计的意义 |
| --- | --- | --- |
| **加密中间件**（`@inngest/middleware-encryption`，npm 2.0.0） | 对 events、step output、function output 做端到端加密——"只有密文发到 Inngest server，加解密发生在你自己的基础设施内"；支持只解密模式、fallback 解密密钥、跨语言 | 若将来确实要把秘密放进 event/step（当前设计不做），这是**唯一**正规做法：密文 + 我们自己持有的加密密钥，绝不明文 |
| 通用 middleware 接口（本仓库已装 SDK 4.14.0 带 `middleware/dependencyInjection`、`middleware/logger`、`components/middleware`） | 可自定义序列化/加解密/依赖注入 | 需要自定义封装密钥解析时使用；不改变"只传引用"的默认设计 |
| 自托管存储插件（Postgres/Redis/SQLite 目录，我们已在配置） | Inngest server 自己的数据存哪 | 只是"它自己的数据放哪"，不是应用秘密保管；与任务层凭据表并列但互不读写 |

结论：**当前设计不需要这些口子**——事件只带 `credentialRef`/`credentialVersion`，密钥在任务层自有表、执行时解析（官方推荐模式）。若未来启用加密中间件，它的加密密钥**就是**决策 6 那把部署密钥：同一份部署材料、两处用途（启用前须单独验证：Inngest 侧仅存密文、本地可正确解密、fallback 密钥轮换可用；`@inngest/middleware-encryption` 目前**未安装**在本仓库，也未针对自托管 server 验证过）。

## 8. 验收要求与证据

| 场景 | 必须证明 |
| --- | --- |
| 普通浏览器 | 已登录、已配置模型、无 CSS sk、无 task binding，真实 Chat 与 embedding 成功；不会要求额外托管密钥 |
| 机器认证 | CSS sk 换 token、直接适用 Bearer、服务器自持 key 的 DPoP 分别成功；错误 owner、错误 proof、过期和缓存串用被拒绝 |
| 任务执行 | 业务逻辑经受控工具调用 embeddings；不取得 CSS sk/Provider secret，不直连 Provider；重启后恢复正确用户与 Agent |
| 授权状态 | pending 不执行；失败不留下 active 授权；重试/并发/轮换/撤销和旧事件重放符合版本语义 |
| Agent 隔离 | 同用户两个 Agent 的资源/模型范围不同；伪造 agentId/owner/credential 引用被拒绝，任务限制不能扩大 Agent 授权 |
| 工具越界 | 直接文件、容器列举、搜索、批量、重定向、通用查询和 shell 均不能绕过范围；embedding 可用而密钥文件读取被拒绝 |
| 运行中撤销 | 长 run 的后续操作/批次/重试被拒绝，多副本和状态存储故障同样生效；明确在途请求例外 |
| 共享凭证 | 撤销一个任务不影响其他任务；撤销 Agent 不影响同用户其他 Agent；凭证轮换不扩大权限，并发清理不误删 |
| 秘密边界 | Provider secret 不进任务 event/step、聊天记录、日志或响应；CSS 明文不进普通执行输出 |
| 内部与外部 | 同部署规范 URL/internal transport 正常；未修改外部 CSS 同样完成标准认证和 Pod 访问 |
| 旁路退场 | 旧内部 route 不提供 Pod 数据，并且原使用场景已有功能替代 |

现有测试文件可作为迁移入口：`OwnerPodAccess.test.ts`、`PodInterfaceKeyStore.test.ts`、`HostedPodRoute.test.ts`、`AiGatewayManagementHandler.test.ts`，以及 `localQleverCredentialRepository.test.ts`、`chatkit-pod-store.integration.test.ts`、`AiGatewayPodIsolation.integration.test.ts`。现有 vault 测试通过不代表目标设计通过。

**机器认证行的当前证据**（§7.1 第 1 步）：`tests/api/SolidSessionFactory.test.ts`（一次交换、DPoP key 保留、按 secret/version/issuer 隔离、过期与 401 后重换、缓存上限、loopback 下 proof 仍用规范 URL）、`tests/api/ClientCredentialsAuthenticator.test.ts`（sk 成功、拒绝与不可用分类、无 owner 的响应被拒）、`tests/api/ai-gateway/SolidCredentialSessionSharing.test.ts`（同一次交换同时服务入站认证与出站 Pod 读，Pod 收到 DPoP 证明）、`tests/api/ai-gateway/CallerPodAccess.test.ts`（直接 Bearer 可用；网关 key/invocation 主体、错误 owner、DPoP、空 token 被拒）。真实实例的六层验收（Pod CRUD、API 认证、`/v1/models`、Chat、embedding、任务恢复）尚未在本步执行。

实现后运行适用单元/集成检查、typecheck 和完整 `bun run test:integration`。按 [真实实例指南](cli-dev-testing.md) 分别记录 Pod CRUD、API 认证、模型列表、真实 Chat、真实 embedding 和任务恢复；`listed>=1` 或旧 `pod-interface-key-granted` 阶段不能代替推理结果。外部 CSS 单独验收，缺少专用索引能力不能用 embeddings 成功掩盖。

## 9. 决策记录

> 设计冲突记录：[`pod-agent-authorization.md`](pod-agent-authorization.md) 提出的"给组件类发 agent WebID + owner 在 Pod 里用 ACP 授权"
> 已被本文取代（理由见第 1 节：外部 CSS 无法理解 Xpod Agent 策略）。该文件保留为被否决方案的记录。


| # | 决策 | 结论 / 现状事实 | 待办 |
| --- | --- | --- | --- |
| 1 | 是否给 Pod 内秘密再加密 | **已定：不加密**。Pod 即静态秘密的信任边界，`SecretCellCredentialVault` 仅保留历史解密用途 | 把"加密"措辞从本文移除（已改）；上线的 `identity_pod_interface_key` 属于 Pod 之外的遗留路径，按 §7.1 第 6 步随迁移删除，不新增加密工作 |
| 2 | Agent 授权对象的存储位置 | **已定：写在用户 Pod 内**（与任务注册同资源族）；目前 `src/agents/` 无 policy/scope 持久化 | 按 `taskResource` 的资源模式新增授权记录，不新建平行 registry |
| 3 | 任务权威存储 | **已定：Pod 资源为权威，Inngest 只承载引用与运行状态**（理由见 §7.3） | pending/active 与版本字段加在 Pod 任务资源上；Inngest 侧靠幂等 `executionKey` 重放 |
| 4 | `caller_pod_access_unavailable` 是否拆分 | 一个 reason 承载"未认证"与"已认证但无出站能力" | 拆出 `caller_outbound_capability_missing`，兼容期保留旧码 + `details.capability` |
| 5 | Runtime 打开 Pod 的运行态钥匙放哪 | **已定：放任务层自己的表**（`identity_task_credential` 草案见 §7.4），与 Inngest server 的表并列在同一套基础设施（cloud 同 Postgres、local 同 SQLite 目录），Inngest 只带引用与版本。密钥不进 Pod（自锁）、不进事件/step 数据（会进调试面） | 表结构按 §7.4 落库；`Agent` 授权仍写用户 Pod（决策 2）。**归属**：该存储只归任务层，API 不共用、不读；API 只传非秘密引用。边界靠独立 schema/表 + 独立 DB role（或独立库）强制，见 §7.4。这把钥匙是 Pod 之外唯一能开 Pod 的东西，因此存储访问控制即权限边界——见决策 6 |
| 8 | Pod provider 支持范围 | **已定：只支持 CSS（随部署 CSS 与外部 CSS）。** ESS/NSS 不在范围内 | 第 2 步按"自家=静默请求级凭据 / 外部=host 直读 + 显式导入"分别落地；外部 CSS 的 API 代读需补按 issuer 解析 token endpoint |
| 7 | API 是否持久化 owner 凭据 | **已定：不持久化。** API 只在用户在场的同步路径工作，凭据随请求而来（浏览器持有自己的 client credential，或调用方带 sk/适用 Bearer）；异步任务自己管理凭据（决策 5 的任务层表）。现状的 `identity_pod_interface_key` + `storedKeyFetch` 是"能力新、归属旧"的过渡物 | 按 §7.1 新顺序执行：前台先去依赖（第 2 步）→ 任务层存储（第 3 步）→ 后台入口迁移（第 4 步）→ 停写、迁行、删表（第 5 步） |
| 6 | §7.4 的 `sealed_secret` 是否再用部署密钥加密 | **已定：(b) 加密，且只加密这一列。** 本表在 Pod 之外，按决策 1 的"Pod 是 Pod 内秘密的信任边界"并不覆盖它；DB 泄露或只读副本外流否则等于"可打开所有已登记的 Pod" | 第 4 步落表时实现：部署侧密钥来自 env/KMS（与密文分离），行内记 `sealed_secret_key_id`，支持轮换与旧行回退解密；密钥名与派生方式在该步定，并与 §7.5 的 Inngest 加密中间件共用同一份部署材料 |

本文档修订本身未修改运行代码；其后 §7.1 第 1 步的实现在独立提交中落地（`SolidSessionFactory` 等，见 §3.1）。上述机器认证行证据为单元级；按本节的真实实例要求，`bun run test:integration` 与六层真实验收仍须在第 2 步之前补齐。
