# AgentFS 固定版本许可证据

2026-10-02。仅记录发行工程证据，不替权利人补写版权声明。当前分发采用外部 Bun/Node 运行时；下文早期内嵌方案的 Bun/JSC 待办是历史记录。

2026-10-02 源码分发核对增量：独立 native source kit 现在原样复制根 `LICENSE` 至 `licenses/xpod/LICENSE`，并将它列为必需材料。完整 Cargo vendor 树含 340 个 registry 包，不能把某目标的 275/284 项通知候选清单当作该源码树的范围或最终二进制链接图。原有 libgit2、ring、其他平台代码的原始许可文件仍在 vendor 树中。

源码树中的 `valuable@0.1.1` 发行归档缺少 README 引用的 LICENSE。依据 `.cargo_vcs_info.json` 固定提交 `9efc29b6e58cef28f6566a47aa7e142a55fead77`，已补入 [原始 LICENSE](https://github.com/tokio-rs/valuable/blob/9efc29b6e58cef28f6566a47aa7e142a55fead77/LICENSE) 和来源/hash 记录，位于 `licenses/native/valuable-0.1.1/`。该补充只陈述源码分发范围，不证明它链接进 helper。旧源码包没有这些新增材料，需要重新导出；旧 receipt 的 source-kit hash 不能改写为新索引。

两平台现有 helper 的已定义符号确认 `std/core/alloc/compiler_builtins`，工具链固定为 `nightly-2026-09-30`、Rust commit `5c543b0b8c73c7b72bc8284ced4fb22ead15734d`。该工具链的 `COPYRIGHT-library.html`、Unicode 原文及固定 [Rust MIT](https://github.com/rust-lang/rust/blob/5c543b0b8c73c7b72bc8284ced4fb22ead15734d/LICENSE-MIT)/Apache/compiler-builtins/libm/LLVM 通知共十份，现已接入 `runtimeNotices` 分发索引。所有原文先核对 hash，再进入安装 manifest 和源码包。完整 helper 打包必须提供源码包和匹配 native receipt，并核对实际 compiler commit/toolchain，不能把不同编译器的通知套用过去。保守通知集合不是精确 linker map，源码包不包含整个 Rust 编译器或标准库实现；公开发行门禁保持 pending。

固定版本 `0a014ebd4918615baff589ed17486e557e7c6a23` 的 [README](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/README.md#L209) 明确声明整个项目为 MIT；Rust [SDK Cargo.toml](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/sdk/rust/Cargo.toml#L6) 也声明 MIT。CLI Cargo.toml 缺少字段属于元数据缺口，不能据此将全项目声明说成“没有许可”。

固定 [完整树](https://api.github.com/repos/tursodatabase/agentfs/git/trees/0a014ebd4918615baff589ed17486e557e7c6a23?recursive=1) 未包含根 LICENSE/COPYING；README 链接的 LICENSE.md 缺失。[固定提交祖先的 LICENSE.md 历史查询](https://api.github.com/repos/tursodatabase/agentfs/commits?sha=0a014ebd4918615baff589ed17486e557e7c6a23&path=LICENSE.md&per_page=100) 为空。标准 MIT 条款可由 [SPDX](https://spdx.org/licenses/MIT.html) 提供，但不是上游 AgentFS 自身的版权声明来源；不能把第三方文件中的作者改成 Turso 或猜年份。

## 已保存的原文

`packages/xpod-cli/licenses/agentfs/` 保存两个同 pin 原始文件，复制前核对 SHA-256。

| 文件 | 许可/原权利人 | SHA-256 |
| --- | --- | --- |
| LICENSE-fuser.md | MIT；Christopher Berner、Andreas Neuhaus | `e5de4041803ce3d7b1b269165677baabbeb9e43252ad176a877bd544ca04d748` |
| LICENSE-nfsserve.md | BSD-3-Clause；XetData | `99cbb513e18ecf180a25f5c2e8f2980a91ead909c191fd4c34323497d13a3c74` |

[上游 c450b813 提交](https://github.com/tursodatabase/agentfs/commit/c450b813fb00bf447d155efff637a9d5f0e71620) 已将旧 AGPL zerofs_nfsserve 换成 vendored BSD nfsserve。当前两份 vendored 代码不能仅凭 Cargo.lock 扫描发现，必须实际附 notices。README 原文 SHA-256 为 `4614b1d285011a38382cf9d5bcbf5d826e175748000a14ec7eb939e1cbc62f1c`。

## 剩余发行门槛

许可声明已有证据；未决项按具体发行材料记录，而非断言 CLI 未获许可。现已将根 LICENSE 文件名门槛替换为绑定固定 commit 的声明／条款索引和文件 hash 校验，见下方增量；没有通用 bypass。当前包不含 Bun/Node/JSC 可执行文件，其历史重链接待办不适用于当前分发。Xpod 原始 LICENSE、目标通知、声明、JS 生成前缀与 native 源码材料已随包核对；公开准入仍需当前产物审查、clean commit 安装／挂载和实际 Gateway 验收，不以本页材料清单自动解除。

## Target/features 依赖清单增量

已保存 [macOS ARM64 清单](agentfs-native-license-inventory-macos-arm64.json) 与 [Linux ARM64 清单](agentfs-native-license-inventory-linux-arm64.json)。身份集合来自匹配目标的 `cargo tree --edges normal,build`，分别包含 275/284 个包（含 helper），第三方为 274/283 个；不直接把 Cargo metadata 的整个解析图当作实际目标依赖。清单包含构建依赖，角色分类仅作调查参考，不能宣称所有列出的代码都链接进最终二进制。Linux 的本地 FUSE 补丁只改变 AgentFS 两项 source 身份，构建以 `--locked` 保留根锁定版本。

另保存三份固定来源原文，完整来源、hash 和归属见 [native notices](../packages/xpod-cli/licenses/native/README.md)：Turso（MIT）、SimSIMD（Apache-2.0）及 Linux C-backend libaegis（MIT）。包装脚本逐份核对 hash 后复制；libaegis 仅进入 Linux 目标包。

最初收集未找到 AgentFS、agentfs-sdk、genawaiter 0.99.1、genawaiter-macro 0.99.1、pack1 1.1.0 的独立 LICENSE；现以原始发行声明加标准条款补充，见下方增量。其余已扫描候选原文与嵌套通知保持原样，例如 ring 的 Apache-2.0 与 ISC、option-ext 的 MPL-2.0、Unicode 与 vendored C 代码；仍需审查整体发行义务。cfgblock 的 license_file 是 Apache 版权通知，需保留完整条款。上述清单不覆盖编译 CLI 中的 Bun runtime 和 TypeScript 依赖，不能作为整个发行包的许可完成证明。

Linux helper 实际动态链接系统 OpenSSL 3；Rust openssl-sys 的 MIT 仅属于 wrapper。外部系统库需求已记录，若以后同时分发 `.so` 或系统镜像，必须按该产物版本附系统许可原文。清单、三份补充原文与运行依赖证据均未解除 public gate。

## 原文收集进入安装包

`packages/xpod-cli/licenses/native/collection/` 已实际收集原始 Cargo 通知候选：macOS 481、Linux 502 个文件引用，按 SHA-256 去重保存原文，并保留 package/version、原始相对路径、source archive 与构建角色。包括 ring 的嵌套通知、Unicode、mimalloc 和 MPL 原文；不改作者、不合并许可表达式。构建按目标选取文件，先核对所有原文 hash，再复制，并将输出 hash 写入安装 manifest。缺文件或内容漂移会使构建失败。

收集过程仍不是许可完成证明：扫描候选可能包含 build-only 的其他平台代码，Turso/SimSIMD 补充原文独立保存，尚缺的包通知、Bun/TS runtime 与外部系统库义务仍需落实；option-ext 对应源码告知已补充，见下节。public gate 保持阻止。完整来源索引见 [collection README](../packages/xpod-cli/licenses/native/collection/README.md)。

## MPL 源码告知

安装包 NOTICES 现在明确指出 option-ext 0.2.0 的 MPL-2.0 源码、原文许可位置及 [对应 crate 源归档](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate)。实际下载归档的 SHA-256 为 `04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d`，与 Cargo.lock 一致；两平台 source cache 中的归档文件也逐份与下载内容一致，没有修改。按 [MPL 2.0 第3.2节](https://www.mozilla.org/en-US/MPL/2.0/) 提供源码取得方式，不把该文件级许可推成整个 helper 的许可。这个告知只处理对应组件，不解除其他发行缺口。

## Bun runtime 发行范围（历史内嵌方案）

2026-10-01 用户明确选择不内嵌 Bun。当前 CLI 是使用设备上已安装 Bun/Node 的 JS bundle，包内不分发运行时；下段记录旧产物的调查。当前准入仍需完成 JS/native 产物审查，历史 Bun/JSC 重链接未完成不再是新分发方案的阻断项。

`bun --compile` 的独立 CLI 包含 Bun runtime，不能仅用 TypeScript 依赖或 Cargo 清单覆盖。固定 Bun 1.3.8 的静态库、源码取得与重链接材料调查已保存为 [Bun runtime 发行记录](bun-runtime-distribution.md)。目前只是固定版本证据，尚未验证修改 LGPL 库后重建当前 CLI；public gate 继续阻止。

应用 JavaScript 已接入 [同次编译输入与通知收集](xpod-cli-javascript-notices.md)：两平台各15个 package instances、12份去重原文；两个 Inrupt 3.1.1 包的独立原文已从固定源码补充，其他审查范围仍保留。该清单绑定实际 CLI 哈希，不是整个 Bun runtime 的清单，也不是完整文件级版权审计。

## 三个 registry crate 的固定源码复核

`genawaiter@0.99.1`、`genawaiter-macro@0.99.1`、`pack1@1.1.0` 的实际下载归档 SHA-256 与 Cargo.lock 一致。发布归档中的 `.cargo_vcs_info.json` 分别指向 `b7e93c2d444a5c63e94e14f6809c8dc27785c1c7`、`f48046a9f66fbd2e535d5614fa7fe0d0b1a6a046`、`fb975e9d592d94fe4624908ebfae3a71c984d3ff`。逐文件比较 macOS/Linux 构建缓存与归档，分别31/4/20个文件全部字节一致。

已读取三个固定 commit 的完整、未截断文件树和 README。树中没有名称匹配 LICENSE/NOTICE/COPYING/COPYRIGHT 的独立文件，发行归档中的检索只找到 Cargo 许可声明。这不能推成上游没有许可，或上游所有文件均无版权通知。[Cargo 文档](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)明确区分发行许可表达式和许可文件。

声明分别保留为 `MIT`、`MIT/Apache-2.0`、`Zlib OR Apache-2.0 OR MIT`；不将作者字段改写成版权人／年份，也不替上游生成一份声称是原文的 LICENSE。版本、声明、归档 hash、源码 commit、树 hash 与比较结果见 [固定来源证据](native-missing-notice-source-evidence.json)。不能用文件数量充当整体准入。

## 声明材料随包增量

[单一补充索引](../packages/xpod-cli/licenses/native/declarations/index.json) 保存五项声明的原文、版本和来源；三个 registry 包明确选择 MIT 分支。标准正文来自 [SPDX v3.27.0](https://github.com/spdx/license-list-data/blob/v3.27.0/text/MIT.txt)，原样保存，包括字面占位符；它被标成标准模板，不冒充上游版权通知。已有原始 notices 继续随包，不替换、不猜作者／年份。依 [Cargo 字段定义](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)，许可声明和特定文件名是不同事实。

构建验证声明文本、所选 alternative、固定 engine commit、目标包版本和全部对象 hash 后才复制。安装 manifest 的 `selectedEnginePin.licenseEvidence` 绑定索引 hash，安装校验检查其内容、全部对象及 manifest 覆盖。旧 preview 仍可读取；公开门槛要求材料匹配，根 LICENSE 是否存在只作信息记录。`sdkLicenseStatus` / `cliLicenseStatus` 的 verified 仅描述这份固定声明材料，不表示整个 helper 或 Bun 已完成发行审核。

## Native 对应源码与离线构建材料

[native kit 指引](../packages/xpod-cli/NATIVE-SOURCE-README.md) 和导出脚本保存固定 AgentFS 原始 Git 归档、完整打补丁源码、两份补丁、原始 helper manifest/lock、仅移除两个 Git source identity 的 working manifest/lock，以及完整 Cargo vendor 源码。340 个 registry packages 的版本与 archive checksums 保持原 lock；校验同时覆盖每个 crate 的 `.cargo-checksum.json` 与全部源文件，C/ASM 子目录也保留，不能只交 Rust 文件。

此材料不改写缺失的上游版权声明，也不以 vendor 文件数量代替完整许可审查。现有固定原文与补充声明一起保存。完整 helper 安装包必须通过成对的 `--native-sources` / `--native-receipt` 参数携带源码归档、索引和实际构建回执；验证源码每个成员、补丁已应用、lock 转换、helper/engine/target 哈希绑定。原始归档及重建脚本的所有本地导入都属于必需材料。

重建仅复制已验证文件到临时目录，使用空 Cargo home、显式已安装 cargo/rustc 和 `--release --frozen`。外部 `GIT_*` 环境被清除，Git ceiling 位于上级目录，避免母仓库导致 `git apply` 静默跳过或 `git describe` 嵌入母仓库版本。nightly、标准库、编译器/SDK/sysroot、OpenSSL/liblzma/gcc_s 等仍是外部前置；本材料不包括其对应源码，不包括 Bun/JSC。Cargo offline 不隔离任意 build script 网络，需要实际断网构建作为独立证据。源码、构建回执或 native 回归成功均不解除整体公开发行门槛。
