# Normal AFS 生产工具的源码字节契约

正常 AFS supply 在 POSIX producer 记录工具文件的原始 SHA256 与长度，消费者必须用同一 Git 源码的相同字节验证。Git 的 clean 状态只保证经过 Git 文本转换后相同；Windows 的 `core.autocrlf=true` 可以将 clean checkout 转为 CRLF，不能替代原始字节一致性。

`.gitattributes` 为 `scripts/lib/legacy-afs-supply.cjs` 导出的 `tools` 当前 12 个文本文件声明 `text eol=lf`，使 POSIX 和 Windows checkout 均保留这些 Git blob 的 LF 字节。测试直接读取该清单并加入下述唯一跨平台 manifest，共十三文件，在真实临时 Git 仓库启用 `core.autocrlf=true`，逐文件验证 checkout 等于 Git blob、属性生效且状态 clean；移除属性后复现首工具 CRLF 差异。新增工具时必须同步对应属性，测试会检查覆盖。

这只约束生产工具的 checkout，不修改原件、读取器、SHA 校验或二进制文件。现有 licenses 的 `-text` 规则保留。真实工具字节被修改仍由原有 verifier 拒绝。历史 CI 原件继续绑定历史 source/run/attempt，修补需要新一轮 Windows 原件验收。

完整跨平台契约还包含 `packages/xpod-afs/package.json`，其 `text eol=lf` 属性与十二工具一起构成当前十三文件集合。真实 Git 夹具读取唯一工具清单并加入这一个 manifest；portable verifier 覆盖十二工具不变、仅 manifest 转 CRLF 或发生其他内容修改均拒绝，恢复 LF 原字节后完整校验通过。

审计依据：`legacy-afs-supply.verify()` 的工具循环将当前 checkout 与 POSIX producer 的 `producerTools` 原始字节比较，随后将当前私有 AFS manifest 与原始 AFS stage 的 `sourceManifestSHA256` 比较。`verifyCustody()` 和最终 `verifyRetainedSupply()` 均复用这条完整契约。

后续边界：CLI `source-inputs` 对比保留的 producer 源快照，CLI/client 原包、AFS stage、material index 与 npm 元数据均使用保留原件，不读取 Windows checkout 的对应文件。`root-registry-supply` 的四个工具引用、构建前后快照、七个本地工作区包 payload 对比来自同一个消费者主机；`sourceAuthority` 对 manifests 作语义解析。外部 Git producer 在 checkout 前已设置仓库本地 `core.autocrlf=false`，清理源目录后从保留的 manifest/snapshot/payload 原件读回。不得把这些本机或原件比较改为归一化读取。

历史复现：head `465de1ca568fb0c80620d2a888b16eea1ac884fb` 的 Legacy run `38861481098` attempt 1，Windows Bun 24/25 已越过十二工具校验，在源 manifest 校验处失败。Git LF manifest 为 13,148 字节，SHA256 `5cdd40f78be50b44a45bad7b0b22463b9555ed580f4dc77a365b3d7c3d24aee4`；精确 LF→CRLF 后为 13,508 字节，SHA256 `94dc355ee628010ddd8039f1f8b2f4ef3fc045f5ac28116fc9e695afff9fbe8f`，与原日志断言一致。这证明观察到的字节差异，但原日志未记录 Windows 的 `core.autocrlf` 配置值。此审计只覆盖当前供给链，新增跨平台字节比较时必须同步明确 checkout 契约与测试。
