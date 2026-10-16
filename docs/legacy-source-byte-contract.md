# Normal AFS 生产工具的源码字节契约

正常 AFS supply 在 POSIX producer 记录工具文件的原始 SHA256 与长度，消费者必须用同一 Git 源码的相同字节验证。Git 的 clean 状态只保证经过 Git 文本转换后相同；Windows 的 `core.autocrlf=true` 可以将 clean checkout 转为 CRLF，不能替代原始字节一致性。

`.gitattributes` 为 `scripts/lib/legacy-afs-supply.cjs` 导出的 `tools` 当前 12 个文本文件声明 `text eol=lf`，使 POSIX 和 Windows checkout 均保留这些 Git blob 的 LF 字节。测试直接读取该清单，并在真实临时 Git 仓库启用 `core.autocrlf=true`，逐文件验证 checkout 等于 Git blob、属性生效且状态 clean；移除属性后复现首工具 CRLF 差异。新增工具时必须同步对应属性，测试会检查覆盖。

这只约束生产工具的 checkout，不修改原件、读取器、SHA 校验或二进制文件。现有 licenses 的 `-text` 规则保留。真实工具字节被修改仍由原有 verifier 拒绝。历史 CI 原件继续绑定历史 source/run/attempt，修补需要新一轮 Windows 原件验收。
