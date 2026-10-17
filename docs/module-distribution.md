# CLI 与可选模块的分发规范

本规范落实用户决定：Xpod 是总产品，`xpod` 是独立发布的 CLI；CSS、API、AFS 按需下载。包边界、依赖和发布以本文为准。内部职责仍按 AGENTS.md：CSS 处理 Solid 协议，API 处理管理接口，共享服务处理业务逻辑。

## 包与依赖方向

| 产物 | 所有权与默认安装内容 | 依赖限制 |
| --- | --- | --- |
| `@undefineds.co/xpod-cli` | `xpod` 命令、交互与输出、模块管理；通过共享运行包使用认证与 Pod HTTP | 不依赖 CSS/API/AFS 实现、UI、Agent SDK、数据库引擎或原生 helper |
| `@undefineds.co/xpod-client` | 认证上下文、凭据存储、CSS 账户与 OIDC 会话、原始 Pod HTTP；无命令与展示行为 | 运行时不依赖 CLI、服务或 AFS；认证 SDK 通过既有 peer 契约提供 |
| CSS 模块 | Solid 协议处理、Components.js 配置及需要的存储引擎 | 可依赖共享业务/存储 adapter，不依赖 CLI 实现 |
| API 模块 | 管理/业务 HTTP 入口及运行依赖 | 可依赖共享服务，不直接穿透 CSS 实现 |
| AFS 模块 | 目录客户端、挂载/搜索/工作副本能力和平台 helper | 连接远端 Pod 时不要求本机 CSS/API；服务端目录扩展依赖 CSS 的授权/存储契约 |
| 共享模块 | schema、协议或业务服务，按既有所有权规则归属 | 使用包的公开接口，禁止跨包引用源码；schema 继续归 models |

入口与功能模块分别版本化。模块不是独立产品，不另造凭据库；认证实现与凭据存储保持一个权威来源。共享认证与 Pod HTTP 的源码归 `packages/xpod-client/src`，CLI 命令、提示与输出归 `packages/xpod-cli/src`。CLI 的 `./client` 公开接口保留转发兼容，根 `src/cli/lib` 同样只保留 adapter；不得在转发层恢复实现。`auth-helper` 含交互提示，仍归 CLI。CJS 与 ESM 必须引用同一个运行库，保持错误类、会话和认证缓存身份。

共享运行包的认证 SDK 是可选 peer：原始 HTTP 与错误类型入口不提前加载它，真正需要 SDK 的认证操作按需加载。CLI 宿主通过同一 SDK loader 接口提供其产物中已绑定源码与通知的认证 SDK，保留默认安装后的 OAuth 能力，不要求用户另装 SDK。程序消费方未注册宿主实现时，通过随包交付且不参与 bundle 的 `peer.cjs` 加载真实 peer；解析以实际安装目录为准，并与 `./session` 共用同一 SDK 实例。默认 loader 缓存成功和失败，宿主 loader 一旦绑定或开始加载就不能更换，显式宿主失败不回退到其他来源。真实 `Session` 构造器由运行包的显式 `./session` 子路径导出，保持 SDK 类身份。旧 CLI `./client` 保留其 `Session` 值导出，因此使用这个完整 SDK 兼容接口的程序须安装 peer；不能用代理类替代 SDK，也不能把完整接口的要求反向施加给默认 CLI 安装。

AFS 的 SQLite、工作副本与目录接口属于共享运行库；命令入口单独构建，不得让共享库反向加载 CLI 命令。命令展示通过 CLI 的窄 `./output` 构建接口复用同一份实现，CLI 是这条构建路径的工具依赖，不是 AFS 的运行依赖。共享错误类仍来自 `xpod-client`，不得在命令 bundle 中生成第二个类。

服务启动及内部 CSS/API 子进程使用 `src/runtime/service-entry.ts`，完整兼容 CLI 仍使用 `src/cli/index.ts`。这两个入口对应不同产物的依赖面：服务产物只交付服务运行闭包，兼容 CLI 保留完整命令及其依赖。仅改变启动时的动态 import 不足以证明分离，必须检查实际单文件输入、npm manifest、安装后的依赖和产物库存。拆分迁移期间的旧服务兼容包仍可依赖 CLI，但不得据此声称服务产物已完成裁剪。公开 npm 兼容包通过真实版本依赖和标准 `bundledDependencies` 保留完整命令及模块接口。内部服务产物的 `runtime-packages/*.tgz` 仅用于外层解包后的 Bun 生产安装，库存分别绑定公共 tarball、源码 manifest 与规范发布 manifest 的摘要；这个内部传输方式不作为公开 npm 安装契约。两个产物分别验证预算、实际安装与运行。

## 用户操作与下载

```sh
xpod --help
xpod auth --help
xpod module list
xpod module install afs --version 0.1.0
xpod afs mount ...
xpod module remove afs
```

安装 CLI、看根帮助、登录、调用原始 Pod HTTP 或列出模块，不下载可选模块。首次运行 `css`、`api`、`afs`（兼容命令 `agent-fs`）时下载该模块。首次解析 `latest` 后保存确切版本；再次使用复用已选版本，不在每次命令执行前检查更新。更新只通过显式 `module install` 完成。下载失败、版本/平台/API 不匹配、文件损坏都明确失败，不静默启动其他版本、引擎或整套服务。

安装目录为 `~/.xpod/modules/<id>/<platform>-<arch>/<version>/`，唯一当前指针为同平台 `current.json`。模块与用户 Pod、凭据、工作副本数据分开；删除模块不删除用户数据。不允许同时修改/运行同一平台模块的可变安装状态。

## 模块产物契约 v1

唯一能力声明在 CLI 的 `module-catalog.ts`，不写进用户 Pod。标准包名为 `@undefineds.co/xpod-<id>-<platform>-<arch>`，目前 id 为 css/api/afs，平台为 darwin/linux，架构为 arm64/x64。后续扩展在同一声明与同一安装接口内完成，不按 id 另开下载路径。

模块是自包含 npm tarball，运行依赖和原生 helper 随模块产物交付；安装不执行 lifecycle 脚本，也不在用户设备上编译。`package.json` 的 name/version 与 registry 元数据一致，并声明：

```json
{
  "xpodModule": {
    "schemaVersion": 1,
    "id": "afs",
    "cliApiVersion": 1,
    "platform": "darwin",
    "arch": "arm64",
    "entry": "dist/entry.mjs",
    "files": [
      { "path": "dist/entry.mjs", "sha256": "<64 hex>", "size": 1234, "mode": 420 }
    ]
  }
}
```

`files` 覆盖除 package.json 外的全部普通文件，包括 helper、LICENSE/NOTICE 和需要的源码材料。entry 是库存内的 Node 兼容 `.mjs`，通过当前 Bun/Node 运行；模块自行调用自己的 native payload。接口 v1 传递 argv、继承环境与 stdio，并传播退出状态；不通过 argv 或安装记录传递凭据。关闭的服务路径不得回落到另一模块。统一运行计划、Gateway 路由与 readiness 由独立服务宿主负责，接口见下文；CLI 下载与安装成功仍须与宿主启动、真实模块功能分别验收。

下载使用 npm registry 的 SHA-512 SRI；验证后才解包。拒绝路径穿越、符号/硬链接、特殊文件和超限归档；校验包身份、平台、接口与每个文件摘要/size/mode 后原子激活。调用时复核安装内容，失败保持明确失败状态。失败安装不替换当前版本，不留下半安装目录。

安装、卸载和执行使用本地模块 store 中每模块/平台/架构一个固定的私有 SQLite 文件事务锁，要求 Bun 或 Node.js >=22.13。锁文件不删除或替换，创建与 SQLite 初始化之间崩溃留下的空文件可正常重新打开。`BEGIN IMMEDIATE` 零等待获取唯一写事务，竞争返回 `module_busy`；正常完成释放事务，进程 SIGKILL 后操作系统释放 SQLite 锁。没有基于 PID、mtime 或超时删除锁的回收路径，因此不会因 PID 复用或并发回收偷取存活操作的锁。此契约适用于本地文件系统，不承诺网络文件系统锁语义。旧格式 `.lock` 目录/未知对象仍拒绝操作，需人工确认后处理，不自动删除。

模块执行等待直接子进程的 `close` 后返回实际退出码或常规信号退出码，并清理转发监听器。持久挂载模块有意留下的受监督 daemon 由模块自身生命周期管理，主 CLI 不进行无差别进程组清理。

## 独立构建与发布

CLI：`bun run --cwd packages/xpod-cli typecheck`、`test`、`build`，之后在包目录 `bun pm pack`。默认 build 不编译 CSS/API/UI/AFS 或原生引擎；构建输入检查拒绝意外服务依赖。npm tarball 交付 CLI payload、启动器、公开的 `client` 兼容接口、`output` 与 `build-tools` 接口，以及 producer/source 材料、原始依赖通知、LICENSE 与说明；不携带 CSS/API/AFS 运行实现，也不包含工作区路径依赖。清洁目录安装后分别验证 Bun 和 Node；不能用仓库内直接运行替代安装验证。

独立门禁为 `node scripts/check-cli-package.cjs`：复制 CLI 与共享运行包的必要构建输入，以及共用的认证兼容补丁/测试类型声明，使用独立构建 lock，不安装根服务依赖。`packages/xpod-cli/build.bun.lock` 是这个派生构建环境的 lock；变更构建依赖时通过 `--update-lock` 更新，普通验证使用 frozen lock。共用补丁仍由根 scripts 管理，在 bundle 前应用，不为独立包复制第二份长期实现。

共享运行包拆分后的清洁构建先生成 CLI 的公共构建工具，再构建 `xpod-client`，最后构建 CLI 与 AFS。构建工具只有一个源码生产者，不允许靠工作区里残留的 `dist` 打破构建循环。清洁消费者须安装实际 `xpod-client` tarball，并分别检验 Node/Bun 与 CJS/ESM；工作区别名只证明本地链接，不证明 registry 已可获取。发布 CLI 或 AFS 前，其依赖版本的实际 tarball、SRI 和可获取状态须独立验证；新运行包的原始通知、源码材料和 Bun 生成代码 provenance 也须独立绑定，不能借用旧 CLI bundle 的摘要。

CLI 使用独立版本和 `cli-v<version>` release 标识；不得因此改服务版本、占共享 RC、触发服务镜像构建或生产部署。发布仍必须从 staging 的不可变源码构建，完整通知/源码与既有 release 审核要求继续有效，不能用“CLI 没有 native”消除 JS 分发审核。服务发布的 accepted SHA/digest 和安装包验收保持原规则。模块发布各自执行接口、平台/native、通知与真实功能验收，并在正式产物可获取后开放使用；缺模块时返回 unavailable，不借用服务整包冒充拆分完成。

## Tag 与版本边界

CLI、AFS、API、CSS 独立版本与独立发布，分别使用 `cli-v<version>`、`afs-v<version>`、`api-v<version>`、`css-v<version>`。同一模块的各平台产物共用一个 tag，并绑定各自的不可变摘要。整体服务/桌面发行保留既有 `v<version>` 与服务 RC 规则。需要联合交付时可协调一次触发多个模块发布，但仍分别打 tag，不要求模块版本号一致；兼容关系由模块接口版本与经过验收的依赖约束表达。

上述 tag 是独立发行的命名约定，当前尚未接通 Git release tag 的自动创建。`cli-package.yml` 的 PR/手动入口交付构建、消费者证据及 publication-preparation 原件；`independent-publication.yml` 提供 staging 上的独立手动入口，默认 `prepare` 只生成计划。入口重新采集官方 producer 原件，在同一进程重建源码与消费者凭据，不从报告 JSON 恢复批准权限。显式 `publish` 也必须通过全部中央准入与实际 registry 安装消费者门禁，缺少执行器或材料时在首次发布前拒绝写入；npm dist-tag 提升与 Git release tag 是独立步骤，不触发服务部署。当前真实安装采集、原生 ABI 及许可材料缺口仍须关闭，不能以工作流存在或本地归档导入通过宣称独立发行完成。

开发任务名称不自动等于分发包。Matrix、Fabric 等业务能力先明确 API 路由、共享服务、CSS adapter 与客户端的职责；只有独立安装/更新需求与接口边界成立后，才在同一目录和宿主接口中登记独立能力包。不得把整个服务换一个包名作为业务模块交付。当前开发任务的落实责任见 [拆包交接清单](module-distribution-handoff.md)。

## 本轮迁移范围

### 独立产物的 CI 接线

`cli-package.yml` 保留私有 `file:` 消费者夹具及其测试归档，另以正常最小 workspace、独立 `publication.bun.lock` 和既有 hoisted 配置构建 CLI/client publication-preparation 原件。准备工具检查正常 tar 的精确版本依赖、原 source manifest，以及 CLI 内嵌 client 与独立归档的逐字节身份；准备成功不等于 registry 发布或消费者读回通过。

完整旧服务包的 Node/Bun 兼容矩阵已移至 `legacy-root-compat.yml`，继续作为服务 RC/stable 的必需门禁；独立 CLI/模块检查不能覆盖其失败，证据职责见 [服务发布流程](RELEASE.md#完整旧包兼容门禁)。

`api-module-product.yml` 从 `module-product-targets.ts` 投影共享目录中的四个平台，在匹配的原生 runner 上串行执行正常 build/stage/material/pack。声明具备输入来源不代表已通过该平台构建与验收。`css-module-product.yml` 使用同一投影入口，目前只为已有原生生产来源的平台生成产品；其余平台保留 `pending-native-source` 诊断，诊断 job 成功不代表产品存在。成功产品和失败诊断使用不同 artifact 名称，源码实际 checkout、事件 head、run/attempt、原 pack 日志及归档摘要分别绑定；native、legal、consumer 和 release 状态保持各自边界。

Linux 模块原生构建使用隔离的 Bookworm/GCC12 SDK profile，保留默认 Trixie/Clang19 服务 profile。既有 SDK workflow 在模块 profile 下依次交付 exact SDK digest、runtime 与原生归档材料；模块源码必须与 workflow checkout 一致。归档复制、压缩与中央产品快照均有字节预算和实际文件系统余量检查。新的 profile、工作流或格式检查不能替代实际冷构建、完整 ABI/源码材料和最终 staging SHA 的消费验收。

模块 SDK 将源码准备与编译分开：`sourcePrepare` 独立拥有 clone、补丁和源码规范化的实际进程及原件；后续 configure/compile 继承同一源码树，并以只读挂载保护主源码、组件、已安装工具和 loader/package 元数据。Git 原件的时间窗绑定源码准备阶段，不能归到后续 configure。FetchContent 在构建目录中取得的第三方源码仍须另行证明来源和读写闭包，主源码只读不能替代该证明。

配置与编译由同一个内层进程持有一个内核跟踪观察器，跨阶段保留生成文件的 FD，并记录实际生成、替换及消费者读取的字节。跟踪阶段使用自己的实际 wait 原件格式，不能冒充已退出的进程组；异常由外层 PID1 owner 实际回收。trace、capture、双原始输出及跨目录回执共同计入原件预算，阶段之间只允许收紧剩余额度。接收端从同一私有 SDK 原件能力及完整分片重验这些事实；字节关系通过不代表工具链源码、FetchContent 依赖或完整 SDK 来源已通过。

Bookworm profile 从明确的 backports 索引精确安装同版本 `cmake` 与 `cmake-data`，不整体切换发行套件。生产端的固定 `gpgv` 采集可以保留实际退出码 2 的完整、已结束原件，但它只表示未分类材料；签名资格仍由外层独立执行验证并调用唯一 Debian suite/key/status 策略取得，不把退出码改成 0，也不在 Python 维护第二份信任规则。

发布组从实际 manifest 与共享平台目录校验完整目标集合、组内版本/源码一致性及精确依赖顺序。结构检查不签发发布权限；中央构建阶段观察只核对真实原件的顺序、命令、日志摘要和关闭状态，也不单独授予完整源码资格。共享包注册、完整源码/原生/许可准入和真实 registry 安装消费者仍须分别接通并通过。

`acquire-independent-product-input.ts` 保存 GitHub 元数据原字节与 ZIP 摘要链；`project-api-product-input.ts` 仅复制约定的 producer receipt、原 tgz 和 pack raw 成员，再生成 `collect-api-release-input.ts` 的输入。投影不展开内部 tgz，也不替代 collector 的库存和源码材料检查。`project-cli-publication-input.ts` 复用同一 custody/ZIP 校验，核对正常 CLI 的 result、inventory、source-inputs、preparation、producer index 与两份原 tgz，并再次运行发布准备校验。未知的 producer source 字段保持原值；registry 消费仍单独验收。producer 的 checkout/attempt/阶段关闭声明尚未被独立准入验证时仍为 blocked，旧 CLI 测试归档不能改名充当发布候选。

已执行的第一步是 CLI 核心源码归属、独立 npm 构建与通用按需模块下载/校验入口。默认 test/verify 同样只覆盖 CLI 核心；test:preview/verify:preview 显式保留旧预览兼容门禁。既有 `build:preview`/`build:cli-only` 保存旧客户端+helper 预览的证据链，不是新的默认发行路径；其 `src/main.ts`/`src/entry.ts` 为显式迁移期入口，公共 npm 包只运行 `npm-entry.ts`，切换点是 package.json 的 build/bin。

截至本轮验收，CLI 的安装/执行锁已与服务宿主生命周期接通，CLI/AFS/CSS/API 的独立 producer 已产生实际包并完成对应消费者验收；桌面也已完成独立端口上的真实组合启动。CSS/API/AFS 平台包仍未正式发布到 registry。各产物来源分别如下，不能将后续测试提交视为这些产物的重新构建：

| 产物 | 已验产物来源 | 已确认范围与入口 |
| --- | --- | --- |
| CLI / AFS | `dd5e04b4` 实际包 | 正常包消费者与模块验收；构建和专项验收入口分别见 [CLI](../packages/xpod-cli/README.md)、[AFS](../packages/xpod-afs/README.md) |
| CSS | 原 `25f44885` dirty 候选，归档摘要 `4593e11e…` | 独立 producer、正常包消费者及桌面组合中的实际 CSS；材料边界见 [CSS scoped components](testing/css-scoped-components.md) |
| API | clean `25f44885` 构建/消费者链，原归档摘要 `b9c60dfa…` | 独立 producer、实际包与正常消费者；构建材料见 [API bundle materials](testing/api-bundle-materials.md) |
| 桌面 / 随包 CLI | `e6de7863` 实际 `.app`，组合运行使用上述原 CSS/API 归档 | 空 PATH、随包 Bun/正常 CLI、独立端口真实 CSS/API/QLever、HTTP 就绪、窗口/托盘、正常退出及签后封印；入口见 [桌面 runtime 材料与验收](../desktop/RUNTIME-MATERIALS.md) |

桌面组合验收后，安装库存、逐文件摘要/权限、manifest、原归档 provenance、签前/签后及进程证据已封存，再由同一公开 CLI 正常卸载可重建模块，未删除原归档、签名应用或测试数据库。本地单入口记录为 `.test-data/module-isolation-integration-20261014/desktop-split-acceptance.final.safe.json`；该记录保留桌面与原模块各自来源，不声明同一 SHA 的整套重构建。

`e9cb5b5b` 是当前代码/测试基准，不是上述产物的新构建身份。registry 发布与实际 tarball/SRI 读回、完整原生与法律/源码材料资格、真实交互登录后的 Pod 读写及 Chat 等仍未完成；桌面窗口当时显示“正在登录”，不构成这些功能通过的证据。OS 挂载及其他模块功能以各自专项验收为准，不能用下载成功或联合 HTTP 就绪替代。

拆分后的 mounted 验收 driver 要求 `module-source-kit.publicClientMaterials` 显式声明唯一 `runtimeClients` 和 `workspaceSources`。它核对公开客户端的完整文件集合、大小与摘要，并将声明绑定到实际 producer index、源码库存和逐成员验证的源码归档；缺少声明直接拒绝。历史归档继续使用其原提交绑定的 driver，不由新 driver 根据文件存在情况回退。安装回执以 `installedClientPath` 和 `installedClientSHA256` 记录实际客户端入口。


### 独立客户端的 CI 产物

模块挂载 CI 先安装并构建声明依赖，再调用原生材料查询工具；工具的共享运行包不能依赖 runner 预留的构建目录。构建后显式执行 `node --test tests/scripts/service-runtime-boundary.node-test.cjs`，该文件不由默认 Vitest 门禁发现。共享客户端的包测试由主 CI 与挂载 CI 显式执行 `bun test ./packages/xpod-client/tests`；独立 CLI 的隔离脚本在其最小构建树中执行同一包测试，客户端源码变更也必须触发 CLI 包 CI。

产品 artifact 的 inventory schema 2 包含三个实际打包的归档：`client.tgz`、`cli.tgz`、`afs.tgz`。每个归档独立记录大小、SHA-256 和 SHA-512 SRI，并绑定源码 SHA、实际运行及尝试编号。客户端归档核验公开入口、类型、Session/peer 桥接、完整 dist 和原始通知材料，不能用 CLI 内嵌客户端替代其独立发布材料。历史 schema 1 只有 CLI/AFS 两个归档，不提供独立客户端的发布证明。

这些产物属于开发验收证据；本地实际 tarball 消费者与模块安装验收的来源见上表。客户端及依赖模块的实际 registry 归档与 SRI 读回、staging 发布条件仍须分别通过。

### AI runtime 与宿主契约的发布材料

`ai-connections-runtime` 是能力模块的运行包，`extension-host-contracts` 提供无 UI 的宿主类型；旧 `ai-connections` 与 `extension-sdk` 的兼容入口转发到这两个包。共享包发布列表按依赖顺序包含新包，已发布旧版本不可改写，迁移必须正常增版。实际 tarball 消费者须覆盖全部公开 JS、类型和 CSS 入口；现有消费者对外部依赖声明诊断的排除属于其验证边界，不能表述为所有依赖声明均无错误。

两包的 `dist/materials` 保存 canonical 源码、原始许可证、逐文件大小与 SHA-256 库存和构建 provenance。Git 来源按完整源码目录核对 tracked 清单与删除状态；dirty、untracked 或缺失源码的快照不得冒充提交的清洁构建。AI 的三份 CJS 输出分别保存实际 payload、metafile 和生成代码原始通知。新生成 helper 逐项与同版本 pin 的 Bun runtime 或既有已审生成前缀比较，并记录每项权威对象和完整两级绑定；AST 比较保留声明类型、字面量和块结构，仅规范化 export 修饰符与冗余括号。任何不匹配都阻断构建，不能借旧 profile 摘要批准新生成体。

本地构建、tar 库存校验和消费者通过仍不是 registry 发布证明。正式发行须从已审 staging 不可变源码重新构建，按依赖顺序发布，再读回实际 tarball 与 SRI；client/CLI/AFS 的独立模块门禁继续有效。

### AFS Note 契约与命名空间

AFS 的文件元数据和 reader coverage Note 输入类型、枚举与 noteKind 由 models 的轻量公共契约入口提供；该入口发布并读回后才冻结 adapter 依赖版本。Adapter 使用共享 UDFS 命名空间 `https://undefineds.co/ns#` 生成新 RDF；旧的 `https://vocab.undefineds.co/udfs#` 不再作为新写入契约。没有生产调用证据或已有资源清单时，不推测并批量改写用户 Pod。现有资源若含旧谓词，须单独审计后迁移；本次不提供第二套共享建模定义或隐式命名空间回退。
### 服务模块关闭路径前置契约

Gateway 的 API host、API path、web product 和 API WebSocket 路径属于 API 能力；没有 API target 时返回 503，不回落 CSS。正常 CSS HTTP/WebSocket 路径保持既有路由。Supervisor 的停止 Promise 只在真实 child close 后成功，包含已排空的子进程输出；发送 SIGTERM 的回调不代表停止完成。并发停止共用同一 Promise，超时或信号失败明确失败，重启先等待原进程关闭。关闭中的服务不计入 readiness。

这些关闭契约、独立 producer、实际依赖闭包及单一运行计划已分别验证，并完成上表所列实际产物的联合运行；这不等于平台模块已正式发布，仍须保留各模块的来源与功能验收边界。

### 已验证模块的服务宿主入口

`src/runtime/module-host.ts`（公开子路径 `@undefineds.co/xpod/runtime/module-host`）接收安装器已经验证且保持执行锁的 `RuntimeModuleDescription`，用同一个 `RuntimePlan` 注册子进程和设置 Gateway target。部署 edition 不选择 CSS/API 能力，宿主不扫描安装目录、不解析版本、不执行安装，也不加载 CSS/API 初始化实现。API-only 须传入独立 OIDC issuer；重复角色、进程角色不匹配和无效 endpoint 在创建资源前拒绝。

`startModuleRuntime` 等所选 endpoint 可连接后才开放 Gateway。返回的 handle 暴露 plan、supervisor、gateway、closed 与 stop；closed 仅在所有关闭成功后完成。模块实际启动由当前 Bun/Node 执行安装器提供的入口参数。停止同时清理所有 listener 和所拥有的子进程；并发 stop 共用结果，失败可重试，超时不代表资源已关闭。启动失败且清理未完成时抛出 `ModuleRuntimeStartupError`，保留启动与清理错误及 runtime handle，调用方须保留安装锁并重试清理，不能在 finally 无条件释放。

独立 CLI 的正式 core 注册 `start`，通过 `ModuleStore.withAdmittedModules` 校验真实安装入口并在整个宿主生命周期持有所有所选模块锁。`--modules` 只选择 css/api，`--mode` 同时写入两者既有运行模式；API-only 继续要求独立 OIDC issuer。关闭拒绝时保留进程存活句柄和锁，记录失败状态，允许再次发送停止信号重试，不能靠自然退出释放锁。CLI 构建只引入 `canonical-host-sources.json` 声明的宿主源码及其类型源码，并随 producer source 材料保留；不引入 CSS/API 初始化实现。

`POST /service/stop` 返回 `202 {accepted:true}`，仅确认请求被接受。异步关闭失败会记录错误并保留所有权；HTTP 成功不能当作子进程或监听器已关闭的证据。

这条入口、独立 producer 与 CLI 安装锁接线已分别验收，真实组合运行的产物来源见上表；平台模块的 registry 发布与正式发行资格仍单独验证。
