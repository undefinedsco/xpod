# 0.4.10 登录会话隔离候选验收

当前为 release/0.4.10 候选，尚未发布。实际在线服务仍使用 0.4.9。

## 修复内容

- 业务请求绑定完整原始 WebID 与认证会话；退出、切换、过期、销毁后拒绝旧引用。同 WebID 重新登录不会复活旧引用，正常 token 续期仍可使用当前绑定。
- Provider、Pod、callback 使用同一绑定能力；迟到的认证恢复不能覆盖退出或新身份。
- AI Connections 取消已失效或卸载的多阶段加载，释放订阅，拒绝旧结果。
- Account 凭据能力检查会话代次、可见 token 和产生 controls 的 token，阻止旧操作沿用新账号。
- 未结束的旧登录不会让新登录无限等待：明确失败并提供“刷新页面”和“返回登录”。

已发送的 POST 可能已经创建服务端凭据。拒绝迟到的 secret 不等于撤销服务端资源；补偿失败不得静默使用新账号处理。通用 raw fetch 保留既有语义，不做 WebID URL 归一化合并。

## 阶段验证

| 项目 | 结果与范围 |
| --- | --- |
| SDK 生命周期 | 125/125，含迟到恢复、同 WebID 新会话、退出未完成、过期和销毁 |
| Controller | 66/66，含卸载、StrictMode、同步异常及订阅清理 |
| Account/凭据/host | 正式 UI 配置 77/77，含 token/controls 交叉和迟到响应 |
| 完整 UI | 独立构建后 84 文件、768/768；Node 24 与仓库配置 |
| 三模式浏览器 | Cloud、Managed Local、Standalone 共 9/9，零跳过、零 flaky；阳性对照成功，退出后旧加载均零续接 |
| 完整集成 | 第一组两轮均为 Lite 151 通过/6 跳过、Full 45/45 |
| 发布传播 | 14/14；root/native tarball 与 SRI 校验，latest 写入后只重试读取 |

最后的 lint 修正后已重新完成独立完整构建、84 文件 768 项 UI 测试、三模式浏览器 9/9，以及两轮完整集成（每轮 Lite 151 通过/6 跳过、Full 45/45）。变更的 16 个 UI 文件 lint 和 diff 检查通过。验证期间源码哈希一致，没有重试或放宽超时门限。

Bun 执行 Vitest 1.6 的首次尝试因 worker API 不兼容而没有执行测试；正式 UI 使用 Node 24，产品仍使用 Bun。隔离测试资源已清理，未操作实际 Local 数据或进程。

## 证据及剩余验收

最终证据位于本候选工作树的 .test-data/release-0.4.10/final-validation 与 .test-data/delayed-provider-final；阶段及失败证据仍保留在 release-0.4.10、delayed-provider-green、session-lifecycle 和 session-cancel-review 目录。

浏览器 native 使用已核验的既有真实夹具，不代表正式 0.4.10 native 包；集成的 fake QLever 也不替代原生及在线验收。尚需 RC、正式发布、安装和实际在线完整链路。

真实 Models/Chat 仍缺授权验收账号的已有模型配置；models 200 空数组只证明认证路径，不能计作 Chat 通过。

历史矩阵与模块边界见[覆盖与模块化审计](login-coverage-and-modularity.md)，详细隔离边界见[会话取消记录](login-session-cancellation.md)。
