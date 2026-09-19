# 0.4.10 登录会话与 Pod 归属隔离验收

当前为 release/0.4.10 候选，尚未正式发布。实际在线服务仍使用 0.4.9；下列本地证据不代替新版本 RC、正式安装及在线验收。

## 最终行为

- WebID 按完整原始字符串比较，包括协议、域名、端口、路径、查询参数和片段。URL 解析只作校验，不合并不同原文。
- Account 的 WebID 登录链接不是 Pod 所有权。按 WebID 查询必须有明确 Pod—WebID 绑定；缺少 owner 时不按账号、单 Pod 或索引猜测。
- canonical identity_store 的同 ID 记录整条优先，不与 legacy 拼接身份或地址。损坏、缺 owner 的当前记录也不复活旧 owner；只有确认 canonical 表不存在才兼容 legacy，其他查询错误直接失败。
- 首次创建前读取权威 Account Pod 清单，在 Local prepare 或 Account POST 前阻止为已有但缺绑定的 Pod 创建替代品。其他目标存储的首次创建仍可继续；清单只证明存在，不证明 WebID 所有权。
- 业务请求绑定 WebID 与会话，Account 操作复用 Account 生命周期断言并固定请求 token。退出、切换、过期、销毁后拒绝旧操作；同 WebID 重新登录不复活旧引用，正常 token 续期不撤销有效绑定。
- Provider、Pod、callback 拒绝迟到结果；旧认证恢复不能覆盖退出或新身份。未结束的登录明确提供刷新页面和返回登录，账号撤销立即终止创建轮询。
- 缺绑定的重复重试保持可恢复，不停留在“正在准备”。明确绑定恢复后可继续授权；嵌入式 FirstPod 返回账号使用真实文档导航，避免 SPA 路由循环。

已经发出的 POST 可能已创建服务端资源。拒绝迟到结果不等于撤销远端资源，也不得改用新账号补偿旧操作。通用 raw fetch 保留原有语义。

## 最终本地验证

| 项目 | 结果与范围 |
| --- | --- |
| 完整构建 | packages、服务器 TypeScript、Components.js、四个 UI 入口均成功 |
| Pod 归属 | 49/49，含原失败反例、真实 SQLite 两后端和独立复跑 |
| 相关后端 | 130/130，覆盖所有权、Account bindings、provision、用量与 AI 配置 |
| 首次创建及恢复 | 82/82，含缺 owner、坏清单、账号切换、轮询撤销、重复重试和跨文档返回 |
| 完整 UI | 正式 Node 24/root Vitest 配置，85 文件、795/795 |
| 首次 Managed Local 注册 | 真实隔离 Cloud/Local 与原生夹具，1/1 |
| 三模式浏览器 | Cloud、Managed Local、Standalone 共 9/9；合计浏览器 10/10，零跳过、零 flaky |
| 完整集成 | 两轮均为 Lite 151 通过/6 跳过、Full 45/45，无产品测试重试或超时放宽 |
| 静态检查 | UI TypeScript、修改文件 ESLint、diff 检查通过 |

SDK 生命周期 125/125、Controller 66/66、Account/凭据/host 77/77、发布传播 14/14 的此前定向证据保留；这组未变动模块的行为也经过本轮完整构建及对应上层回归。详细会话边界见[会话取消记录](login-session-cancellation.md)。

浏览器启动的前两次尝试分别在 Docker fixture 和缺少浏览器缓存处退出，未执行产品断言。最终使用仓库已采用且本地核验的 MinIO 固定 digest，以及现有 system Chrome 开关；没有把私有 fixture 调整说成原 helper 原样通过。失败日志单独保留。

## 证据与边界

本轮证据在候选工作树下：

- .test-data/pod-owner-boundary：归属反例的红绿测试和独立审查。
- .test-data/owner-binding-review：共同创建保护、页面恢复、类型检查及 lint。
- .test-data/release-0.4.10/explicit-owner-validation：最终构建、完整 UI、两轮完整集成与资源清理。
- .test-data/release-0.4.10/explicit-owner-browser：首次注册、三模式浏览器、原生夹具及 source/dist 前后哈希。

浏览器执行期间产品源码与 2078 个 dist 文件未变；只有本文由父任务追加证据。各测试只清理自己的资源，实际 Local 进程与数据未修改。

首个候选 b5b1389 的 RC 35406380774 已取消，不能晋级；复核发现并修复的缺 owner 回退和双来源同 ID 合并是取消原因。最终源码必须获得新的 RC acceptance，才能签 stable tag。

实际账号兼容性只读检查确认：两名授权验收账号的 Cloud 权威接口均有精确 owner/存储绑定；其中一名由 Cloud 保存绑定，本地只有目录。目录不能证明身份，没有据此补写本地 owner。

浏览器使用已核验的既有 15 文件原生夹具，不代表正式 0.4.10 native；fake QLever 集成也不替代原生或在线验收。待完成：新 RC、正式发布、官方产物安装和实际账号登录链路。

真实 Models/Chat 仍缺授权验收账号的已有模型配置；models 200 空数组只证明认证路径，不计作 Chat 通过，也不表述为完整 AI 链路通过。

完整设计矩阵、已验范围与剩余边界见[覆盖与模块化审计](login-coverage-and-modularity.md)、[登录状态矩阵](login-state-matrix.md)。
