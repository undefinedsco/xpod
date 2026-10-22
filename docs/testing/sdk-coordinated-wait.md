# SDK observer 协调等待验收

SDK49 为生成文件的有限映射窗口加入 `coordinated-wait-v7`，并同步增加身份调用排队与停止状态 FD 别名写入记录。这些记录证明实际调用、文件字节和生命周期的机械关系；不单独授予 SDK 源码或发布资格。

身份调用在全停屏障或初始 authority 采集期间到达时，保留实际 syscall-entry stop。初始化完成后仍逐个使用原有身份 lease 与独占 entry/exit 证明，不同时执行多个身份变更。旧 v1 模型继续拒绝重叠条目。

别名写入保留完整的停止状态 FD 表清单。校验器从清单推导同 inode 的可写别名，并核对 CLONE_FILES 的表归属；只有选中 syscall 可以恢复。调用后的清单必须保持相同别名绑定，实际返回长度和完整字节投影继续验证。生产者最后 close、普通输入读取仍沿各自原有规则处理。

协调等待沿用映射窗口的绝对截止时间、原件 ledger 和停止状态的进程 lease。等待者必须实际阻塞在同一 futex 调用中；候选线程按固定顺序轮转，记录实际 ptrace interrupt stop 后才能切换。只有同一内存域、同一地址的私有 wake 进入双调用闭合阶段。完整 maps、四字节等待值、两个实际 syscall-exit stop、文件快照和最终全停屏障必须闭合。成功阻塞等待与 `EAGAIN` 不匹配记录分开报告。

当前实现对并发等待者、候选线程已有未闭合 syscall、信号、VMA 变化及其他不支持的调用继续拒绝；不能据此宣称整个编译器链已通过。真实 SDK configure/build 和两个 Linux 架构的完整工作流仍是必需门禁。

## 原生探针

`qlever/tests/run_sdk_coordinated_wait_probe.py` 编译实际 C/pthread 夹具，在第一个候选线程不负责唤醒的情况下完成轮转，解除映射后继续执行实际 FD 写入，再使用完整流式 reader 重放。它还篡改 peer、信号、epoch、中断状态和闭合引用并验证拒绝，最后执行实际 wait/ECHILD 清理。

探针使用正常 SDK observer 构造器的能力选择，但直接调用基础 phase 执行测试程序；它不是固定 SDK configure/build argv 的验收。输出始终标记 `qualification: false`。运行时必须使用独立容器、空的规范 build 目录和只读 source 挂载，不占用共享 RC。

在已具备 C 编译器与 Python 的 SDK 构建镜像中运行，替换下面的镜像占位符：

```bash
mkdir -p .test-data
probe_output=$(mktemp -d "$PWD/.test-data/sdk49-native.XXXXXX")
docker run --rm --cap-add SYS_PTRACE --security-opt seccomp=unconfined \
  --entrypoint python3 \
  -v "$PWD:/components:ro" \
  -v "$PWD/qlever/tests/fixtures:/opt/qlever-sdk/source:ro" \
  -v "$probe_output:/proof" \
  --tmpfs /opt/qlever-sdk/build \
  <prepared-sdk-image> -B \
  /components/qlever/tests/run_sdk_coordinated_wait_probe.py /proof/probe
```

`observation.json` 保存编译命令、源文件/二进制摘要、实际 phase、流式重放、反例拒绝与清理结果。原件与编译日志保留在同一测试目录。

## 版本绑定

SDK49 注册前冻结的 251 组完整绑定必须逐组保持一致。新增 companion 同时进入 producer 的 observer 原件列表、generation/FetchContent controller helper 组与当前源码绑定。当前 closure 为 421 个文件；声明 helper 组数量上限为 22，单组观察角色上限仍为 32。新增组不得改变旧版本需要读取的路径，也不得让历史组继承未来 import。
