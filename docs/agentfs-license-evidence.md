# AgentFS 固定版本许可证据

2026-10-01。仅记录发行工程证据，不替权利人补写版权声明。

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

许可声明已有证据；未决项按具体发行材料记录，而非断言 CLI 未获许可。现已将根 LICENSE 文件名门槛替换为绑定固定 commit 的声明／条款索引和文件 hash 校验，见下方增量；没有通用 bypass。实际 target/features 的整体 obligations、Bun 对应源码／重建材料和 Xpod 自身通知仍需落实。

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

## Bun runtime 发行范围

`bun --compile` 的独立 CLI 包含 Bun runtime，不能仅用 TypeScript 依赖或 Cargo 清单覆盖。固定 Bun 1.3.8 的静态库、源码取得与重链接材料调查已保存为 [Bun runtime 发行记录](bun-runtime-distribution.md)。目前只是固定版本证据，尚未验证修改 LGPL 库后重建当前 CLI；public gate 继续阻止。

应用 JavaScript 已接入 [同次编译输入与通知收集](xpod-cli-javascript-notices.md)：两平台各15个 package instances、12份去重原文；两个 Inrupt 3.1.1 包的独立原文已从固定源码补充，其他审查范围仍保留。该清单绑定实际 CLI 哈希，不是整个 Bun runtime 的清单，也不是完整文件级版权审计。

## 三个 registry crate 的固定源码复核

`genawaiter@0.99.1`、`genawaiter-macro@0.99.1`、`pack1@1.1.0` 的实际下载归档 SHA-256 与 Cargo.lock 一致。发布归档中的 `.cargo_vcs_info.json` 分别指向 `b7e93c2d444a5c63e94e14f6809c8dc27785c1c7`、`f48046a9f66fbd2e535d5614fa7fe0d0b1a6a046`、`fb975e9d592d94fe4624908ebfae3a71c984d3ff`。逐文件比较 macOS/Linux 构建缓存与归档，分别31/4/20个文件全部字节一致。

已读取三个固定 commit 的完整、未截断文件树和 README。树中没有名称匹配 LICENSE/NOTICE/COPYING/COPYRIGHT 的独立文件，发行归档中的检索只找到 Cargo 许可声明。这不能推成上游没有许可，或上游所有文件均无版权通知。[Cargo 文档](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)明确区分发行许可表达式和许可文件。

声明分别保留为 `MIT`、`MIT/Apache-2.0`、`Zlib OR Apache-2.0 OR MIT`；不将作者字段改写成版权人／年份，也不替上游生成一份声称是原文的 LICENSE。版本、声明、归档 hash、源码 commit、树 hash 与比较结果见 [固定来源证据](native-missing-notice-source-evidence.json)。不能用文件数量充当整体准入。

## 声明材料随包增量

[单一补充索引](../packages/xpod-cli/licenses/native/declarations/index.json) 保存五项声明的原文、版本和来源；三个 registry 包明确选择 MIT 分支。标准正文来自 [SPDX v3.27.0](https://github.com/spdx/license-list-data/blob/v3.27.0/text/MIT.txt)，原样保存，包括字面占位符；它被标成标准模板，不冒充上游版权通知。已有原始 notices 继续随包，不替换、不猜作者／年份。依 [Cargo 字段定义](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields)，许可声明和特定文件名是不同事实。

构建验证声明文本、所选 alternative、固定 engine commit、目标包版本和全部对象 hash 后才复制。安装 manifest 的 `selectedEnginePin.licenseEvidence` 绑定索引 hash，安装校验检查其内容、全部对象及 manifest 覆盖。旧 preview 仍可读取；公开门槛要求材料匹配，根 LICENSE 是否存在只作信息记录。`sdkLicenseStatus` / `cliLicenseStatus` 的 verified 仅描述这份固定声明材料，不表示整个 helper 或 Bun 已完成发行审核。
