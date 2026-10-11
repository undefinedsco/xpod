# AgentFS 独立 ARM64 原生 CI

## mini 接续状态（2026-10-07）

接续源码为 `31df9741b6e31acdc598f4080eab11bbed200693`，包含整文件传输预算、Git porcelain 空格保留和 Linux 同容器绑定修复，不是已验收发行版。mini 的生产构建、测试类型检查和依赖状态检查通过；轻量 Vitest 为 29 pass / 4 mounted skip。一轮原始 `bun run test:integration` 实际退出 0，前置 30 pass、Lite 163 pass / 16 既有 skip、Full 63 pass，测试 Compose 资源已清理。这是隔离集成结果，没有完整监督器的输入快照和逐 producer 证据，不替代两轮正式证据门禁、真实 Gateway 或原生挂载验收。

mini 没有 Cargo/rustup；初次接续的 GitHub SSH 读取返回 `Permission denied (publickey)`，随后用户配置认证，公有 Xpod 与私有 Pro 的远端检查点读取均已成功。原生门禁新增监听当前 mini 分支，用远端构建取得新源码证据，不安装本地工具链。挂载 workflow 仍绑定旧冻结产品 `0e260a49ce28cb7b5cf8ee0bc4342d893cb742a8`，`accept.py --verify-native-source` 对当前源码正确拒绝 `tools/agentfs-pod` 差异。必须先得到当前源码的新双平台 native/install 产物，再更新挂载材料绑定。

`whole_ci_gate.py` 最初在 mini Docker Desktop 上因宿主不存在 daemon 的 `/var/lib/docker` 而拒绝；该失败保留，不用宿主容量代替 VM 容量。现在当该路径不在宿主时，使用已安装的 `redis:7-alpine` 的不可变 image ID 启动一个独占容量观察容器：只读挂载 daemon 存储目录、禁用网络、删除全部 capabilities、禁止提权，整轮复用同一容器，通过有界 `docker exec df -Pk` 持续采样。VM 与宿主证据目录容量取最小值；镜像缺失、输出非法、探测超时或失败均拒绝，不自动拉镜像或推断容量。结束后按精确 CID 删除并验证不存在，摘要绑定 image ID、CID 和 `cleanupVerified`；清理失败不能保留成功摘要。mini 已真实执行容量采样和精确清理验证；不代表两轮完整监督门禁或 FUSE 验收通过。初始准入失败仍写入 `admissionError`、退出 1、`ok=false` 和空 `runs`。

容量观察器的首版两轮正式监督门禁均实际退出 0，源码/运行输入快照一致、日志关闭且有哈希、各自 Compose 资源为空；证据在 `.test-data/whole-ci-desktop-20261007/`，不继承到后续源码。实测发现 Redis 镜像的 `/data` 声明会产生匿名卷，最终版以只读 tmpfs 覆盖该位置；已实际核对容器仅有只读存储 bind、无 volume 挂载并完成 CID 清理。最终版 Python 为 52 pass / 1 Linux 专属 skip。成功摘要只在观察器清理后输出；最终源码的完整集成须独立验证。

最终容量观察器的完整监督回归与加入 mini 分支触发后的提交前完整监督回归分别退出 0：每轮 preflight 30 pass、Lite 163 pass / 16 既有 skip、Full 63 pass，源码/运行输入一致、raw 哈希闭合、进程组消失、Compose 资源为空且 `capacityObserver.cleanupVerified=true`。本机证据分别在 `.test-data/whole-ci-desktop-final-20261007/` 与 `.test-data/whole-ci-prepush-20261007/`；仅属隔离集成，不替代远端原生、挂载或 GZ 真实验收。

此门禁监听 `codex/agentfs-native-acceptance` 和 mini 接续分支 `codex/migrate-mini/solidfs-20261007` 的 push，权限为 `contents: read`，不发布、不晋级 release/RC，也不调用真实 Gateway。两平台串行：`native-macos` 使用 `macos-14`，`native-linux` 在 `native-macos` 之后使用 `ubuntu-24.04-arm` 仅托管 Docker，实际 Linux 导出/重编译/测试/打包/安装/加载验收全部在固定 Bookworm 镜像内执行。脚本检查真实 host ARM64，不能通过矩阵标签冒称架构。

## Linux Bookworm 基线

支持的 Linux 目标是 Debian 12 Bookworm（glibc 2.36 + OpenSSL 3），并且在同一容器内用官方 Node 22.21.1 走 noBun 外部运行时加载。Linux job 只把 checkout 和 `RUNNER_TEMP` 挂载进容器，一切编译产物都针对容器内 glibc/OpenSSL，而不是 Ubuntu 24.04 runner 的 glibc 2.39：

- 固定镜像 `rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e`（arm64 manifest digest）。CI 先 `docker pull` 该 digest（registry 元数据即身份证明），再复用同一镜像，不重复拉取。两个容器运行都带 `--init`：构建阶段是唯一可能留下已退出子进程的入口，用真实 PID1 收尸，而不是把 group-present 当无害或放宽 wait/日志关闭/hash。
- 容器内 `bookworm-entry.sh` 先断言 `ID=debian`/`VERSION_CODENAME=bookworm`/`GNU_LIBC_VERSION=glibc 2.36`/`aarch64`，TLS 源重试安装 `pkg-config/liblzma-dev/libssl-dev/build-essential/ca-certificates/git/unzip/xz-utils/python3/curl`（`libssl-dev` 提供 `libssl3`），再装固定 SHA256 的官方 Node 22.21.1。
- `accept.py` 在任何下载/构建之前 fail-closed：Linux 必须有 `AGENTFS_BOOKWORM_IMAGE` 且严格等于上述 canonical pin，容器内部必须是 `debian 12` + `glibc 2.36`；缺失、写错、非 canonical 或 Ubuntu runner 值都直接拒绝，绝不先构建再补证据。记录的 glibc/gcc/OpenSSL/image 全部来自容器内部，不是 Ubuntu host 值。
- 加载验收（聚合 `runtime-admission.metadata.json`，每个 producer 另有自己的 `*.receipt.json`/`*.raw.log`）：`tar` 解包、`readelf --version-info`、`readelf --dynamic`、launcher/helper `--version`、`agent-fs status --json`、`node --version`、`ldd` 每个 producer 都走 `supervise.run_stage`——真实 PID/PGID、`Popen.wait`、有界 deadline、持续磁盘 guard、关闭后 raw SHA，并且**先通过 exit/signal/resourceStop/组已消失/raw 已关闭门禁再做语义解读**：非零退出但打印了看似合法的 ELF/ldd 文本的 producer 必须失败。leak producer 用显式 ready/hold 握手保证 descendant 在 parent 退出前真实存活；每个实际 Linux ready/leak `run_stage`/`run_checked_stage` 调用都带显式有限 timeout（10s），并断言 before-stop 记录中至少有一个成员是真实存活（state 非 Z/X）；只要观察到存活 descendant 就记为 `owned descendant remained after parent wait` 失败准入。清理后按实际观察分支：组已消失则 raw/hash/text 可用但仍拒绝语义准入，组未消失则 raw/hash/text 全部保留为 `None`；闭合必须来自实际清理后观察，不能由原泄漏或假定的 PID1 zombie 推断。受控 unresolved 分支另有显式标注的模拟 observer 单测（不声称真实子进程抗 SIGKILL），真实 Linux `/proc` 分支由 Linux CI 执行。聚合 metadata 逐个绑定真实 stage receipt SHA 与 raw SHA，语义元数据不能替代 producer receipt。对打包后的 helper 要求所需 `GLIBC_*` 不高于 2.36；`readelf --dynamic` 与 `ldd` 必须实际 exit 0，按 ELF 的真实 `DT_NEEDED` 清单逐项验证动态库成功解析，任何缺失、畸形或 `not found` 都拒绝；不强制 helper 加载它未声明依赖的 OpenSSL 库，也不从库名缺失推断静态 TLS。聚合元数据中的 `neededSonames` 必须与闭合的 ELF/ldd 原始证据一致，历史产物缺少新增证据时不能用旧 metadata 补作通过；`status --json` 按语义解析（`ok`、`platform`、`helperPresent`、`helperPath` 与打包 helper 实际一致、`pendingOperations` 为有限非负整数且在受控全新 session 下为 0），不是数字节数。容器内层必须是 aarch64 + Debian 12 + glibc 2.36。只含 Node、无 Bun 的 PATH 执行 `bin/xpodcli`；旧 Ubuntu 产物要求的 `GLIBC_2.39` 会在此被确定性拒绝。

## 固定输入与执行链


专用入口为 `scripts/agentfs-native-ci/accept.py`，supervisor 为同目录 `supervise.py`。输入是该次 checkout 精确 Git SHA 的产品源码，不使用私人 kit5、旧 helper 或公开 preview 的旧 source index。旧归档无法在替换 helper 后保持原始完整索引，故使用现有官方 exporter 生成全新 kit。

- Bun 1.4.2 取自官方 GitHub immutable release URL；Mac/Linux ARM64 zip SHA256 固定在脚本，来自该 release 的官方 asset digest。
- Node 22.21.1 为固定版本：Mac 用固定 commit 的官方 `setup-node` action，Linux 在 Bookworm 容器内用固定 SHA256 的官方 nodejs.org tarball；Bun/Node 是外部构建和运行依赖，不内嵌安装包。
- Rust `nightly-2026-09-30` 取自官方 `static.rust-lang.org`。先验证日期锁定的发行 manifest SHA256，再由 runner 自带 rustup 安装 minimal profile；assert compiler commit `5c543b0b8c73c7b72bc8284ced4fb22ead15734d`，官方 receipt 记录该平台 cargo/rustc 实际摘要。rustup 和系统 SDK/编译器为外部工具，不声称完整工具链可复现。
- upstream 固定 `0a014ebd4918615baff589ed17486e557e7c6a23`，官方 `export-native.ts` 使用当前 Cargo.toml/原 Cargo.lock、两已有 patches、当前 helper、recipe 和许可证。首次 registry 缓存为空，导出如实在线 `cargo vendor --locked`，没有宣称首次导出 offline，也不更换锁版本。
- kit 内 `rebuild-native.ts --verify-only` → `--out <fresh> --test`。recipe 使用隔离 Cargo home、验证后的 stage、内部 jobs2、实际 `build/test --release --frozen`。
- 核对完整 71 项清单：69 pass、0 fail、2 已声明 ignore、0 filtered。两个 ignore 是历史故障 RED 与由 parent 实际启动的 lease 子进程 fixture；parent 死亡租约测试及最新修复回归必须出现 `ok`：原子 owner.json 替换临时项的 live-reader 容忍、真实 store_owner 写-读重叠屏障、合法同属主原子替换不误报所有权变化、外来不可变绑定/外来 record inode/外来 closed 注入仍 fail-closed、注入第二个真实 RuntimeControl 的合法外来 socket locator 时 teardown 仍只清理受控 owner 的自有资源并保留外来真实 socket、受控授权 writer 与 reader 在 owner mutex 上真实互斥（reader-first 与 writer-first 两个顺序）、活跃 lease 持有者令 closed-proof 观察在真正等待持有者前返回 false，以及隔离 helper 子进程的原始 lease 描述符继承 fixture：helper 先持有唯一原始 lease open description，fork 后子进程只做 async-signal-safe 调用继承该描述符，helper 关闭自身描述符（非 LOCK_UN）后新独立 EX|NB 探针仍 EAGAIN，显式释放使子进程关闭继承描述符后探针才成功。隔离 helper 的每个 pre-release 断言/轮询/读取/探针错误都经 `LeaseChildGuard` 收敛到同一个有界、有限 `WNOHANG` 精确子进程 reap：只重试 `EINTR`，区分 `ECHILD`/未决/其它 errno，绝不做无限期阻塞等待，仅在精确 PID 真实 reap 或内核确认不存在后置 `reaped`；`Drop` 不再 panic，也不会在没有证据时声称清理成功。进程不存在只由 `ESRCH` 证明，`EPERM`/其它 errno 不算不存在。刻意 pre-release 失败模式现在在 guard 仍 armed 时真实 panic，让清理只经 `Drop` 执行（不再 pre-panic 显式清理而让 Drop 空转），并把精确 PID、自有 pipe fd 关闭、实际 wait status、`ESRCH` 缺失证据与已知自有 private socket 目录清理写入 `lease-cleanup-proof.json`；外层 helper 进程同样由 `OwnedHelper` 守护，早期轮询/断言失败不会遗留自有 descendant（该负向到正向的实际 Rust 执行仍待远程 unfiltered inventory，本地不跑 Cargo/native binary）。不能将 71 项表述为 71 pass。

- upstream 依赖的 SDK 与 CLI 原 suite 是各自独立 crate（各自提交的 `Cargo.lock` 与 dev-dependencies），helper 的 `cargo test` 只覆盖 helper 自身，不能替代它们。`accept.py` 在 helper receipt 绑定之后、打包之前新增两个有界 stage：`sdk-suite` 在 `kit/upstream/sdk/rust` 跑 `cargo test --release --locked`；`cli-suite` 在 `kit/upstream/cli` 跑 `cargo test --release --locked --no-default-features`（产品依赖 `agentfs` 时即 `default-features = false`，故以无 sandbox 特性匹配出货依赖；不新增产品依赖、不放宽锁、不筛选/串行/retry 掩盖失败）。两个 stage 都走 `supervise.run_stage` 的真实 wait/有界 deadline/关闭 raw SHA/组已消失门禁，要求 0 failed 且 passed>0，并把各自 passed/failed/ignored/ignoredTests/resultLines 计入 `final.json` 的 `upstreamSuites`；SDK/CLI 声明的 ignore 与 helper 两个 ignore 分开如实记录，静态 105/82 注解既不是数量也不是通过。
- 当前 `build.ts` 显式绑定新 helper、新 source kit、新 official receipt，随后 `verify-install.ts --archive <new archive> --expect-validation install-verified` 实际解压并执行安装验收。新 receipt 同时验证 compiler、helper、kit SHA、target、jobs2 和原始 buildArguments。

所有工具子进程使用环境白名单，剔除 runner 凭据和继承的 Cargo/Rust/proxy 覆盖。Linux 系统 prerequisites 在 Bookworm 容器内安装（`pkg-config/liblzma-dev/libssl-dev/build-essential/ca-certificates/git/unzip/xz-utils/python3/curl`）；`libssl-dev` 同时提供运行期 `libssl3`。系统包版本与 SDK 不属于源 kit 的冻结范围。

## 资源、证据和失败

主验收链的每个阶段（`bun-extract`/`toolchain`/`dependencies`/`workspace-packages`/`upstream`/`upstream-checkout`/`export`/`verify-source`/`rebuild`/`sdk-suite`/`cli-suite`/`package`/`verify-install`）都通过 `accept.STAGE_TIMEOUTS` 声明有界 producer deadline，未声明阶段 fail-closed；job 的 90 分钟上限不是 owned producer deadline，也没有每阶段的 group wait/raw closure receipt。每个 gate 启动前要求所在文件系统 fresh 可用空间至少 **4 GiB**，无本地或 CI 特例。运行时可用空间低于512 MiB，或 native target 实际 allocated bytes 超过1.5 GiB，supervisor 只停止自己持有的进程组，实际 wait 后保留失败；不把资源退出改成 pass。kit约459 MiB，加临时stage约459 MiB、target预算1.5 GiB、reserve512 MiB，工具下载安装和 JS/package 阶段额外使用空间；4 GiB 是阶段准入线，不是整条链总耗用上限。每个下游 gate 都重新检查，空间不足保持失败。官方 runner 名义磁盘规格不替代实际 fresh 检查。

每 gate 有实际 PID/PGID、wait、exit/signal、UTC/monotonic耗时、关闭后 raw SHA。成功 parent 留有同组 descendant 也视为失败。若进程组仍存在，receipt 记录信号发送**之前**与清理之后两轮的 `/proc` 组成员 PID/PPID/PGID/STATE，用来区分真实的存活泄漏与 PID1 未回收的 zombie（kill 之后的 zombie 不能解释 producer 原本留下了谁），而不是只看“组还在”。最终保存全部 tracked 文件（含 root package/bun.lock、shared src、build:packages 输入）的前后内容/类型 hash、精确路径集合、HEAD 和非 ignored Git 状态，以及源码索引、receipt 和新 archive SHA。新增/删除/改写 tracked 源码、HEAD/index 或非 ignored 状态变化都拒绝；ignored node_modules/构建输出是预期，不进入源码快照。失败不会生成成功 final.json。

artifact 只上传 evidence 明确文件白名单：关闭的日志/回执、新 source index/native receipt/final 和新安装 archive。不上载环境、node_modules、Cargo home、target、全部 `.test-data` 或私人缓存。原始日志可能含工具警告（例如 optional strip），日志保持原样，只有真实 gate 退出0和完整摘要能入准。

## 独立挂载层

当前 workflow **不运行 mount**。`install-verified` 只证明新安装产物验证；Bookworm 加载验收只证明 ELF/glibc/实际动态依赖解析与 noBun Node 启动，不证明实际 mount、RSS、NFS/FUSE、live Gateway、Chat 或公开发布。后续 mount job 需单独验证 NFS/FUSE mount 权限/工具，并显式绑定本次新安装 CLI/helper，运行已有 installed CLI/overlay 场景；任何 skip、未知挂载状态或未闭合 producer 都不能晋级。CI 的 loopback fixture 也不能冒称真实账号/Pod。

本地只运行 `PYTHONDONTWRITEBYTECODE=1 python3 tests/scripts/agentfs_native_ci_test.py -v` 和静态语法/diff检查，不安装工具、不导出 kit、不启动 Cargo。
