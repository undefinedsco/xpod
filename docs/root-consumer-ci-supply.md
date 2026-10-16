# Legacy root Bun 的真实依赖供给

完整 root compatibility 是兼容分发的独立验收。模块消费成功不覆盖它的失败，root 失败也不覆盖模块结果。

## 入口和构建依据

`legacy-root-compat.yml` 保留原矩阵、七条完整包命令和原超时。Bun lane 在实际根构建成功后，由 `runRootCompatLane` 写出测试专用 `registry-build-input.original.json`，仅向 install 子进程传递 `XPOD_LEGACY_ROOT_SUPPLY_INPUT`。输入绑定实际 source/run/attempt、原构建命令及 stdout/stderr、未改变的 root 原包和既有 UI 生成观察。缺输入的普通调用仍使用原 singleton registry，不自动制造原包。

供给器核验实际 Git checkout、原构建退出/等待事实及日志哈希，并复用原 `verifyCompatSourceObservation` 接受精确的 UI 输出变化。每次 normal pack 前后完整源码输入快照必须相同。它不追加一轮根构建，不以 dist 存在或调用方的成功布尔值代替父 lane 的构建事实。

## 原包、闭包和真实 PUT

- 从实际 root manifest、workspace 原声明与精确 Git 依赖声明递归推导私有 required 集合，包含 transitive dependencies、optional dependencies 和必需 peers；不维护历史缺包清单。缺包、重复身份、版本范围不匹配或未声明的 workspace 边立即失败。
- Workspace 原包复用既有 `packWorkspacePackages`：使用本轮原构建输出执行 normal npm pack，暂时规范化 manifest 后由原 finally 恢复。不从 installed/root bundle 重打包；包身份、全部 manifest、每个 payload 文件均与 normal source/output 核对。npm 的 Windows 调用复用原 root pack 的命令选择器。
- 外部 Git 包保持独立 source。当前 extensions 的权威 pin 仍来自根声明 `497942519bc211b6b5bc684f47f41bad189cf632`。Hosted lane 从该提交独立 checkout，使用其原 frozen install、test、typecheck 和 `bun pm pack`（触发原 prepare/build）；不复制旧 Xpod 候选资格。原 manifest、source-before/after、命令事件和 normal tgz 留存。构建缓存和 checkout 在原 cache 目录，不混入 lane 上传。
- 单一验证入口复核普通文件/非链接/大小、SHA256/SRI、source/run/attempt、工具字节、原包 payload 和完整 required 集合，再复用现有 `createRegistry` 的 exact artifacts/required 机制及 `publishArtifact` 的实际 npm PUT。已声明私有名字的缺版本不会转向公网；公开程序依赖继续原 online resolver，没有新增 offline closure 或锁图。
- 保留 npm 实际发表元数据并核验依赖字段、bundle alias 的语义、SHA1 与 SRI。不会手拼 packument、修补元数据、删依赖、替换平台包身份或向公网发布。

## 消费与证据边界

实际 Bun install 使用未改写的 root 原包，保留原 auth/runtime smoke，并复用现有 registry checker 的 bundle 实字节及 in-bundle CJS/ESM 导出门槛。每条 lane 的 schema 2 证据保留 `archives/` root tgz、私有原包、normal source/build 绑定、原 PUT 元数据和 bundle proof。聚合器重新核验这些原件；仅有旧元数据、缺原包或缺 bundle proof 不能通过。

所有新增归档是 normal producer 原件。单个私有归档上限 8 MiB、合计 32 MiB、最多 64 个；没有提高原命令 deadline 或 workflow 预算。父 install 的原始 stdout/stderr 仍是原有观测范围；命令事件不冒充额外子进程 raw/EOF/group 证明，亦不授予 source/native/legal/release 资格。原归档留存功能来自已审 archive-retention-v2：失败时保留现场，不按可能被替换的路径删除数据。

本地使用小型合成源码夹具核验接线、源码恢复和失败边界，并通过测试子进程的私有官方 Node/npm 执行 tiny fixture 的真实 npm pack、loopback PUT 和回读；不运行真实根构建/安装。产品 normal npm pack、外部 producer 和完整 Bun registry install 必须由新不可变候选的 hosted CI 证明；旧来源、旧失败和模块消费结果均不能替代。

## v2: private AFS source and same-workflow original JS supply

AFS source is intentionally private and has no generic workspace pack contract.
The legacy workflow now has one POSIX `legacy-root-normal-afs` job. It executes
`check-cli-publication.cjs` and the existing AFS `build-client-publication.ts`
with the normal CLI/client archives as explicit materials. The existing AFS
emitter owns the public distribution manifest. Source `private`, source files,
normal CLI producer checkout checks and POSIX command closure remain intact.
All lanes depend on the successful job; Bun lanes acquire its unique
source/run/attempt artifact through its exact artifact ID and digest. Public
registry dependencies and every lane's original root build, pack, real install,
bundle byte/export checks and runtime gates retain their existing behavior.

The independent-product acquisition API still requires a completed successful
workflow. Its separate legacy same-run entry additionally checks the current
GitHub runtime run/attempt, fixed workflow (or the existing candidate caller with an exact referenced legacy workflow/source binding), successful fixed producer job,
artifact name/ID/digest/size, job timestamp window and GitHub original metadata.
Both paths use the same bounded download and ZIP parser. Legacy projection
admits only the index and its exact `cli/`, `afs/`, `producer/` regular members,
with ZIP budgets of 16 MiB packed, 40 MiB expanded, 4096 members and 8 MiB per
member; links, special files, duplicate names, unsafe paths and extra files fail.
Original native paths remain in receipts. Consumers and retained-lane readers
map canonical members locally, including on Windows, and rehash all originals,
source snapshots, tools, command raw logs, manifests and normal archives.

For the historical root-manifest fixture and current source graph, the eleven
private identities use seven workspace normal packs, two normal CLI/client
publications, one standalone AFS JS emitter and one independently pinned external
Git producer. `tests/fixtures/legacy-root-658.package.json` is the unmodified
historical manifest used only for recipe admission tests; no historical product
is reused for a new candidate. Small synthetic archive/HTTP/ZIP tests are local
contract checks. Hosted production, actual Bun installation on each platform
and the full integration gate remain Root-owned and have not been established
by these fixtures. This patch does not qualify native helpers or a release.


## v3: explicit Node child and failure diagnostics

The workflow's Bun entry explicitly probes the Node 22 selected by setup-node,
records its actual executable and runtime through the existing closed command
runner, and launches the original CLI producer with that exact executable.
Readers require the same qualified Node command; Bun is not admitted as the CLI
producer runtime. A bounded test starts the same orchestration seam under actual
Bun and inspects the actual Node child and closed raw output, without executing
product builds. `EVENT_HEAD_SHA` is the existing shared producer metadata key.

An unconditional, separately named diagnostics upload retains the exact normal
CLI evidence directory and POSIX output, including failures. The successful
supply artifact alone owns the artifact-ID/digest outputs. Ordinary successful
`needs` and the successful producer-job checks still prevent all consumers from
using a failed producer or diagnostic artifact.
