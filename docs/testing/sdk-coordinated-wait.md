# SDK observer 协调等待验收

SDK49 引入 `coordinated-wait-v7`、身份调用排队与停止状态 FD 别名写入记录；SDK50 在保留原契约的基础上增加 `parked-universe-wait-v8`。这些记录证明实际调用、文件字节和生命周期的机械关系；不单独授予 SDK 源码或发布资格。

身份调用在全停屏障或初始 authority 采集期间到达时，保留实际 syscall-entry stop。初始化完成后仍逐个使用原有身份 lease 与独占 entry/exit 证明，不同时执行多个身份变更。旧 v1 模型继续拒绝重叠条目。

别名写入保留完整的停止状态 FD 表清单。校验器从清单推导同 inode 的可写别名，并核对 CLONE_FILES 的表归属；只有选中 syscall 可以恢复。调用后的清单必须保持相同别名绑定，实际返回长度和完整字节投影继续验证。生产者最后 close、普通输入读取仍沿各自原有规则处理。

协调等待沿用映射窗口的绝对截止时间、原件 ledger 和停止状态的进程 lease。等待者必须实际阻塞在同一 futex 调用中；候选线程按固定顺序轮转，记录实际 ptrace interrupt stop 后才能切换。只有同一内存域、同一地址的私有 wake 进入双调用闭合阶段。完整 maps、四字节等待值、两个实际 syscall-exit stop、文件快照和最终全停屏障必须闭合。成功阻塞等待与 `EAGAIN` 不匹配记录分开报告。

V8 将完整停止进程集合与同一内存域的候选线程分开：外层 Bash、CMake 等祖先始终保持真实 tracing-stop，仅调度映射所属内存域的线程。每个窗口保留完整集合、停止状态和 FD 表归属；关闭时重新核对所有线程的完整 maps。

V8 支持无超时的私有 `FUTEX_WAIT`、实时 `FUTEX_WAIT_BITSET` 与任意规范 uint32 期望值。调用地址必须位于映射输出之外的实际私有可写匿名区（包括 `[heap]`）；原始参数和完整四字节值均保留。V6/V7 仍只接受原有精确参数。

候选线程遇到其他地址的私有等待时，不匹配分支必须得到真实 `EAGAIN` 并核对调用前后完整值；相等分支保留真实 syscall-entry stop，不执行该等待，也不向线程注入信号。该线程从可运行候选中移除，未执行的 entry 引用跨窗口保留，直到原始输出映射解除。窗口建立时已有的 peer entry 也从唯一实际 kernel-entry/exit 台账完整列出；选中它时只引用原先的真实 stop，不伪造第二次入口或用户态恢复。候选线程对另一个私有地址的 wake 只能以真实返回 0、字值不变闭合。原始等待者仍必须实际在内核阻塞，最终同址 wake 必须真实唤醒 1 个线程，两个实际 exit stop、字节快照与屏障一起闭合。

正常 SDK observer 还串行调度退出调用：先完成已进入 syscall-entry stop 的单线程退出，再运行进程组退出，避免 `exit_group` 抢先清除兄弟线程的 EXIT 边界。严格的 live EXIT authority 采集、全停闭合与实际 wait 校验不变。版本化的 `actual-selected-exit-stop-held-terminal-peers-v2` 另外记录已完成 live EXIT 采集、屏障闭合并实际恢复的僵尸线程：使用原有保留 proc/stat 句柄双读，核对进程 identity、starttime 和真实 Z 状态，从潜在写入者屏障中排除它，等待其他 EXIT 线程结束后取得真实 wait。此记录不授予僵尸的 namespace/FD/provider 权限；旧 v1 仍拒绝这类屏障。

生成文件解除映射后可通过已有的独占 rename/mode 协议继续追踪。rename 明确引用生成 checkpoint，不能冒充普通 producer-close；消费者必须完整读取同一保留 inode，内容一致，路径与全部六项 identity 通过每个已验证的 metadata transition 连续衔接。

可选 `io_uring_setup` 拒绝使用版本化的 `explicit-kernel-enosys-denial-v2`：只替换 syscall 编号为未实现的正编号 `0x7fffffff`，实际内核退出仍必须是 `ENOSYS`；不修改返回值寄存器。旧 v1 重放规则保留。

信号、VMA 变化、未知调用或没有剩余可运行候选的等待继续拒绝。真实 QLever SDK configure/build 和两个 Linux 架构的完整工作流仍是发布门禁。


maps 原件使用独立的 `same-phase-maps-content-entity-v1` 存储模型。每次采样仍完整读取当前 `/proc/<pid>/maps`，核对当前 FD 与命名文件的前后 identity；复用前还会完整读取、校验既有物理实体。相同内容仅保存一份，但每条原件引用都携带本次真实 `observationSequence`。maps 的 PID、屏障与先后关系按该采样序号验证，不能把同一内容的两次采样合成一次。旧版本继续使用独立物理文件；阶段之间不复用。物理原件清单只列一次文件，字节、元数据与执行时限上限不增加。

## SDK51 元数据与操作投影

`actual-closed-generated-transaction-retained-metadata-v1` 将生成映射元数据的计量范围明确改为仍保留的协议状态与当前未闭合事务。只有真实独占调用退出、完整字节快照和关闭引用均已验证，且没有活动映射、待处理映射或调度轮次时，才能重新计量。所有仍保留的 origin、checkpoint、消费者、内存域和等待事实继续计入同一个 4 MiB 上限；原始历史记录保留在原有有界 ledger 中。该计量是规范化元数据大小，不是 Python RSS。旧模型保留累计计量规则，不能静默获得新行为。

工具链控制器另外输出版本 2 的 `indexed-tool-operation-coverage-v1`：每条操作保存固定的 11 列，缺失映射保存完整的 9 列，路径通过唯一绝对路径表引用，inode 与偏移使用精确十进制字符串。每条操作及其映射义务分别保留；缺失原因按原始操作序号、路径、地址范围和偏移逐条还原，不同时在操作与全局列表重复保存长文本。TypeScript 按操作迭代，避免保留整份展开副本。未知布局、额外列、错误索引、缺失义务和重复映射继续拒绝；缺失映射不会获得完整覆盖资格。旧版本 1 的读取和上限不变。

追加写检查点在 syscall-entry 时保存实际事件序号，全停屏障导致任务关闭当前 entry 后仍引用原始事件。独立 reader 继续要求该 entry 已真实出现且早于检查点，不能以空值或新事件替代。

24 项独立 C++ 编译探测夹具位于 `fixtures/clang-cmake-metadata`。使用下述 Clang/CMake 容器参数替换 source 挂载，并在输出路径后追加 `--metadata-stress`，执行实际 configure、build、生成程序和一次完整独立重放。该压力模式共享原有 300 秒父截止时间，不重复正常小型探针的六组篡改重放；两种探针均须执行。SDK50 的相同夹具实际触发旧累计元数据上限，SDK51 在原有 4 MiB 上限内完成；两者均不替代真实 QLever SDK 的完整构建与发布门禁。

## 原生探针

`qlever/tests/run_sdk_coordinated_wait_probe.py` 编译实际 C/pthread 夹具，覆盖两种等待操作、零至两个停止祖先、候选线程相等 entry 排队、不匹配等待与异址 wake，解除映射后继续执行实际 FD 写入，再使用完整流式 reader 重放。它还篡改 peer、信号、epoch、中断状态和闭合引用并验证拒绝，最后执行实际 wait/ECHILD 清理。

探针使用正常 SDK observer 构造器的能力选择，但直接调用基础 phase 执行测试程序；它不是固定 SDK configure/build argv 的验收。输出始终标记 `qualification: false`。运行时必须使用独立容器、空的规范 build 目录和只读 source 挂载，不占用共享 RC。

在已具备 C 编译器与 Python 的 SDK 构建镜像中运行，替换下面的镜像占位符：

```bash
mkdir -p .test-data
probe_output=$(mktemp -d "$PWD/.test-data/sdk50-native.XXXXXX")
docker run --rm --read-only --cap-add SYS_PTRACE --security-opt seccomp=unconfined \
  --entrypoint python3 \
  -v "$PWD:/components:ro" \
  -v "$PWD/qlever/tests/fixtures:/opt/qlever-sdk/source:ro" \
  -v "$probe_output:/proof" \
  --tmpfs /opt/qlever-sdk/build --tmpfs /tmp \
  <prepared-sdk-image> -B \
  /components/qlever/tests/run_sdk_coordinated_wait_probe.py /proof/probe
```

输出分为 `cohort-only`、`parked-parent`、`parked-ancestors` 及各自的 `-classic` 目录，共六组。每个 `observation.json` 保存编译命令、源文件/二进制摘要、实际 phase、流式重放、反例拒绝与实际 ECHILD 清理。

`qlever/tests/run_sdk_clang_cmake_probe.py` 使用 `fixtures/clang-cmake` 运行实际 Clang19/LLD 的 configure 和 build，并执行生成程序、独立重放完整原件及拒绝生成 checkpoint/rename/metadata 链的篡改。使用相同隔离参数，将 source 挂载改为 `qlever/tests/fixtures/clang-cmake`，build 挂载改为 `--tmpfs /opt/qlever-sdk/build:exec`，在具备 Clang19、LLD19、CMake 和 C++ 标准库的构建镜像中运行。它仍是小型工具链回归，不是固定 QLever SDK recipe 验收。

## 版本绑定

SDK50 注册前冻结的 255 组完整绑定必须逐组保持一致。变更的 helper 作为完整新 tuple 追加到 observer、generation/FetchContent controller 与当前源码绑定。当前 closure 为 421 个文件；声明 helper 组数量上限为 23，单组观察角色上限仍为 32。新增组不得改变旧版本需要读取的路径，也不得让历史组继承未来 import。

SDK51 在保留 SDK50 的全部 259 组完整绑定后追加新 tuple；当前仍为 421 个文件。声明 helper 组上限为 24，单组观察角色上限仍为 32。
