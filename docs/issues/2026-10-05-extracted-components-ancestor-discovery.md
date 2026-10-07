# 单文件运行包的 Components 发现范围越过提取根

日期：2026-10-05。状态：修复与真实隔离启动验证进行中；不是 0.4.26 发行通过记录。

## 真实 RED

源 `71243cd91608cccbd488eef0df7acf54411ba4a1` 的实际 0.4.26 macOS zip 冷启动曾进入 Local Gateway，但后续独有 profile 连续获得 `/service/status` 503，窗口在原 60 秒预算内未出现。Desktop 原来忽略子服务 stdout/stderr；等价私有 CLI 诊断捕获 CSS 注册组件后失败：`Could not create the server` / `Cannot find module 'rdf-vocabulary'`。Cloud 注册另有 AbortError，它不能解释这个模块错误。

实际提取根中的官方 builder 查询得到 2696 个 package，其中 2649 个在提取根外；同一个 `@solidlab/policy-engine@0.0.2` 同时出现包内 `dist/__bundle__.cjs` 与工作区原始 `dist/index.js`。因此这里存在真实祖先目录发现，不仅是堆栈 source-map 显示。不能仅凭某次条目顺序或有工作区依赖的启动成功，证明安装包自包含。

`rdf-vocabulary@1.0.1` 已在 `bun.lock`，是现有 CSS 和 policy-engine 的运行依赖；没有增加新依赖的理由。提取包内 policy-engine 主入口已经由 esbuild 打包。需要同时核对 Components 的发现根和实际构造入口，不能把补一个包名作为通用修复。

## 生态契约与最小修复

当前安装 `componentsjs@6.4.0`，其公开 `ModuleStateBuilder.buildNodeModuleImportPaths(mainModulePath)` 会生成全部祖先目录，再递归读取其中的 node_modules。Xpod 现有 `createPackageRootPreferredModuleState` 仅让主 Xpod 的 components/context/importPaths 优先，不能排除祖先同名依赖。

只在生成单文件入口已经设置的内部 `XPOD_BUN_SINGLE_RUNTIME=1` 模式，复用官方 builder 的公开方法，把发现入口限定为实际已提取 `mainModulePath`，并拒绝 realpath 越过该根的依赖。普通 Node/Bun 开发模式保留生态查找。该标记不是新增用户配置，服务、身份或 Pod 地址规则不变。

回归用真实 builder 和临时文件构造更高版本祖先 component，同样的包内 component 应仍唯一来自提取根；同时保留普通模式主 Xpod 优先和原 JWK 回归。修后同一实际 712 cache 查询为 47 个包、0 个根外包，policy-engine 主入口来自包内 bundle。这个查询不是完整 Gateway 通过。

实际单文件 CLI 的 `__internal-css` 走官方 `AppRunner.runCli → createCli → create`，此前没有消费 runtime runner 的 moduleState。仅修 builder 的第一次工作树包隔离启动仍失败：sandbox 实际拒绝读取工作区 `dist/components/context.jsonld`。因此内部 CLI 也复用同一 builder，通过官方公开 `create` 扩展点注入提取根与 moduleState；官方核心 CLI 参数解析、shorthand、完整 argv 和 runCli 启动链保留，普通开发 CLI 不注入。回归实际调用安装的 CSS `createCli/runCli` 验证这条联动，不能把独立 builder 查询当入口已修复。

真实验证必须对实际打包可执行文件使用现有 macOS sandbox-exec，拒绝工作区 node_modules/src/dist 读取，允许私有包/cache/profile，提供同一实际自带 QLever 路径，并独立记录 full CSS/Gateway、QLever、进程清理。原 712 包和失败记录保留；最终发行仍需新 SHA 的完整回归、真实安装包和 RC 必需门禁。

2026-10-05 修复后诊断：712 加本批工作树重建的单文件 binary（SHA256 `7087dd88083edcf2119ec96b96ac23b6e6051cf76177843ef5e8ccecb950776f`）在上述 OS 拒绝策略、独有 cwd/profile 下，5.669 秒获得 `/service/status` 200；`/api/service-info` 200 且 edition=local；CSS OIDC discovery 200 且 issuer 精确匹配。实际自带 QLever 被观察为本轮子进程树成员。停止 actual exit=0、signal=null，独立 OS 身份检查残留 PID 为零，driver actual exit=0。原模块缺失和 EPERM 工作区读错误均未再现。

这不是正式新 SHA 的安装包验收：工作树 binary、packaged window/IPC/self-update、managed 多 Pod 权限与全部 provider 仍需各自正式证据。前一诊断的 API 探测 502、另一次私有 observer 误读无 command 的进程 identity 对象导致失败均保留；不能据首次 CSS readiness 代替 API 通过。本次仅观察 QLever 实际启动，未重新声称其 16 项语义测试。CLI 与 fixture 合并回归 14 项、build:ts、typecheck:test 的实际退出均为 0。

## 独立工具缺陷

验收 fixture 在 `app.close()` 后再调用 `app.process()`，会读取已经 disposed 的 Playwright dispatcher；Bun 与 Node 对照都出现该问题。修复保存 launch 时的真实 ChildProcess，并用同一引用/OS 身份检查退出。窗口等待与产品已有 60 秒冷启动预算对齐，不延长产品预算。真实子进程 RED/GREEN 与窗口/Gateway 的失败过程分别保留，关闭问题修复不代表安装包启动通过。

另一次等价 CLI 诊断遗漏 Desktop launcher 已提供的 QLever 路径，产生 API QLever 启动错误；该错误不能归为产品 QLever 缺陷。隔离验证必须补齐既有 launcher 参数；此前真实打包 QLever 的 16 项语义及搜索/移动/授权结果保持其有限范围。
