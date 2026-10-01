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

许可声明已有证据；未决项应记录为具体的正文/版权来源和发行 notices 完整性，而非断言 CLI 未获许可。仍需补齐 AgentFS 自身应保留的完整通知来源，以及实际 target/features 的 transitive notices。现有根 LICENSE 文件检查仍保守阻止公开发行，不能用通用 bypass 解除；未来应改为绑定固定 commit 的来源记录和文件 hash 校验。Xpod 根包也仅有 MIT 元数据，自己的完整许可文件另需落实。

## Target/features 依赖清单增量

已保存 [macOS ARM64 清单](agentfs-native-license-inventory-macos-arm64.json) 与 [Linux ARM64 清单](agentfs-native-license-inventory-linux-arm64.json)。身份集合来自匹配目标的 `cargo tree --edges normal,build`，分别包含 275/284 个包（含 helper），第三方为 274/283 个；不直接把 Cargo metadata 的整个解析图当作实际目标依赖。清单包含构建依赖，角色分类仅作调查参考，不能宣称所有列出的代码都链接进最终二进制。Linux 的本地 FUSE 补丁只改变 AgentFS 两项 source 身份，构建以 `--locked` 保留根锁定版本。

另保存三份固定来源原文，完整来源、hash 和归属见 [native notices](../packages/xpod-cli/licenses/native/README.md)：Turso（MIT）、SimSIMD（Apache-2.0）及 Linux C-backend libaegis（MIT）。包装脚本逐份核对 hash 后复制；libaegis 仅进入 Linux 目标包。

尚缺 AgentFS、agentfs-sdk、genawaiter 0.99.1、genawaiter-macro 0.99.1、pack1 1.1.0 的原始完整通知来源。这不表示它们没有声明许可。其余已扫描候选原文与嵌套通知现已收集，例如 ring 的 Apache-2.0 与 ISC、option-ext 的 MPL-2.0、Unicode 与 vendored C 代码；仍需审查实际发行义务和源码告知。cfgblock 的 license_file 是 Apache 版权通知，需保留完整条款。上述清单不覆盖编译 CLI 中的 Bun runtime 和 TypeScript 依赖，不能作为整个发行包的许可完成证明。

Linux helper 实际动态链接系统 OpenSSL 3；Rust openssl-sys 的 MIT 仅属于 wrapper。外部系统库需求已记录，若以后同时分发 `.so` 或系统镜像，必须按该产物版本附系统许可原文。清单、三份补充原文与运行依赖证据均未解除 public gate。

## 原文收集进入安装包

`packages/xpod-cli/licenses/native/collection/` 已实际收集原始 Cargo 通知候选：macOS 481、Linux 502 个文件引用，按 SHA-256 去重保存原文，并保留 package/version、原始相对路径、source archive 与构建角色。包括 ring 的嵌套通知、Unicode、mimalloc 和 MPL 原文；不改作者、不合并许可表达式。构建按目标选取文件，先核对所有原文 hash，再复制，并将输出 hash 写入安装 manifest。缺文件或内容漂移会使构建失败。

收集过程仍不是许可完成证明：扫描候选可能包含 build-only 的其他平台代码，Turso/SimSIMD 补充原文独立保存，尚缺的包通知、Bun/TS runtime、外部系统库与 MPL 对应源码告知仍需落实。public gate 保持阻止。完整来源索引见 [collection README](../packages/xpod-cli/licenses/native/collection/README.md)。
