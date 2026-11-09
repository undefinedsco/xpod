# SDK FetchContent 来源准备

模块 SDK 在现有 sourcePrepare owner 中先完成 QLever 源码准备，再执行真实
`fetchcontent-prepare` 阶段。正式 configure/compile 不再承担依赖的网络获取。
服务镜像的默认构建入口不使用这套模块专用阶段。

依赖声明以补丁后的 QLever `CMakeLists.txt` 为唯一程序侧来源。
现有共享 `sdk-generation-multiprocess-bindings.py` 的纯函数解析已审核的字面量声明，
并生成标准 `FETCHCONTENT_SOURCE_DIR_<NAME>` 缓存项；producer 和 observer 共用它，
不维护第二份 URL、commit 或 hash 目录。未知选项、动态 pin、未准备的嵌套声明或
Gitlink 均拒绝并报告，不静默联网兜底。

FetchContent 的 Git 依赖使用完整 clone 和明确的 commit checkout，拒绝 shallow/promisor 状态。
准备原件复用现有 Git snapshot 实现，保留原始 commit、tree、精确当前对象集合、
无 delta 重用的 pack、工作树投影及实际进程回执。完整获取不等于保留全部历史的
来源资格；当前对象闭包仍须独立消费者验证。URL 依赖保留完整下载原件，核对声明的
hash 后才安全展开。不得用 POPULATED 标记或伪造下载 stamp 代替这些动作。

来源目录固定为 `/opt/qlever-sdk/dependencies/<name>`，正式构建通过 BuildKit
只读 bind 供应该根。依赖 binary 目录仍由 CMake 放在 build 下。初始化缓存文件
`/opt/qlever-sdk/dependencies/sources.cmake` 同样只读，并与保留的缓存原件逐字节对应。
`FETCHCONTENT_FULLY_DISCONNECTED` 禁止遗漏依赖重新走 FetchContent 下载。

`materials/fetchcontent/materials.json` 是唯一依赖集合，其 `dependencies` 清单同时供
标准缓存生成和同一 observer 的来源根注册。每项只有一个 `sourceOriginals`
入口，区分 Git 和 URL 原件；`sourceInventory` 使用 4 MiB 以内的 metadata shards，
记录整个物理树，包含 `.git` 文件。物理快照不冒充 Git 跟踪树或官方来源资格。
符号链接必须解析到同一个依赖来源根内。

准备记录中的 `dependencyCollection`、正式构建的真实 mountinfo 和现有绝对 deadline
一起传给同一个 observer。依赖获取、对象原件、inventory、新增 full-shard 副本和
诊断输出共享既有 source 材料额度，不能为新阶段重新分配时间或放宽大小。

外层 SDK master 的 `fetchContentSources` 只引用该集合的同一 inner/root seal。
在依赖原件、实际读取、工具链和私有来源验收全部完成前，whole source/toolchain
状态保持未通过。小型 Git/归档测试不能代替 Root 排队执行的真实冷 SDK 构建。
