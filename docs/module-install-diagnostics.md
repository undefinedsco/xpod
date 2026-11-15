# 模块安装阶段诊断

重复的 Darwin x64 安装失败目前只能定位到测试的 10 秒 watchdog；现有 SQLite warning 不能证明底层耗时原因。此变更增加观察能力，不调整安装、测试或父进程预算，也不自动重试。

使用 `xpod module install afs --version <exact-version> --diagnostics` 显式开启；CSS/API 使用同一入口。默认不输出诊断，正常 JSON stdout 不变。开启时 stderr 同步输出最多 64 条 JSON 行，只含固定 kind、阶段、状态、单调毫秒耗时及阶段持续时间。阶段开始在动作之前输出，因此同步解压被外部终止时仍有开始标记。

计时位置在 `packages/xpod-cli/src/module-store.ts`：锁获取完成回调、metadata、归档下载与哈希、tar 预检、同步解压、manifest/权限规范化、库存 manifest/文件哈希/目录遍历、发布、清理。锁获取不包含安装动作；默认静默的 verify 调用不输出事件。观察回调失败不替换原操作结果或错误。阶段白名单与输出上限只定义于 `module-install-diagnostics.ts`，不输出文件路径、registry URL、凭据或异常字符串。

AFS 原有安装消费者测试在安装命令启用此选项。`prepare-module-inputs.ts` 复用原有 stderr 原件和 safe 导出：只有 actual wait、raw、进程组已关闭且原文摘要匹配后，才读取最多 64 KiB / 1024 行，提取固定且顺序有效的阶段前缀。成功 receipt 的安装阶段也保留这些计时，方便比较；被杀时允许最后一条为 started，不能由此断言该阶段就是根因。

未知字段、阶段、负数/非数值/越界/倒序耗时或超过 64 条的轨迹不会被当成完整诊断；导出保留有效前缀并标记截断。未关闭或原文已变化时不导出阶段计时。诊断不是验收资格，原失败状态、信号、watchdog、wait/raw/group 事实保持独立。


## 真实 AFS 安装消费者的阶段预算

最终 staging `2709823d432060c16f5874ab7345c1b709b1d703` 的四平台运行
`39012141714` 中，Darwin x64 的完整公共 CLI 安装被历史 10 秒 watchdog
中断。该归档库存为 3260 文件；解压用时 6033.746ms，完整文件校验在
8130.542ms 开始，10027.207ms 收到超时 TERM，随后实际 close 和进程组关闭。
它不是 180 秒构建超时，也没有证据说明 CPU/IO 故障。其他三个平台在同次
运行完成安装。先前 db135f96 的 x64 安装为 7698.598ms；这是独立历史观察，
不能用于授予本次源码验收资格。成功 safe receipt 也包含安装子阶段计时。

10 秒原本来自早期 ModuleStore 夹具中的统一小命令 watchdog，后来公共 CLI
完整归档安装也沿用了它。测试预算现按唯一阶段声明分型：仅
`node-cli-install` 和 `bun-cli-install` 固定为 15 秒，其余命令保持 10 秒。
声明位于已被 sourceHelperSHA256 绑定的 `owned-installed-consumer.ts`；实际
测试、子进程 watchdog 和安全证据校验共用该声明，不能将 15 秒用于 list、
remove 或其他阶段。小型故障夹具可选择更短预算，仍必须报告实际超时、信号、
wait/close 和进程组结果。完整夹具仍为 60 秒，外层等待仍为 180 秒，无重试、
缓存信任或省略文件校验。15 秒不是产品安装 SLO，也尚不代表新 Darwin x64
执行通过；需新源码的真实四平台验收。产品读取实现保持不变。
