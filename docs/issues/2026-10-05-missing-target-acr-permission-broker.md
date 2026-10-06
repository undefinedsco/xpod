# 新资源继承 ACP 时桌面服务授权失败

2026-10-05 的真实独有 Electron 夹具以 Cloud WebID 登录，绑定两个独立 Managed Local Pod。本机没有公网路由。候选 Gateway 的 service-access descriptor 返回 200，29 个资源按当前权威 Pod 解析成功；点击「允许 Xpod 访问」创建首个 credentials RDF 文档，但目标 ACR 的 HEAD/GET 为 404，父根 ACR 为 200，权限更新没有发起任何 ACR PUT，`universalAccess.setAgentAccess` 返回 null。原安装 App 未运行或修改。

现有 `@inrupt/solid-client` 3.0.0 的 `getAclServerResourceInfo` / `getAcrUrl` 仅在目标 ACR 存在且响应声明 ACP 类型时选择 ACP；缺失目标 ACR 转入 WAC 分支。CSS 的继承 ACP 允许目标 ACR 不存在，因此不是凭据或模型发现故障，也不是 drizzle-solid 存储关系能力缺口。共享 permission broker 只创建数据资源，遗漏初始化目标 ACR。

官方 API 对已有 ACR 的操作见 [Inrupt ACP 文档](https://docs.inrupt.com/guides/access-control-policies)、[universalAccess API](https://api.docs.inrupt.com/docs/developer-tools/api/javascript/solid-client/modules/universalAccess.html)。安装版本没有公开的新 ACR 初始化函数；mock helper 不能用于产品。初始化使用已有公开 `createSolidDataset`、`createThing`、`addUrl`、`setThing`、`saveSolidDatasetAt`，继续由原 universalAccess 修改服务策略。

[ACP draft 的有效策略与服务器声明](https://solid.github.io/authorization-panel/acp-specification/) 和 CSS `AcpHeaderHandler` 的契约：数据响应的 `Link rel=acl` 指定目标 ACR，缺失 ACR 的 404 响应仍声明 `acp:AccessControlResource` 类型。CSS 使用的 `@solidlab/policy-engine` `ManagedAcpRepository` 收集目标及全部祖先的 ACR，父 `memberAccessControl` 不因空目标 ACR 而被删除或截断。

修复边界：只对服务器声明的缺失目标 ACR 条件创建含 `rdf:type` 与 exact `acp:resource` 的空图，不猜 ACL 地址、不复制父策略、不构造额外 owner 授权、不改容器权限。`If-None-Match: *` 防止覆盖并发创建；412 重读真实目标 ACR，其他失败保持拒绝。已有目标 ACR 及其他 agent 策略交给原生态 API，目标关联不一致拒绝。JSON 资源初始化为合法空 JSON，已有内容不重写。

真实私有协议探针已证明空目标 ACR 后原 owner GET 200/正文一致、ACR GET 200、PUT 205，服务精确读写授权和撤销读回均正确；该专项证明不等于完整桌面、多 Pod 操作、RC 或稳定发布完成。完整证据留在私有 `.test-data/sol-release/provider-acceptance-026/`，不包含于发行源。


重复授权暴露了独立的底层 no-op 观察：第一轮真实桌面 29 个目标 ACR 条件创建均为 201，29 个生态 grant PATCH 均为 205；第二轮首个已授权目标的 PATCH body 只有 1 字节换行，返回 400 `BadRequestHttpError/H400: prepareUpdate requires a SPARQL graph update`。`@inrupt/solid-client` 3.0.0 的 `setAgentAccess` 在 direct modes 未变化时仍保存未变的图，所以产生空 SPARQL 更新。[W3C SPARQL 1.1 Update 的请求定义](https://www.w3.org/TR/sparql11-update/#terminology)允许零个 operation；真实换行请求没有图 mutation。底层拒绝空更新的协议/存储兼容边界没有在本批修复，不能把 broker 幂等称为 native 修复；该观察也不是 exact-resource 检查失败。

broker 先用公开 `universalAccess.getAgentAccess` 检查 direct modes，已满足请求时只读、不再 set；缺权限仍使用原生态 setter，只增加声明的 read/write/append，不清除既有 control。安装版本 ACP getter 只读取当前 ACR direct policies，明确尚未支持外部资源/祖先策略；本实现不把其返回值当作服务器有效继承权限，不复制父模式。

同一 capability 的临时 attribution 记录本次实际改变的原 direct modes，撤销只恢复这部分模式。skipped-existing 不改，其他 agent 策略仍由生态 API 保留。撤销前重新核对全部目标的 current direct modes；capability 重建或未知旧授权返回明确未撤销，模式已由外部修改也拒绝恢复旧快照。记录不持久化，不作为公共策略事实；仅模式一致性检查不宣称图级并发事务或对所有政策变更防篡改。

调用兼容审计：本仓库产品中该共享 capability 仅由 AI 连接 host 提供，controller 当前只调用 ensure；generic revoke 只有测试调用。系统设置的跨挂载/重启授权撤销使用既有独立 `createServiceAccessPermissionCapability`，本批未改变该产品流程。未来若共享 broker 增加跨重启撤销产品流程，必须先为真实持久策略归属建立共享契约，不能把旧既有 agent 授权默认为新 capability 所有。

新增 provenance/no-op 回归先 RED，再 21 项实际通过（包括原公共 RDF API/headers 初始化测试）。真正两轮 29 资源桌面授权、同 Pod 后续使用和最终发行门禁仍待，旧第一轮 grant 成功与第二轮失败分别保留。
