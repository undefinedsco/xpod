# 登录会话切换后的请求隔离

## 缺陷与验收目标

0.4.9 实际 Managed Local 完整验收发现：产品退出已清理身份后，AI Connections 的旧 provider 加载仍可能继续向 canonical 节点发送请求。已捕获 GET `/api/ai/connections/…`，无 Authorization/DPoP；不能据此声称发生了凭据泄露。

独立离线回归进一步证明，直接保存 Inrupt 动态 fetch 的业务对象可能在退出后使用匿名传输，或在同一 SDK Session 恢复另一个身份后使用新身份传输。测试使用实际 Session/ClientAuthentication 与 SDK、模拟 transport，不是在线数据越权证明。

## 不变量

- WebID 按完整原始字符串判断；域名、端口、路径、查询和片段均不得被归一化合并。
- 业务和 Pod 请求绑定创建时的认证会话；退出、过期、身份切换、销毁后，旧引用不能继续请求。
- A→退出→A 是新会话，旧引用不能因最终 WebID 相同而复活。
- 正常 token 续期不应使同一有效会话的请求能力失效。
- 底层 raw session.fetch 的通用、匿名用途保持兼容；业务层必须使用显式绑定能力。
- 组件卸载或新一轮加载使旧的多步操作失效；迟到结果不得覆盖新状态，订阅需要释放。

## 回归矩阵（执行结果待补）

| 层级 | 必须证明 |
| --- | --- |
| SDK | logout 开始但尚未完成即拒绝旧请求；A→B、A→匿名→A、expired、dispose；原文 WebID 不混同；当前会话及正常续期仍可请求 |
| Provider/Pod/Callback | 登录回调的 storage discovery 与 Pod.open 同样使用一次绑定能力；旧 Pod database.fetch 不会匿名续接或借用新账号；业务入口使用绑定能力；匿名公共入口兼容 |
| Controller | 延迟 Pod 读取完成后，退出/切换/卸载不得启动远端下一步；迟到错误不污染新状态；无 PodStore 回退也受保护；取消释放订阅 |
| 浏览器 | Cloud、Managed Local、Standalone 上真实读取延迟的阳性对照及退出后无续接；测试不阻断目标请求来掩盖缺陷 |
| 构建与集成 | 独立依赖构建、相关 SDK/UI 回归、完整集成两轮；隔离环境不得冒称实际线上 |
| 发布与在线 | 不改写 v0.4.9；新候选经过正式发布门禁后，再以实际实例完整验收 |

浏览器三模式夹具每模式当前只有一个账号；不将其声称为三个模式均执行 A→B 双账号切换。实际全页 OIDC 导航会销毁文档，同文档旧引用的恢复组合另由明确生命周期回归证明。

## 修复前确定性浏览器证据

Cloud baseline 05f076ac 的真实浏览器回归已在目标断言失败：仍在 AI Connections 文档中延迟真实 Pod 读取，确认产品退出及匿名状态后释放结果，出现一条后续 authorization-methods 请求。相同夹具的未退出阳性对照可正常发出请求。该轮原有两项浏览器用例通过，新用例失败；测试未拦截目标请求来制造通过。

证据位于独立浏览器工作树 `.test-data/login-deployment-results-83026/browser/report.json` 和 `.test-data/delayed-provider-red/run-ready.log`。基线构建产物来自已验证候选的只读副本，此证据不冒称新修复的独立构建或线上验收。

三模式补充：后续 baseline 矩阵原有 6 项通过、新增 3 项分别在 Cloud / Managed Local / Standalone 的目标无续接断言失败；各模式均确认匿名后释放，均出现一条后续请求。证据 `.test-data/delayed-provider-red/three-mode-proof.json` 与 `login-deployment-results-83984/browser/report.json`。阳性对照统计阶段随后进一步收紧，最终测试源码的红/绿证据另记，不把此前运行冒称最新源码结果。

## Additional pre-release review gates

- Account client credentials use Account authentication, separately from WebID bound fetch. Old capabilities must reject after an Account session change, including GET-to-DELETE and POST-to-secret response gaps; compensation must not use a new account. Ordinary controls refresh must not invalidate the same session.
- Late initialize/callback completion must not restore an authenticated snapshot after logout, dispose, or a newer identity. Tests must verify both snapshot and newly issued fetch capabilities.
- Eight SDK/Provider/Callback files were integrated after byte comparison with the base. Hashes are in `.test-data/session-cancel-integration/sdk-integration.json`. The donor tree passed SDK 114/114, UI 748/748, and strengthened callback 46/46; these are stage results, not final aggregate acceptance.

## Frozen source checkpoint

Target: 0.4.10 (`release/0.4.10`). Controller 66/66; SDK lifecycle 125/125; related UI 140/140; Account/credentials/host 77/77 under the formal UI configuration; release-readiness 14/14. Independent focused review passed 117 tests before the final controls-token additions. Full build, full integration, fixed browser matrix, RC and actual online acceptance remain pending.

An already transmitted credential POST may have created a server resource before a session change. The client rejects its stale secret and prevents subsequent operations under a new account; it does not claim to undo the earlier request. Compensation failure remains visible instead of silently switching accounts to revoke.
