# Bun runtime 发行记录

当前状态：用户于2026-10-01明确“不内嵌 Bun”。客户端发布主线已改为外部 Bun/Node + JavaScript payload；以下保留为旧内嵌预览的历史研究，不作为当前无内嵌运行时产物的发布要求。源码基线重建因归档缺 Git HEAD 产生缺失版本常量，尚未完成；相关进程已停止，未执行 JSC 修改或重链接。原始归档、构建输入及日志保留用于追踪。

调查版本是 `bun-v1.3.8`，固定 commit 为 `b64edcb490b486fb8af90cb2cb2dc51590453064`。这是 Xpod CLI 独立编译产物的发行材料记录，不是完整许可准入结论。版本、原文来源、SHA-256、组件候选与未验证项见 [机器可读证据](bun-runtime-distribution-evidence.json)。

## 已核实的范围

`bun --compile` 复制 Bun 可执行文件并注入模块图，默认目标使用当前 runtime，其他目标可以下载对应 runtime。因此 CLI 的 TypeScript 依赖、Bun runtime 和 native helper 的 Cargo 依赖是三个独立范围。[固定版实现](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/src/StandaloneModuleGraph.zig)

固定版根 `LICENSE.md` 是 Bun 的 MIT 声明、静态库许可与重链接说明，没有完整 MIT 授权正文。它明确列出 JavaScriptCore/WebKit 与 tinycc 的 LGPL 许可；构建脚本有 JavaScriptCore、WTF 等静态库链接。不能以 `@types/bun` 中 Microsoft 的 MIT 文本代替 runtime 自己的版权来源。[根声明](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/LICENSE.md)、[链接脚本](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/cmake/targets/BuildBun.cmake)

官方 macOS/Linux ARM64 ZIP 均已下载且 SHA-256 与 GitHub digest 一致。两个 ZIP 只有可执行文件，没有 notices 或对象文件；本机 Bun 与 macOS 官方二进制字节相同。这仅描述已检查的两个归档，不能推论上游所有渠道均没有这些材料。`bun --print-license` 实际输出帮助，不能作为许可导出。

## 固定源码与重建入口

固定 Bun commit 的完整源码归档现已下载，SHA-256 为 `bf521d29d939085f1645a914ff48bb1ac19818682133fc8c1dde1b1012dfa38e`。对未截断的 GitHub Git tree 逐项核对 Git blob hash，12,458 个普通文件和 9 个内部符号链接均与固定版本一致；归档和验证结果保存在调查材料的 `rebuild/` 下。这补齐了 Bun 源码树，尚未构建 Bun，也不代表 WebKit、工具链和其他链接输入的闭包已齐备。

| 组件 | 同一 Bun commit 构建脚本中的 pin |
| --- | --- |
| WebKit | `9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea` |
| Zig | `c1423ff3fc7064635773a4a4616c5bf986eb00fe` |
| mimalloc | `ffa38ab8ac914f9eb7af75c1f8ad457643dc14f2` |
| tinycc | `12882eee073cfe5c7621bcfadf679e1372d4537b` |

固定版 [贡献文档](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/docs/project/contributing.mdx) 有 checkout 指定 WebKit commit、构建 JSC、再执行 `bun run build:local` 的步骤。[WebKit 固定源码](https://github.com/oven-sh/WebKit/tree/9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea) 与对应预构建 release 可访问。macOS ARM64 默认静态库归档现已下载并逐流检查：SHA-256 `c35435fd11a4efc2aa55a7d7f921beffe440a1d657a16e839cc13f1ba1daafa2` 与 [release asset](https://github.com/oven-sh/WebKit/releases/tag/autobuild-9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea) 的 digest 一致，package.json 标明同一 WebKit commit；包含 libJavaScriptCore.a（2,468,720,824 bytes）、libWTF.a（62,477,776 bytes）和 libbmalloc.a（8,044,160 bytes）。这是预构建库的材料证据，尚未执行修改库后的重建／重链接，也不证明它们与官方 Bun 二进制的链接输入逐项一致。

这些 pin 是固定源码的默认构建配置，不是发布二进制完整依赖闭包的证明。`process.versions` 中部分哈希来自硬编码旧值或 fallback，WebKit 显示值与 SetupWebKit 的 pin 不同，不能把版本字符串当作精确来源证明，也不能据此认定官方二进制被修改。[版本生成器](https://github.com/oven-sh/bun/blob/b64edcb490b486fb8af90cb2cb2dc51590453064/cmake/tools/GenerateDependencyVersions.cmake)

## 应用侧重建材料

Xpod CLI 构建现在随包保存实际 staging 源码、选中依赖的已安装字节与嵌套目录、lockfile、原始 notices 和重建脚本。源码清单绑定 CLI hash、目标与 source identity，安装检查逐个验证归档成员、大小和 hash，不以一个清单文件代表其余材料已存在。详见 [源码包说明](../packages/xpod-cli/APPLICATION-SOURCE-README.md)。

macOS ARM64 独立重建已使用 Bun 1.3.8 跑通：2,007 个文件、228 个实际编译输入；重建输入的路径/hash 集合与原始编译一致，生成二进制的 version/help/status 可执行。脚本允许不同的兼容 Bun；同平台不传会选择另一 runtime 的 cross-target 参数，原始 compiler hash 只用于溯源。源码或 notice 漂移会拒绝重建/安装。

Linux ARM64 也在断网 Debian 容器中使用独立源码包和已校验的官方 Bun1.3.8 成功重建：GNU tar 检查2,017个文件，228个编译输入的路径/hash集合同样一致，CLI version/help/status通过。容器只挂载源码归档、Bun可执行文件和本次证据输出目录，不挂载仓库或依赖缓存。此检查不使用FUSE，不代表重新验收Linux挂载。

这是应用侧的验证。此次实际执行仍使用原版 Bun，没有构建修改后的 JSC、重新链接 Bun，或补齐 runtime/toolchain/native helper 的对应源码闭包。因此 public gate 保持阻止，不能把应用源码包或一次成功编译视为完整发行准入。

## 发行前尚需完成

- 当前 CLI 的平台依赖闭包与完整 notices，包括 WebKit 文件级通知、内置 JS 和 Zig runtime 范围。
- 下游编译 CLI 对应的完整源码／对象、接口、修改及构建操作材料；修改 LGPL 库后的重建或重链接试验是验收这些材料可用性的方式，不把某一次试验本身说成许可证指定的唯一形式。[WebKit 所附 LGPL 第6节](https://github.com/oven-sh/WebKit/blob/9a2cc42ae1bf693a0fd0ceb9b1d7d965d9cfd3ea/Source/JavaScriptCore/COPYING.LIB)允许应用对象代码和／或源码方案；仅保存几个 URL／构建命令仍不足。
- Bun 自身完整版权通知来源，以及应用 TypeScript 依赖的独立通知清单。

原始调查材料保存在忽略目录 `.test-data/agent-directory-workers/bun-runtime-notices/`，包含 140 项材料的 hashes 与 28 份组件许可原文。仓库内索引保留固定 URL 和内容哈希，便于后续复核，不将这些候选直接标成整个 runtime 已清理完成。public gate 继续阻止。
