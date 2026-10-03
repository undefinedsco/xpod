# AgentFS 独立 ARM64 原生 CI

此门禁仅监听 `codex/agentfs-native-acceptance` 分支 push，权限为 `contents: read`，不发布、不晋级 release/RC，也不调用真实 Gateway。两平台串行使用 `macos-14` / `ubuntu-24.04-arm`，脚本检查真实 host ARM64，不能通过矩阵标签冒称架构。

## 固定输入与执行链

专用入口为 `scripts/agentfs-native-ci/accept.py`，supervisor 为同目录 `supervise.py`。输入是该次 checkout 精确 Git SHA 的产品源码，不使用私人 kit5、旧 helper 或公开 preview 的旧 source index。旧归档无法在替换 helper 后保持原始完整索引，故使用现有官方 exporter 生成全新 kit。

- Bun 1.4.2 取自官方 GitHub immutable release URL；Mac/Linux ARM64 zip SHA256 固定在脚本，来自该 release 的官方 asset digest。
- Node 22.21.1 使用固定 commit 的官方 setup-node action；Bun/Node 是外部构建和运行依赖，不内嵌安装包。
- Rust `nightly-2026-09-30` 取自官方 `static.rust-lang.org`。先验证日期锁定的发行 manifest SHA256，再由 runner 自带 rustup 安装 minimal profile；assert compiler commit `5c543b0b8c73c7b72bc8284ced4fb22ead15734d`，官方 receipt 记录该平台 cargo/rustc 实际摘要。rustup 和系统 SDK/编译器为外部工具，不声称完整工具链可复现。
- upstream 固定 `0a014ebd4918615baff589ed17486e557e7c6a23`，官方 `export-native.ts` 使用当前 Cargo.toml/原 Cargo.lock、两已有 patches、当前 helper、recipe 和许可证。首次 registry 缓存为空，导出如实在线 `cargo vendor --locked`，没有宣称首次导出 offline，也不更换锁版本。
- kit 内 `rebuild-native.ts --verify-only` → `--out <fresh> --test`。recipe 使用隔离 Cargo home、验证后的 stage、内部 jobs2、实际 `build/test --release --frozen`。
- 核对完整 60 项清单：58 pass、0 fail、2 已声明 ignore、0 filtered。两个 ignore 是历史故障 RED 与由 parent 实际启动的 lease 子进程 fixture；parent 死亡租约测试及最新两个修复回归必须出现 `ok`。不能将 60 项表述为 60 pass。
- 当前 `build.ts` 显式绑定新 helper、新 source kit、新 official receipt，随后 `verify-install.ts --archive <new archive> --expect-validation install-verified` 实际解压并执行安装验收。新 receipt 同时验证 compiler、helper、kit SHA、target、jobs2 和原始 buildArguments。

所有工具子进程使用环境白名单，剔除 runner 凭据和继承的 Cargo/Rust/proxy 覆盖。Linux系统 prerequisites 复用现有 native Linux build 所需 `pkg-config/liblzma-dev/libssl-dev/build-essential`；系统包版本与 SDK 不属于源 kit 的冻结范围。

## 资源、证据和失败

每个 gate 启动前要求所在文件系统 fresh 可用空间至少 **4 GiB**，无本地或 CI 特例。运行时可用空间低于512 MiB，或 native target 实际 allocated bytes 超过1.5 GiB，supervisor 只停止自己持有的进程组，实际 wait 后保留失败；不把资源退出改成 pass。kit约459 MiB，加临时stage约459 MiB、target预算1.5 GiB、reserve512 MiB，工具下载安装和 JS/package 阶段额外使用空间；4 GiB 是阶段准入线，不是整条链总耗用上限。每个下游 gate 都重新检查，空间不足保持失败。官方 runner 名义磁盘规格不替代实际 fresh 检查。

每 gate 有实际 PID/PGID、wait、exit/signal、UTC/monotonic耗时、关闭后 raw SHA。成功 parent 留有同组 descendant 也视为失败。最终保存全部 tracked 文件（含 root package/bun.lock、shared src、build:packages 输入）的前后内容/类型 hash、精确路径集合、HEAD 和非 ignored Git 状态，以及源码索引、receipt 和新 archive SHA。新增/删除/改写 tracked 源码、HEAD/index 或非 ignored 状态变化都拒绝；ignored node_modules/构建输出是预期，不进入源码快照。失败不会生成成功 final.json。

artifact 只上传 evidence 明确文件白名单：关闭的日志/回执、新 source index/native receipt/final 和新安装 archive。不上载环境、node_modules、Cargo home、target、全部 `.test-data` 或私人缓存。原始日志可能含工具警告（例如 optional strip），日志保持原样，只有真实 gate 退出0和完整摘要能入准。

## 独立挂载层

当前 workflow **不运行 mount**。`install-verified` 只证明新安装产物验证；不证明实际 mount、RSS、NFS/FUSE、live Gateway、Chat 或公开发布。后续 mount job 需单独验证 NFS mount 权限/工具，并显式绑定本次新安装 CLI/helper，运行已有 installed CLI/overlay 场景；任何 skip、未知挂载状态或未闭合 producer 都不能晋级。CI 的 loopback fixture 也不能冒称真实账号/Pod。

本地只运行 `PYTHONDONTWRITEBYTECODE=1 python3 tests/scripts/agentfs_native_ci_test.py -v` 和静态语法/diff检查，不安装工具、不导出 kit、不启动 Cargo。
