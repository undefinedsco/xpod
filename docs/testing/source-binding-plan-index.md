# 来源组匹配的声明索引

完整源码组增多后，重复构造同一 primary 候选集合的 secondary 所有权表，使五项完整历史遍历在双核 CI 上超过原有 30 秒门槛。优化保留全部历史组、每个缺失/混用角色反例和原门槛。

控制器只对显式调用 `freezeGitHubSourceBindingGroups` 的静态声明建立索引。先冻结组、selectors、secondary selectors、source bindings 及其行；仅使用自有数据属性、规范原始字符串的声明进入索引。可变调用方仍实时扫描，getter 或动态属性不进入索引。可选字段的共享原型改变时恢复实时路径。

索引只保留 primary 键值与对应候选集合的 secondary 所有权计划，不缓存观察值或选择成功结果。每次选择重新读取实际观察值，验证全部 primary 候选的共同角色、唯一匹配与该候选自己的 SHA。返回的角色数组是独立副本；计划存储数量由声明组数约束，淘汰只影响开销。索引不签发源码、构建、发布或任何私有权限。

本次仅追加 consumer64 / CI126，API25、SDK51、CLI10 不变。此前 263 组完整 JSON 绑定逐组保持一致，当前闭包仍为 421 个文件。新控制器将原本已属于候选必需源码的 `github-source-binding-groups.ts` 提升为 secondary 判别项；共享角色规划仍要求每个实际 primary 候选都拥有该角色及其一致的 mandatory SHA，在获取任何原件前拒绝缺失或冲突。不向历史候选请求未来才出现的文件。

`source-binding-plan-index.tiny.test.ts` 验证缓存污染、可变/getter 输入、继承字段变化、淘汰、重复组歧义及获取前拒绝。原先超时的五个全历史测试仍直接运行，不拆分或减少检查范围。
