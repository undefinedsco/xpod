# Xpod CLI JavaScript 通知收集

2026-10-01 用户选择不内嵌 Bun。当前目录客户端包含应用 JavaScript 和 AgentFS native helper，使用设备上已安装的 Bun/Node；本文件保留旧产物的输入统计，并记录同次 bundle 输入和通知候选的收集方式。当前包不分发 Bun runtime，[旧方案发行调查](bun-runtime-distribution.md) 留作追踪；[native 通知审查](agentfs-license-evidence.md) 仍需单独完成。

## 同一次编译的输入证据

打包脚本在原有隔离 staging 编译中加入 `--metafile`，没有另跑一套不同 target/conditions 的解析器。使用该次编译生成的 input/output 数据，在删除 staging 前收集输入 SHA-256、贡献字节数、归属 package/version、package.json hash 与许可声明。Bun 将 metafile 定义为构建输入／输出和 import graph 信息；它不是完整许可审计或运行时 SBOM。[官方 metafile 文档](https://bun.com/docs/bundler#metafile)

作用域内保留全部输入，包括输出贡献为零的候选。每个 `licenses/javascript/index.json` 绑定最终 CLI 的 SHA-256，安装 manifest 再绑定该索引和原文 objects 的 hashes。原始 metafile 留在 build 目录，不随包分发；安装索引使用相对路径，不保存 staging 或构建机绝对路径。

包归属查找会跳过仅声明 `type: module` 的子目录 package.json，直到找到带 name/version 的包；按实际包根区分嵌套版本。编译输入通过 staging 的 node_modules 符号链接时也识别为依赖，不当成自有代码。无法识别的包、作用域外输入或无法规范化的绝对 external import 会使打包失败，不静默省略。

## 目前两平台候选

旧的内嵌运行时产物在 macOS ARM64 和 Linux ARM64 各有 228 个输入、15 个 package instances、12 份按内容去重的原始通知候选。当前外部运行时产物有 229 个输入；实际数量以对应产物索引为准。包括 `jose` 5.10.0 和 4.15.9 两个版本。可取得的 package 根通知及显式 licenses/notices 目录内容均保留原始字节，没有改作者、换行或合并声明。

以下包在 npm 发行归档中没有独立通知文件；现在按 name/version 补充固定源码中的原文：

- `@inrupt/solid-client-authn-node@3.1.1`
- `@inrupt/solid-client-authn-core@3.1.1`

两个归档实际下载且 SHA-512 与 registry integrity 一致，发布元数据的 gitHead 均为 `94e54693a4fabf67c331c7b9af2bdb5e9d390992`。该提交的 [LICENSE](https://github.com/inrupt/solid-client-authn-js/blob/94e54693a4fabf67c331c7b9af2bdb5e9d390992/LICENSE) 包含 Inrupt Inc. 的版权与完整许可；原始字节已收集，SHA-256 为 `844fb3d1fcba1b7b2c04887fa108174167fe4ba40e5a4c6e67490c3b71731b49`。两个包共享同一原文对象，没有生成版权人或年份。

`supplements` 使用声明式 name/version 索引，校验原文对象路径与 hash，版本不匹配不套用；索引漂移、重复注册或越界对象会使构建失败。补充通知进入同一 packages/files 索引与安装 manifest，整体仍为 partial-collection。来源证据见 [固定版本记录](inrupt-notice-source-evidence.json)。

node 的已安装 `dist/index.mjs` 与下载归档字节相同；core 则包含本仓库已有的 `scripts/patch-inrupt-authn-refresh.js` 修改，依赖状态自检通过。索引保留的是实际编译输入哈希，不把 core 描述为未经修改的官方代码。MIT 原文保留，未变更原有认证代码或补丁。

2026-10-02 补充 `cliui@8.0.1/build/lib/string-utils.js` 的文件级声明。该文件实际进入 bundle，原文声明 npm, Inc. and Contributors / Artistic-2.0，包级 ISC 声明不能代替此声明。同一 supplements 索引保存未修改的原始文件、文件 SHA-256，以及其头部引用的固定 npm 提交 `4c65cd952bc8627811735bea76b9b110cc4fc80e` 的 [完整 LICENSE](https://github.com/npm/cli/blob/4c65cd952bc8627811735bea76b9b110cc4fc80e/LICENSE)。包级 ISC 与文件级来源并存；安装包及 application source kit 都包含这些原文对象。该补充没有更换依赖或增加依赖。

## 验证与限制

生成的 JS 前导现在单独绑定构建工具版本：Bun 1.3.8 对应固定提交 `b64edcb490b486fb8af90cb2cb2dc51590453064`、1127 bytes；历史 CI 使用的 Bun 1.3.12 对应 `700fc117a2fd01ac0201deaa6fa69c5557acb04f`、1639 bytes。原始 `runtime.js`、`ParseTask.zig`、根 LICENSE、前导本身及保守 esbuild 原文进入同一 content-addressed notice 索引。1.3.12 增加缓存/setter helper，未套用 1.3.8 的代码或行号。未知编译器版本、不同前导、通知 hash 或对象路径漂移都会使打包失败；安装包并不包含 Bun/Node/JSC 可执行文件。esbuild 的原始 MIT 文本用于保守归属保留，固定 Bun 源码中的 esbuild 引用不能证明 runtime 移植的精确基线，索引明确保留此限制。客户端运行时的最低版本要求与构建工具的已核对版本是两个不同边界。

2026-10-03 CI 构建工具升级至 Bun 1.4.2，新增独立的 `licenses/javascript/generated/1.4.2/` 材料，保留上述历史版本。[官方 tag](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) 对应提交 `744846f844374847c902b5e7fd59b4342a51ef99`，实际编译器 revision 为 `1.4.2+744846f84`。用现有隔离 `--cli-only --target darwin-arm64` 构建取得的前导为 1867 bytes，SHA-256 为 `a3e72d01f26bcd39142331f3a6d2033a495188dc06ab7b477f728f88afcff0a7`；其中 `__esm` 新增错误缓存与重抛，不能套用旧版前导。

该版本重新取得固定提交的 `runtime.js`、`LICENSE.md` 和新版 `src/bundler/ParseTask.rs` 原始字节；Node `createRequire` 分支位于后者 394–395 行，574 行拼接 runtime 与 target-specific 尾部。`computeChunks.rs:115` 仍引用固定 esbuild 提交 `cd832972927f1f67b6d2cc895c06a8759c1cf309`，其 LICENSE 重新下载后内容哈希与历史材料相同；这里只作保守归属保留，不把该引用当作 runtime 的精确移植基线。新索引逐项保存 source URL、SHA-256、helper 行号及真实前导，不新增生成器或放宽校验。此范围没有完成 Bun 全源码或内嵌运行时许可审计，也不证明跨平台执行或完整 CLI 发布通过。

包装回归覆盖嵌套不同版本、scope 包、type-only 子 manifest、node_modules 符号链接、CRLF 原文、未知许可／缺原文保留，以及作用域外输入和 external 绝对路径拒绝。真实两平台打包会核对索引与 CLI 哈希、原文对象与安装 manifest；macOS 执行解包后的 CLI，Linux 的跨编译安装校验仍不能替代目标 OS 执行。

这是 root/明确许可目录的候选收集，不覆盖所有模块的文件级版权、README 内嵌许可、源代码片段出处或 Bun 内置 polyfills。external imports 如实保留；metafile 中 external 标记也不是“运行时一定缺模块”的证明。安装流程没有因此移除任何现有发布门禁，候选和未知来源均保持 pending。
