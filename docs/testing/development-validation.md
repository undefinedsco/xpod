# 开发验证与冻结回执

本机入口：`bun run validate:dev quick --plan --base origin/staging` 先显示改动、选择理由和命令；去掉 `--plan` 并提供 `--environment local-r1` 执行。普通文档只检查 diff；流程文档与 workflow/驱动跑脚本契约；UI 跑 UI 与依赖；后端跑类型与定向测试，无法可靠映射时扩大单元范围；公共包、lock、权限/存储、未知影响保守覆盖下游。边界变化还需实际 compiled/IPC/ABI 探针，不能用源码 mock 代替。允许人工追加更广门禁。

准备提交时冻结输入，先完成适用的类型/定向/安装验证，再执行一次：

```sh
bun run validate:dev frozen --environment local-r1
bun run validate:dev check --environment local-r1
```

`frozen` 运行完整 `bun run test:integration`；第二次相同输入只校验并复用成功回执。`check` 不执行测试，没有有效回执即失败。提交只改变 Git 元数据时不失效。产品、测试、驱动、构建配置、lock/补丁、工作区源码（包括未提交和非忽略未跟踪文件）、平台、工具链或环境修订变化使回执失效；失败、取消、未完成、执行中改变输入均不能复用。默认使用宽输入集合，宁可多验，不能漏验。

若 broad quick 已在同一输入和环境成功执行完整集成，`frozen` 从受控签名回执提取该组结果，不再跑第二次。`dist`、桌面 runtime/release 和 UI 生成的 static bundle 是构建输出，不充当源码输入；quick 另校验 static 输出摘要。冻结源码集成与实际归档验收分别绑定，安装/compiled 产物的版本、SHA、归档摘要/size 改变必须重验对应产物组，不能拿源码回执声称新包通过。

环境标识是调用方提供的**非敏感修订**，不是 Secret 值。外部夹具、安装包、运行实例或配置变化必须更新它。不同 OS/运行时、本机与 CI、源码与安装包不能互认；入口不读取 `.env`、用户数据或凭据，因而不能自动发现其内容变化。真实安装和产物验收单独绑定版本、SHA、摘要与 size，不能仅凭源码回执复用。

回执与本机 HMAC key 在忽略目录 `.test-data/development-validation/`，key 权限 0600。唯一当前摘要与 `events.jsonl` 历史分开；受控入口校验签名、命令和当前指纹，不接受随意编辑的 JSON。本机签名用于防止误把外来回执当成本轮成功记录，不是对拥有本机文件权限者的安全边界。任何 CI、RC、正式 release 都不读取此开发回执，exact staging SHA 的正式门禁继续独立运行。

`bun run build:packages` 在同一工作区按 workspace 依赖闭包顺序构建。可附加包名只构建该包与上游，如 `bun run build:packages @undefineds.co/tasks`。只有源码、root 配置、lock/补丁、构建 helper、工具链、平台、上游与 dist 内容摘要一致才复用；缺失或篡改输出重建。每包实际执行次数与耗时写入 `.test-data/workspace-builds/events.jsonl`。不共享 node_modules/dist，不新增跨 job 缓存；QLever 的现有完整缓存与新 smoke 保持原契约。
