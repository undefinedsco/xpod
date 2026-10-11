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

`files` 覆盖除 package.json 外的全部普通文件，包括 helper、LICENSE/NOTICE 和需要的源码材料。entry 是库存内的 Node 兼容 `.mjs`，通过当前 Bun/Node 运行；模块自行调用自己的 native payload。接口 v1 传递 argv、继承环境与 stdio，并传播退出状态；不通过 argv 或安装记录传递凭据。关闭的服务路径不得回落到另一模块。统一运行计划、Gateway 路由与 readiness 属于后续服务模块迁移，CLI 下载器不能冒充它们已实现。

下载使用 npm registry 的 SHA-512 SRI；验证后才解包。拒绝路径穿越、符号/硬链接、特殊文件和超限归档；校验包身份、平台、接口与每个文件摘要/size/mode 后原子激活。调用时复核安装内容，失败保持明确失败状态。失败安装不替换当前版本，不留下半安装目录。

安装、卸载和执行使用本地模块 store 中每模块/平台/架构一个固定的私有 SQLite 文件事务锁，要求 Bun 或 Node.js >=22.13。锁文件不删除或替换，创建与 SQLite 初始化之间崩溃留下的空文件可正常重新打开。`BEGIN IMMEDIATE` 零等待获取唯一写事务，竞争返回 `module_busy`；正常完成释放事务，进程 SIGKILL 后操作系统释放 SQLite 锁。没有基于 PID、mtime 或超时删除锁的回收路径，因此不会因 PID 复用或并发回收偷取存活操作的锁。此契约适用于本地文件系统，不承诺网络文件系统锁语义。旧格式 `.lock` 目录/未知对象仍拒绝操作，需人工确认后处理，不自动删除。

模块执行等待直接子进程的 `close` 后返回实际退出码或常规信号退出码，并清理转发监听器。持久挂载模块有意留下的受监督 daemon 由模块自身生命周期管理，主 CLI 不进行无差别进程组清理。

## 独立构建与发布

CLI：`bun run --cwd packages/xpod-cli typecheck`、`test`、`build`，之后在包目录 `bun pm pack`。默认 build 不编译 CSS/API/UI/AFS 或原生引擎；构建输入检查拒绝意外服务依赖。npm tarball 只包含 CLI payload、启动器、原始依赖通知、LICENSE 与说明，不包含工作区路径依赖。清洁目录安装后分别验证 Bun 和 Node；不能用仓库内直接运行替代安装验证。

独立门禁为 `node scripts/check-cli-package.cjs`：复制 CLI 与共享运行包的必要构建输入，以及共用的认证兼容补丁/测试类型声明，使用独立构建 lock，不安装根服务依赖。`packages/xpod-cli/build.bun.lock` 是这个派生构建环境的 lock；变更构建依赖时通过 `--update-lock` 更新，普通验证使用 frozen lock。共用补丁仍由根 scripts 管理，在 bundle 前应用，不为独立包复制第二份长期实现。

共享运行包拆分后的清洁构建先生成 CLI 的公共构建工具，再构建 `xpod-client`，最后构建 CLI 与 AFS。构建工具只有一个源码生产者，不允许靠工作区里残留的 `dist` 打破构建循环。清洁消费者须安装实际 `xpod-client` tarball，并分别检验 Node/Bun 与 CJS/ESM；工作区别名只证明本地链接，不证明 registry 已可获取。发布 CLI 或 AFS 前，其依赖版本的实际 tarball、SRI 和可获取状态须独立验证；新运行包的原始通知、源码材料和 Bun 生成代码 provenance 也须独立绑定，不能借用旧 CLI bundle 的摘要。

CLI 使用独立版本和 `cli-v<version>` release 标识；不得因此改服务版本、占共享 RC、触发服务镜像构建或生产部署。发布仍必须从 staging 的不可变源码构建，完整通知/源码与既有 release 审核要求继续有效，不能用“CLI 没有 native”消除 JS 分发审核。服务发布的 accepted SHA/digest 和安装包验收保持原规则。模块发布各自执行接口、平台/native、通知与真实功能验收，并在正式产物可获取后开放使用；缺模块时返回 unavailable，不借用服务整包冒充拆分完成。

## Tag 与版本边界

CLI、AFS、API、CSS 独立版本与独立发布，分别使用 `cli-v<version>`、`afs-v<version>`、`api-v<version>`、`css-v<version>`。同一模块的各平台产物共用一个 tag，并绑定各自的不可变摘要。整体服务/桌面发行保留既有 `v<version>` 与服务 RC 规则。需要联合交付时可协调一次触发多个模块发布，但仍分别打 tag，不要求模块版本号一致；兼容关系由模块接口版本与经过验收的依赖约束表达。

开发任务名称不自动等于分发包。Matrix、Fabric 等业务能力先明确 API 路由、共享服务、CSS adapter 与客户端的职责；只有独立安装/更新需求与接口边界成立后，才在同一目录和宿主接口中登记独立能力包。不得把整个服务换一个包名作为业务模块交付。当前开发任务的落实责任见 [拆包交接清单](module-distribution-handoff.md)。

## 本轮迁移范围

已执行的第一步是 CLI 核心源码归属、独立 npm 构建与通用按需模块下载/校验入口。默认 test/verify 同样只覆盖 CLI 核心；test:preview/verify:preview 显式保留旧预览兼容门禁。既有 `build:preview`/`build:cli-only` 保存旧客户端+helper 预览的证据链，不是新的默认发行路径；其 `src/main.ts`/`src/entry.ts` 为显式迁移期入口，公共 npm 包只运行 `npm-entry.ts`，切换点是 package.json 的 build/bin。

CSS/API/AFS 的平台包尚未在 registry 发布，服务内部也尚未完成可选运行计划。下一步先将 AFS 客户端与真实 helper 按上述格式交付，再迁移服务入口及 CSS/API adapter；不能把本轮 CLI fixture 的下载成功表述为真实模块发布或 OS 挂载通过。

拆分后的 mounted 验收 driver 要求 `module-source-kit.publicClientMaterials` 显式声明唯一 `runtimeClients` 和 `workspaceSources`。它核对公开客户端的完整文件集合、大小与摘要，并将声明绑定到实际 producer index、源码库存和逐成员验证的源码归档；缺少声明直接拒绝。历史归档继续使用其原提交绑定的 driver，不由新 driver 根据文件存在情况回退。安装回执以 `installedClientPath` 和 `installedClientSHA256` 记录实际客户端入口。


### 独立客户端的 CI 产物

模块挂载 CI 先安装并构建声明依赖，再调用原生材料查询工具；工具的共享运行包不能依赖 runner 预留的构建目录。构建后显式执行 `node --test tests/scripts/service-runtime-boundary.node-test.cjs`，该文件不由默认 Vitest 门禁发现。共享客户端的包测试由主 CI 与挂载 CI 显式执行 `bun test ./packages/xpod-client/tests`；独立 CLI 的隔离脚本在其最小构建树中执行同一包测试，客户端源码变更也必须触发 CLI 包 CI。

产品 artifact 的 inventory schema 2 包含三个实际打包的归档：`client.tgz`、`cli.tgz`、`afs.tgz`。每个归档独立记录大小、SHA-256 和 SHA-512 SRI，并绑定源码 SHA、实际运行及尝试编号。客户端归档核验公开入口、类型、Session/peer 桥接、完整 dist 和原始通知材料，不能用 CLI 内嵌客户端替代其独立发布材料。历史 schema 1 只有 CLI/AFS 两个归档，不提供独立客户端的发布证明。

这些产物属于开发验收证据。客户端实际 registry 归档与 SRI 读回、依赖该版本的模块安装验收，以及 staging 发布条件仍须分别通过。

### AI runtime 与宿主契约的发布材料

`ai-connections-runtime` 是能力模块的运行包，`extension-host-contracts` 提供无 UI 的宿主类型；旧 `ai-connections` 与 `extension-sdk` 的兼容入口转发到这两个包。共享包发布列表按依赖顺序包含新包，已发布旧版本不可改写，迁移必须正常增版。实际 tarball 消费者须覆盖全部公开 JS、类型和 CSS 入口；现有消费者对外部依赖声明诊断的排除属于其验证边界，不能表述为所有依赖声明均无错误。

两包的 `dist/materials` 保存 canonical 源码、原始许可证、逐文件大小与 SHA-256 库存和构建 provenance。Git 来源按完整源码目录核对 tracked 清单与删除状态；dirty、untracked 或缺失源码的快照不得冒充提交的清洁构建。AI 的三份 CJS 输出分别保存实际 payload、metafile 和生成代码原始通知。新生成 helper 逐项与同版本 pin 的 Bun runtime 或既有已审生成前缀比较，并记录每项权威对象和完整两级绑定；AST 比较保留声明类型、字面量和块结构，仅规范化 export 修饰符与冗余括号。任何不匹配都阻断构建，不能借旧 profile 摘要批准新生成体。

本地构建、tar 库存校验和消费者通过仍不是 registry 发布证明。正式发行须从已审 staging 不可变源码重新构建，按依赖顺序发布，再读回实际 tarball 与 SRI；client/CLI/AFS 的独立模块门禁继续有效。

### AFS Note 契约与命名空间

AFS 的文件元数据和 reader coverage Note 输入类型、枚举与 noteKind 由 models 的轻量公共契约入口提供；该入口发布并读回后才冻结 adapter 依赖版本。Adapter 使用共享 UDFS 命名空间 `https://undefineds.co/ns#` 生成新 RDF；旧的 `https://vocab.undefineds.co/udfs#` 不再作为新写入契约。没有生产调用证据或已有资源清单时，不推测并批量改写用户 Pod。现有资源若含旧谓词，须单独审计后迁移；本次不提供第二套共享建模定义或隐式命名空间回退。
