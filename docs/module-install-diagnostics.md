# 模块安装阶段诊断

重复的 Darwin x64 安装失败目前只能定位到测试的 10 秒 watchdog；现有 SQLite warning 不能证明底层耗时原因。此变更增加观察能力，不调整安装、测试或父进程预算，也不自动重试。

使用 `xpod module install afs --version <exact-version> --diagnostics` 显式开启；CSS/API 使用同一入口。默认不输出诊断，正常 JSON stdout 不变。开启时 stderr 同步输出最多 64 条 JSON 行，只含固定 kind、阶段、状态、单调毫秒耗时及阶段持续时间。阶段开始在动作之前输出，因此同步解压被外部终止时仍有开始标记。

计时位置在 `packages/xpod-cli/src/module-store.ts`：锁获取完成回调、metadata、归档下载与哈希、tar 预检、同步解压、manifest/权限规范化、库存 manifest/文件哈希/目录遍历、发布、清理。锁获取不包含安装动作；默认静默的 verify 调用不输出事件。观察回调失败不替换原操作结果或错误。阶段白名单与输出上限只定义于 `module-install-diagnostics.ts`，不输出文件路径、registry URL、凭据或异常字符串。

AFS 原有安装消费者测试在安装命令启用此选项。`prepare-module-inputs.ts` 复用原有 stderr 原件和 safe 导出：只有 actual wait、raw、进程组已关闭且原文摘要匹配后，才读取最多 64 KiB / 1024 行，提取固定且顺序有效的阶段前缀。成功 receipt 的安装阶段也保留这些计时，方便比较；被杀时允许最后一条为 started，不能由此断言该阶段就是根因。

未知字段、阶段、负数/非数值/越界/倒序耗时或超过 64 条的轨迹不会被当成完整诊断；导出保留有效前缀并标记截断。未关闭或原文已变化时不导出阶段计时。诊断不是验收资格，原失败状态、信号、watchdog、wait/raw/group 事实保持独立。
