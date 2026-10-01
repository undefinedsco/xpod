# Xpod CLI JavaScript 通知收集

目录客户端的独立产物包含应用 JavaScript、Bun runtime 和 AgentFS native helper。三者需要分别核查；本文件只记录应用 JavaScript 的打包输入和通知候选，不解除 [Bun runtime 发行缺口](bun-runtime-distribution.md) 或 [native 通知缺口](agentfs-license-evidence.md)。

## 同一次编译的输入证据

打包脚本在原有隔离 staging 编译中加入 `--metafile`，没有另跑一套不同 target/conditions 的解析器。使用该次编译生成的 input/output 数据，在删除 staging 前收集输入 SHA-256、贡献字节数、归属 package/version、package.json hash 与许可声明。Bun 将 metafile 定义为构建输入／输出和 import graph 信息；它不是完整许可审计或运行时 SBOM。[官方 metafile 文档](https://bun.com/docs/bundler#metafile)

作用域内保留全部输入，包括输出贡献为零的候选。每个 `licenses/javascript/index.json` 绑定最终 CLI 的 SHA-256，安装 manifest 再绑定该索引和原文 objects 的 hashes。原始 metafile 留在 build 目录，不随包分发；安装索引使用相对路径，不保存 staging 或构建机绝对路径。

包归属查找会跳过仅声明 `type: module` 的子目录 package.json，直到找到带 name/version 的包；按实际包根区分嵌套版本。编译输入通过 staging 的 node_modules 符号链接时也识别为依赖，不当成自有代码。无法识别的包、作用域外输入或无法规范化的绝对 external import 会使打包失败，不静默省略。

## 目前两平台候选

macOS ARM64 和 Linux ARM64 各有 228 个输入、15 个 package instances、12 份按内容去重的原始通知候选。包括 `jose` 5.10.0 和 4.15.9 两个版本。可取得的 package 根通知及显式 licenses/notices 目录内容均保留原始字节，没有改作者、换行或合并声明。

以下包在 npm 发行归档中没有独立通知文件；现在按 name/version 补充固定源码中的原文：

- `@inrupt/solid-client-authn-node@3.1.1`
- `@inrupt/solid-client-authn-core@3.1.1`

两个归档实际下载且 SHA-512 与 registry integrity 一致，发布元数据的 gitHead 均为 `94e54693a4fabf67c331c7b9af2bdb5e9d390992`。该提交的 [LICENSE](https://github.com/inrupt/solid-client-authn-js/blob/94e54693a4fabf67c331c7b9af2bdb5e9d390992/LICENSE) 包含 Inrupt Inc. 的版权与完整许可；原始字节已收集，SHA-256 为 `844fb3d1fcba1b7b2c04887fa108174167fe4ba40e5a4c6e67490c3b71731b49`。两个包共享同一原文对象，没有生成版权人或年份。

`supplements` 使用声明式 name/version 索引，校验原文对象路径与 hash，版本不匹配不套用；索引漂移、重复注册或越界对象会使构建失败。补充通知进入同一 packages/files 索引与安装 manifest，整体仍为 partial-collection。来源证据见 [固定版本记录](inrupt-notice-source-evidence.json)。

node 的已安装 `dist/index.mjs` 与下载归档字节相同；core 则包含本仓库已有的 `scripts/patch-inrupt-authn-refresh.js` 修改，依赖状态自检通过。索引保留的是实际编译输入哈希，不把 core 描述为未经修改的官方代码。MIT 原文保留，未变更原有认证代码或补丁。

## 验证与限制

包装回归覆盖嵌套不同版本、scope 包、type-only 子 manifest、node_modules 符号链接、CRLF 原文、未知许可／缺原文保留，以及作用域外输入和 external 绝对路径拒绝。真实两平台打包会核对索引与 CLI 哈希、原文对象与安装 manifest；macOS 执行解包后的 CLI，Linux 的跨编译安装校验仍不能替代目标 OS 执行。

这是 root/明确许可目录的候选收集，不覆盖所有模块的文件级版权、README 内嵌许可、源代码片段出处或 Bun 内置 polyfills。external imports 如实保留；metafile 中 external 标记也不是“运行时一定缺模块”的证明。安装流程没有因此移除任何现有发布门禁，候选和未知来源均保持 pending。
