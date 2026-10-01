# Bun runtime 发行记录

调查版本是 `bun-v1.3.8`，固定 commit 为 `b64edcb490b486fb8af90cb2cb2dc51590453064`。这是 Xpod CLI 独立编译产物的发行材料记录，不是完整许可准入结论。版本、原文来源、SHA-256、组件候选与未验证项见 [机器可读证据](bun-runtime-distribution-evidence.json)。

## 已核实的范围

`bun --compile` 复制 Bun 可执行文件并注入模块图，默认目标使用当前 runtime，其他目标可以下载对应 runtime。因此 CLI 的 TypeScript 依赖、Bun runtime 和 native helper 的 Cargo 依赖是三个独立范围。[固定版实现](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/src/StandaloneModuleGraph.zig)

固定版根 `LICENSE.md` 是 Bun 的 MIT 声明、静态库许可与重链接说明，没有完整 MIT 授权正文。它明确列出 JavaScriptCore/WebKit 与 tinycc 的 LGPL 许可；构建脚本有 JavaScriptCore、WTF 等静态库链接。不能以 `@types/bun` 中 Microsoft 的 MIT 文本代替 runtime 自己的版权来源。[根声明](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/LICENSE.md)、[链接脚本](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/cmake/targets/BuildBun.cmake)

官方 macOS/Linux ARM64 ZIP 均已下载且 SHA-256 与 GitHub digest 一致。两个 ZIP 只有可执行文件，没有 notices 或对象文件；本机 Bun 与 macOS 官方二进制字节相同。这仅描述已检查的两个归档，不能推论上游所有渠道均没有这些材料。`bun --print-license` 实际输出帮助，不能作为许可导出。

## 固定源码与重建入口

| 组件 | 同一 Bun commit 构建脚本中的 pin |
| --- | --- |
| WebKit | `9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea` |
| Zig | `c1423ff3fc7064635773a4a4616c5bf986eb00fe` |
| mimalloc | `ffa38ab8ac914f9eb7af75c1f8ad457643dc14f2` |
| tinycc | `12882eee073cfe5c7621bcfadf679e1372d4537b` |

固定版 [贡献文档](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/docs/project/contributing.mdx) 有 checkout 指定 WebKit commit、构建 JSC、再执行 `bun run build:local` 的步骤。[WebKit 固定源码](https://github.com/oven-sh/WebKit/tree/9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea) 与对应预构建 release 可访问。macOS ARM64 默认静态库归档现已下载并逐流检查：SHA-256 `c35435fd11a4efc2aa55a7d7f921beffe440a1d657a16e839cc13f1ba1daafa2` 与 [release asset](https://github.com/oven-sh/WebKit/releases/tag/autobuild-9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea) 的 digest 一致，package.json 标明同一 WebKit commit；包含 libJavaScriptCore.a（2,468,720,824 bytes）、libWTF.a（62,477,776 bytes）和 libbmalloc.a（8,044,160 bytes）。这是预构建库的材料证据，尚未执行修改库后的重建／重链接，也不证明它们与官方 Bun 二进制的链接输入逐项一致。

这些 pin 是固定源码的默认构建配置，不是发布二进制完整依赖闭包的证明。`process.versions` 中部分哈希来自硬编码旧值或 fallback，WebKit 显示值与 SetupWebKit 的 pin 不同，不能把版本字符串当作精确来源证明，也不能据此认定官方二进制被修改。[版本生成器](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/cmake/tools/GenerateDependencyVersions.cmake)

## 发行前尚需完成

- 当前 CLI 的平台依赖闭包与完整 notices，包括 WebKit 文件级通知、内置 JS 和 Zig runtime 范围。
- 下游编译 CLI 对应的完整源码／对象、接口、修改及构建操作材料；修改 LGPL 库后的重建或重链接试验是验收这些材料可用性的方式，不把某一次试验本身说成许可证指定的唯一形式。[WebKit 所附 LGPL 第6节](https://github.com/oven-sh/WebKit/blob/9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea/Source/JavaScriptCore/COPYING.LIB)允许应用对象代码和／或源码方案；仅保存几个 URL／构建命令仍不足。
- Bun 自身完整版权通知来源，以及应用 TypeScript 依赖的独立通知清单。

原始调查材料保存在忽略目录 `.test-data/agent-directory-workers/bun-runtime-notices/`，包含 140 项材料的 hashes 与 28 份组件许可原文。仓库内索引保留固定 URL 和内容哈希，便于后续复核，不将这些候选直接标成整个 runtime 已清理完成。public gate 继续阻止。
