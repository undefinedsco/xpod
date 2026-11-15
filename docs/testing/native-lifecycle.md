# CSS RDF native 生命周期

轻量独立门禁：`bun scripts/check-native-lifecycle.ts`。只运行 accessor、engine、native client 四个测试文件，复用原 Vitest 配置和原协议夹具；不启动 Gateway、Docker、VM 或编译 native。受控 child 事件测试覆盖并发 close、exit 早于 close、强制超时拒绝及 late close。它不是独立 CSS 服务真实运行验收。

CSS 采用现有 `CommunitySolidServerCssRunner` 创建 App 并启动。没有 authority storage 时使用 `OriginalCssRuntimeAppRunner`，有时使用 `OriginalCssAuthorityAppRunner`；两条路径都保留原 App.stop，后者在其后追加角色关闭。原 Components CleanupFinalizer 在 `config/xpod.base.json` 注册同一 SolidRdfDataAccessor.finalize；local 的恢复 handler 与之合并，而非替换。此前真实 effective manager 检查已经确认该合并，不能仅按两份 JSON 的重复 id 判断覆盖。

因此现有 CSS 路径为 App.stop → CleanupFinalizer → SolidRdfDataAccessor.finalize → SolidRdfEngine.close → 原 LocalQleverNativeSparqlClient.close；没有新增第二个客户端。单独分发 CSS 模块尚未完成，独立产物必须包含同一 finalizer 绑定、原生命周期实现及合格原生运行时，不能借省略 Gateway 配置删掉 cleanup。

最小修复：autoOpen 未发生读取也关闭原引擎；关闭等待原 autoOpening；所有 native close 等待同一 flight；spawn 时记录真实 close，不能以 exit 或 stream 销毁替代释放，强制超时明确失败。I 的失败 flight 保留拒绝；其现有显式 cleanup 重试可以在实际 child close 后完成，不重新 spawn。保留 I 的 qlever_runtime_close_timeout / shutdown_failed 错误码与非零正常退出拒绝规则；不以 Fabric 的错误码替换。engine mock 重试不代表真实 native 可重启。

2026-10-14 正常 local 两次启动的四个原 ABI7 child 均在原 runtime.stop 内实际 close，第二次没有 RDF 读取，驱动自然退出。收据 `7f9045e23c9686ecdaf52842d080356f60694696380de41ac3bdb0870d6d5ff2`；这不是独立 CSS 发布、运行中真实并发 close、Matrix ABI9、Task/VM 或完整回归通过。后续独立 CSS 真实验收需新自有目录，检查原 App.stop 的 close 事件和进程自然终态，不用人工信号补救。移植前应运行轻门禁、源码/测试类型及完整集成；当前修复尚未提交，完整集成门禁未齐。

本次移植基于 I `00e929bb5a52df944c8451cc2c19c5768d0fa1a8`，既有 accessor finalize、engine opening/closing 与 native close WeakMap 已实现所需生命周期边界，保留原实现；仅同步发布 native close Promise 的最小补丁及必要测试/入口。Fabric local25 是外部历史证据，不宣称 I 的实际服务通过。
