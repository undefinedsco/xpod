# Account provisioning 修复计划（最新 main）

基线：`origin/main`，`b25d0eee`。旧工作区保留，不迁入其冲突和 UI 补丁。

## 当前证据

- `ui/src/utils/pod.ts` 仍在 Account 读取/创建流程中请求相对 `/provision/status`；Cloud CSS 不提供此 Local Gateway 接口。
- `lookupProvisionScopedWebIds` 将 HTTP 失败、无效 JSON/结构解释成空列表，FirstPod 可能据此创建。
- main 已有 provision receipt 和 canonical binding 实现，不能按旧分支结论整体重写。
- 截图中的 400 无响应体证据，不能直接归因于同一个 404。

## 边界及最小修改

1. 先补回归：Cloud/Standalone Account 不探测 Local、显式 Local scope 不被当前页面覆盖、过期 scope 不降级、查询失败不创建。
2. Account scope 只消费当前交互/显式创建上下文；删除该 resolver 的网络探测。Local host 发起登录时的 discovery 不在本次删除范围。
3. SP 查询必须成功且响应结构有效才允许判定空绑定；保留 canonical storage URL 校验。
4. 对照最新服务端协议，不将短期凭据失效直接解释为持久绑定消失。
5. 运行定向行为测试、类型检查、完整集成入口；分别记录失败和实机验收缺口，不声称已经部署。

本计划最初只覆盖 provisioning；后续用户要求的 Account Web 视觉修复单独记录在 [Web Account 计划](2026-09-05-web-account-rc.md)。不改部署、数据库、QLever、生产凭据；不添加依赖或配置项。

## 实施结果

- `pod.ts` 删除 Account 页自行探测 `/provision/status` 的路径，不根据 hostname 判断创建目标。
- `resolve-xpod-account-index.ts` 保留宿主初始化的既有 Local discovery；只有成功确认 managed gateway 后，才为当前 Window 注册本机 scope 刷新能力。普通 Cloud 页不注册。Local 暂未注册完成时不阻塞 CSS Account 登录，但创建失败关闭。
- 服务端活动 OIDC 上下文仍优先于 Local host、调用方和缓存，不覆盖当前交互的 SP。
- 过期 code 不作为可用凭据返回，也不通过清除失败上下文让重试变成无 scope 创建。新的无 scope OIDC 交互仍清掉上一轮上下文。
- Account 列表读持久绑定不因旧创建 code 过期而失败；新建动作单独检查 scope。
- `storage-scope.ts` 与 `provision-scope.ts` 共用查询/校验逻辑；Cloud 页使用分配的 canonical SP 域名，不再使用 code 中的历史 loopback 地址。查询失败和畸形响应不会解释为空绑定。
- 同步 `static/app` 构建产物，没有修改视觉组件或样式。

## 验收边界

- 定向 Vitest：9 文件、127 项通过（包含真实组件事件与请求断言，但不是生产浏览器会话）。
- 根 TypeScript、UI TypeScript + Vite 构建、改动生产文件 ESLint、`git diff --check` 通过。
- 最终 `bun run test:integration` 退出码 0：lite 27 文件通过/3 文件跳过、149 项通过/6 项跳过；full 4 文件、45 项通过（含 Cloud、Local、Standalone 测试栈）。在本地隔离运行栈执行，不能称为用户当前生产实例或真实上游 Chat 验收。
- 现有 React act、依赖 eval/大 chunk 和运行时警告没有在本修复中扩展处理。
- 截图中 400 的具体响应体尚不可得，不能将上述修复当成该 400 已定位/修复的证据。
- 后续架构工作：宿主发现仍沿用现有 loopback 启动逻辑；LAN/远程宿主的显式能力声明、短期 code 与服务端持久目标选择彻底解耦，不在这次最小修复中宣称完成。

## 2026-09-06 追加状态修复

- Local discovery 的错误与“明确非 managed”区分：失败不得 fallback 到另一 authority；重试重新解析初始化。非 loopback Cloud 不探测，Standalone 的明确 404 / managed:false 保留。
- 注册与手动创建复用本机 prepare receipt，Cloud Account bindings 按已认证 Account 的 PodStore 归属返回远端 SP 绑定；Local 仍限本机范围。
- 过期 code 只保留目标元数据，已有 exact durable binding 不要求新的创建凭据。详见 [整体审查 §8](../specs/2026-09-06-auth-frontend-redesign.md)。
- 真实账号已分阶段完成 Pod 创建及恢复到 Dashboard；canonical SP 是 Cloud 分配域名。新服务端代码尚未部署，不能把已有 runtime 的恢复结果当作新 RC 三模式通过。
