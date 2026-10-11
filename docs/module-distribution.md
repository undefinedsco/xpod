# CLI 与可选模块的分发规范

本规范落实用户决定：Xpod 是总产品，`xpod` 是独立发布的 CLI；CSS、API、AFS 按需下载。包边界、依赖和发布以本文为准。内部职责仍按 AGENTS.md：CSS 处理 Solid 协议，API 处理管理接口，共享服务处理业务逻辑。

## 包与依赖方向

| 产物 | 所有权与默认安装内容 | 依赖限制 |
| --- | --- | --- |
| `@undefineds.co/xpod-cli` | `xpod` 命令、认证、原始 Pod HTTP 客户端、模块管理 | 不依赖 CSS/API/AFS 实现、UI、Agent SDK、数据库引擎或原生 helper |
| CSS 模块 | Solid 协议处理、Components.js 配置及需要的存储引擎 | 可依赖共享业务/存储 adapter，不依赖 CLI 实现 |
| API 模块 | 管理/业务 HTTP 入口及运行依赖 | 可依赖共享服务，不直接穿透 CSS 实现 |
| AFS 模块 | 目录客户端、挂载/搜索/工作副本能力和平台 helper | 连接远端 Pod 时不要求本机 CSS/API；服务端目录扩展依赖 CSS 的授权/存储契约 |
| 共享模块 | schema、协议或业务服务，按既有所有权规则归属 | 使用包的公开接口，禁止跨包引用源码；schema 继续归 models |

入口与功能模块分别版本化。模块不是独立产品，不另造凭据库；认证实现与凭据存储保持一个权威来源。CLI 核心源码归 `packages/xpod-cli/src/commands` 和 `src/lib`。根 `src/cli` 中迁移过的同名文件仅保留转发 adapter，供尚未迁移的服务入口使用；不得在这里恢复实现。adapter 已使用 `@undefineds.co/xpod-cli/client` 公开接口，CJS/ESM 共享同一实现实例；后续服务入口迁移后删除这层 adapter。旧服务包暂时依赖 CLI 包，既有受控 npm 打包流程随服务保留该兼容包，防止工作区依赖泄漏；此过渡不会反向增加独立 CLI 的服务依赖。程序侧 client 类型接口有可选的认证 SDK peer，命令行消费者不会因此下载 SDK。

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

独立门禁为 `node scripts/check-cli-package.cjs`：只复制 CLI 源码与共用的认证兼容补丁/测试类型声明，使用 CLI 的最小构建 lock，不安装根服务依赖。`packages/xpod-cli/build.bun.lock` 是这个派生构建环境的 lock；变更 CLI 构建依赖时通过 `--update-lock` 更新，普通验证使用 frozen lock。共用补丁仍由根 scripts 管理，在 bundle 前应用，不为独立包复制第二份长期实现。

CLI 使用独立版本和 `cli-v<version>` release 标识；不得因此改服务版本、占共享 RC、触发服务镜像构建或生产部署。发布仍必须从 staging 的不可变源码构建，完整通知/源码与既有 release 审核要求继续有效，不能用“CLI 没有 native”消除 JS 分发审核。服务发布的 accepted SHA/digest 和安装包验收保持原规则。模块发布各自执行接口、平台/native、通知与真实功能验收，并在正式产物可获取后开放使用；缺模块时返回 unavailable，不借用服务整包冒充拆分完成。

## Tag 与版本边界

CLI、AFS、API、CSS 独立版本与独立发布，分别使用 `cli-v<version>`、`afs-v<version>`、`api-v<version>`、`css-v<version>`。同一模块的各平台产物共用一个 tag，并绑定各自的不可变摘要。整体服务/桌面发行保留既有 `v<version>` 与服务 RC 规则。需要联合交付时可协调一次触发多个模块发布，但仍分别打 tag，不要求模块版本号一致；兼容关系由模块接口版本与经过验收的依赖约束表达。

开发任务名称不自动等于分发包。Matrix、Fabric 等业务能力先明确 API 路由、共享服务、CSS adapter 与客户端的职责；只有独立安装/更新需求与接口边界成立后，才在同一目录和宿主接口中登记独立能力包。不得把整个服务换一个包名作为业务模块交付。当前开发任务的落实责任见 [拆包交接清单](module-distribution-handoff.md)。

## 本轮迁移范围

已执行的第一步是 CLI 核心源码归属、独立 npm 构建与通用按需模块下载/校验入口。默认 test/verify 同样只覆盖 CLI 核心；test:preview/verify:preview 显式保留旧预览兼容门禁。既有 `build:preview`/`build:cli-only` 保存旧客户端+helper 预览的证据链，不是新的默认发行路径；其 `src/main.ts`/`src/entry.ts` 为显式迁移期入口，公共 npm 包只运行 `npm-entry.ts`，切换点是 package.json 的 build/bin。

CSS/API/AFS 的平台包尚未在 registry 发布，服务内部也尚未完成可选运行计划。下一步先将 AFS 客户端与真实 helper 按上述格式交付，再迁移服务入口及 CSS/API adapter；不能把本轮 CLI fixture 的下载成功表述为真实模块发布或 OS 挂载通过。
