# API bundle 与原始源码材料

API 主入口和 Pi worker 的源码、公开入口、实现文件由 `packages/xpod-api/scripts/bundle-runtime.ts` 的同一份内部声明驱动。构建保留两个实际 metafile、每个输入和输出的 SHA-256、原始源码对应的构建适配版本。stage 前重新验证这些绑定；同一源码在两个 bundle 中允许重复出现，但适配版本与原始哈希必须一致。显式 `workerPath` 仍优先，worker 被 import 时不启动。

metafile 的输入路径相对实际构建 cwd，不假设从仓库根启动。构建保留原始 metafile，另将 input、内部引用、output.inputs 和 entryPoint 归一化为通过真实路径边界验证的 canonical repo-relative 路径；记录归一化版本并在使用前重放校验。不会改变整个进程的 cwd。

跨 Node/Bun 的 builtin 判定由构建工具链真实的受支持 Node 一次检查全部实际 runtime specifier。记录其版本、可执行文件真实路径和 SHA-256、请求集合 SHA-256 及每项 boolean 结果；Node 缺失或检查失败会阻断。Bun 的 `isBuiltin('ws')` 与 Node 不同，不能代替该权限来源。这个检查器只用于构建和验收，不引入产品运行时回退。

bundle 构建材料与运行资格分开。无法声明闭合的非字面量 import/require/createRequire 调用记录在 `dynamicLoads` 中；默认验证拒绝这些调用，构建器的显式 material-only 检查不授予安装权限。新增动态能力必须先补真实调用来源和完整资源声明，不能因为 output.imports 为空而跳过。

已进入 bundle 的代码不能再通过 metafile 全量播种运行时 node_modules。共享 stage 的可选 bundle 分支仅复制已验证的产物，以及显式声明的动态依赖和它们的完整依赖闭包；CSS 原有分支继续编译 canonical source。Pi SDK 等声明依赖保留完整内容和实际版本身份。

## 两种材料角色和固定边界

- **运行产物**：ModuleStore 和发布归档仍使用原有 50,000 个成员边界，不提高、不通过运行时解压依赖绕过。
- **source-only 原材料**：所有 sourcekits 合计最多 100,000 个成员，包含各自的索引。该独立固定边界用于保留完整第三方原材料；当前单份去重原材料库存约 54,982 文件，不能用运行依赖裁剪代替源码材料保存。sourcekit 永远不作执行入口、依赖查找目录或启动时解包来源。
- **总资源预算**：运行产物展开量、所有 sourcekit 声明并实际校验的展开量和 sourcekit 归档本身的字节数保守相加，不超过 2 GiB。归档字节重复计入是有意保守核算；不得拆成多份归档绕过 aggregate 边界。

`scripts/sourcekit.ts` 使用有界流式读取验证源码材料，绝不先解包。外部索引最多 32 MiB，单个路径最多 4096 UTF-8 字节，所有文件必须有精确 size/hash/mode；只允许普通 USTAR 文件，拒绝路径穿越、重复路径、symlink/hardlink、稀疏文件、扩展元数据头、未列成员和缺失成员。512 字节头先检查类型和 checksum，再读内容；gzip 每次只解出所需的有界块，不把扩展头交给 tarfile 自动分配。实际字节预算包含内容、header 和 padding。归档自身也先绑定 SHA-256。

只允许单个 gzip stream（或未压缩 tar）。两个 tar 结束块之后，可以直接 EOF，或补零至当前 10 KiB USTAR record 的末尾；拒绝非零尾部、附加 tar/gzip member 和过量零 padding。不能用正常成员哈希掩盖未检查的尾部。无法用 USTAR 表达的长路径必须由独立、无损的索引映射设计解决，当前验证器不会退回接受 PAX/GNU 扩展头。

每份索引的 `schemaVersion` 为 1、`role` 为 `source-only`，包含单段 `rootName` 和 `files`；每个文件记录 `path`、`sha256`、`sizeBytes`、规范模式 `0644` 或 `0755`。归档中的 `<rootName>/source-kit.json` 必须和外部索引逐字节一致。

## 当前验收边界

bundle/sourcekit 的独立夹具验证不能替代正常静态页面构建、真实 API 安装、原生依赖绑定或真实 Gateway/Chat 验收。未知动态资源、缺失原材料或 notice 都必须阻断 stage。共享 ORM 初始化问题另见 `docs/issues/drizzle-solid-bundled-comunica-initialization.md`，不得用工作目录或运行时回退掩盖。

## 构建适配与依赖声明

`ObservableResourceStore` 的 canonical value import 和生成的 d.ts 保留 CSS 根入口，避免 Components.js generator 将合法运行时子路径拼接成 `dist/dist`。API 专属 onLoad 只对 canonical realpath 的该文件应用 AST 适配：唯一非 type CSS import 必须仅导入未改名的 `PassthroughStore`，唯一目标类必须直接继承它；只替换这个 module specifier。原始源码 SHA-256、适配版本随构建材料记录，验证器在该文件属于实际输入时要求对应适配记录。CSS 编译路径不应用此适配。

显式运行依赖通过实际导入 owner 的 manifest 声明范围解析。查询包根时走正常 `package.json` 子路径查找位置与真实文件身份，不能把 Bun 的 `require.resolve('undici') === 'undici'` 当成磁盘路径，也不能用仓库顶层同名版本替换 owner 的嵌套版本。能力包自己的依赖从能力包 manifest 上下文解析，包含只有 bin 或仅 import 导出的包。

PGlite 保留完整原始 JS/WASM/data 目录作为外部包；它产生的 Node socket 分支引用 ws，而当前上游 manifest 未声明 ws，因此 API 能力包显式声明 ws 8.21.1，不伪造 PGlite 的 owner 声明。独立 PGlite SQL 夹具通过只证明其常规初始化和查询，不证明 socket 分支或完整 API。

## 正常 stage / pack 的接线条件

正常 `stage.ts` / `pack.ts` 已接入 bundle 分支，下列同一入口验证链用于阻断缺失或漂移材料。代码接线与小夹具通过，仍不代表完整 API 产物已验收：

1. stage 从正常 build 的 `bundle-products.json` 取得两个产物，使用默认严格 `verifyApiBundleProducts`；未知 external 或非字面量加载在创建 stage 之前拒绝。不得把构建器的 material-only 选项传给 stage。
2. 以两个真实 metafile 的输入并集构建源码库存；运行代码仅复制已绑定的公开入口、实现和证明材料，显式外部包使用 `runtimeImports` 的 owner 身份与能力 manifest。正常静态页面通过现有 `verifyStaticProducts`，静态源码与构建工具材料加入同一原材料库存。
3. 按物理来源去重，流式生成 source-only 原材料索引和 USTAR/gzip 源码归档。索引、归档哈希及精确预算作为 stage 材料声明；在 pack 前验证 sourcekit 总成员、实际展开量和运行归档的联合预算。不能以缺省空 sourcekit 或现有夹具验收替代真实材料。
4. notice 和原生材料使用现有原件收集/验证接口，归属覆盖 bundle 输入和完整外部包闭包。pack 重验 sourcekit、bundle、静态材料及上述原件后才调用现有运行归档打包入口；preview 保持 `publishReady: false`。

剩余严格项须先处理：Comunica 的默认 ORM engine 字面量 require 与 Xpod 自定义 engine 共用同一能力，不能删除默认工厂；Comunica 内带的 yargs 动态配置加载必须由完整原始包闭包承担或有可复核的静态适配。Awilix 的模块/glob 加载属于其公开能力，不能仅因业务当前只显式 register 就豁免；provider-utils 的 `import(id)` 与安全 Node fetch/undici 也不能当作无用代码删除。两者若选择完整包外置，应先绑定每个真实 owner 的版本和完整资源，再做脱离源码的 Node/Bun 回归。

### 完整外部包与 observer 实例身份

API 的程序声明同时外置 Comunica Solid engine、两个直接导入的 ActionObserver、Awilix 和 provider-utils；全部复用 owner manifest 范围与哈希验证。两个 observer 必须与 engine 使用同一物理模块身份，不能把其中一方留作 bundle 内副本。canonical 源码直接导入的 observer 也必须在 canonical 根 manifest 显式声明；不得冒用 engine 的依赖声明替代源码 owner。

完整包外置保留上游的模块加载能力，并不豁免动态资源审计。运行归档仍须包含原始发布布局、依赖闭包、optional/native 的原有语义和原材料。Awilix 的 CommonJS 和 ESM 插件加载需要分别验证；API 公开入口已有的 createRequire shim 也属于该调用契约。provider-utils 在 Node 默认 fetch 下需验证其安全 fetch 路径确实解析 owner 的 undici 5.x，不能误用仓库顶层 7.x，Bun 则保留上游既有运行时分支。

仅在当前安装树验证默认 ORM 工厂、自定义工厂优先级、两份 observer 类身份、初始化幂等和真实 SELECT，仍不代表 Comunica 已通过脱离源码的安装验收。sourcekit、NOTICE、正常静态产品以及完整 API stage/pack 的门禁均保持独立。


## 正常命令与当前资格

在 `packages/xpod-api` 内执行 `bun run build`、`bun run stage <fresh-stage> preview <exact-version>` 和 `bun run pack <stage> <fresh-archive>`。stage 首先严格重验正常 build 的 bundle 和静态凭据，再调用共享 runtime stage、生成 sourcekit；pack 在处理材料前重验，在最终 ModuleStore manifest 写入后、归档创建前再次校验联合字节预算。stage 与 pack 缺 bundle 凭据时均在创建新输出之前拒绝，不接受旧诊断目录的 gate=1 输出。

源码归档直接从已绑定原件分块读取并写入 USTAR/gzip，不创建第二份展开源码。写前校验 USTAR 可表示性、成员与字节预算；读取前后核对文件身份、size、mode、时间戳与内容哈希。流写失败清理本次新建的半成品，不覆盖或清理既有归档。index 逐条编码，超过 32 MiB 即拒绝；完整归档随后使用同一个有界验证器复核。pack 还会重新计算实际原件库存，与归档索引逐字节对位。

sourcekit 的原始 package manifest 和具名条款路径另有可重算库存；缺失具名条款保留为显式 pending。controlled preview 不授予发布资格；formal release 同时要求该库存无缺项、现有 NOTICE 原件验证、native 原件验证和干净 Git 权威。完整正常静态构建、实际 API stage/pack、脱离源码的 API/Comunica consumer 及最终全量集成回归仍待完成。

API 的 Bun 构建类型位于模块内部的 `bun-build-api.ts`，producer 与真实 Bun 夹具共用实际 `Bun.build` binding。API 专用 tsconfig 显式使用 Node 类型及仓内既有的窄 `bun:test` / ImportMeta 声明；不安装完整 Bun 全局类型，也不改变业务 fetch。仅给完整 Bun 类型包取 alias 仍不隔离：上游 drizzle-orm 0.28.6 的 sqlite blob 声明显式引用 `bun-types`，正常 hoist 会使其全局 fetch/stream 声明进入其他模块。修复依赖声明后，旧安装中的 orphan 类型目录可能仍被 Bun 保留，需通过已授权的完整自有安装目录 clean reinstall 恢复实际解析图；不得改第三方文件或给业务 wrapper 增加 preconnect 来掩盖。

实际 bundle 输入的最近 package manifest 决定原材料归属：installed distribution（含 workspace 内嵌套 node_modules）保留完整原包；同仓 workspace 输入同时保留其已绑定 dist 与权威 Git 源码。UI 与 workspace 复用同一份 NUL 分隔的 Git 文件枚举，包含 tracked 和未忽略的 untracked 源文件，排除测试中间目录、运行数据目录和常见密钥文件；逐层拒绝 symlink 和跨仓路径。不能只把 workspace 的编译文件列入源码材料，也不能借收集源码打包用户本地数据。

完整 installed distribution 仅在每个相对路径、内容 SHA-256、size、规范 mode 与原始 package manifest 身份都相等时共享一份源码副本。每个实际物理来源及其 bundle 输入、实际 manifest 声明或依赖解析事实都保留在同一 `source-kit.json` 的可选 `originMappings` 中；该索引同时置于归档内并与外部索引逐字节绑定，schemaVersion 仍为 1。运行依赖树不按源码副本去重改变。归档验证器核对映射格式、完整 inventory 身份、原始 manifest 和 owner 文件在归档中的哈希；pack 重新读取所有物理来源重建同一映射，不能只验证代表目录。来源遗漏、别名改写、任一来源内容/版本/规范 mode 漂移或 owner 哈希失配都会拒绝。来源映射只有这一处权威入口，外层材料记录不维护第二份别名目录。

`apiProducerSourcePaths` 是 API producer 原件和 pack 源码复制的同一权威入口，复用上述 Git/路径过滤，不能原始扫描整个 API 目录收进 `.test-data`、嵌套 node_modules 或本地密钥。staged `source/` 的文件必须属于已验证 source index 的 canonical 项并保持原字节；正常构建的 static 资产另依其原有 receipt 允许，其他 runtime/material 文件继续按各自显式角色验证，不将它们当源码删除。额外 source 文件或已声明 source 字节漂移都会在归档创建前拒绝。
