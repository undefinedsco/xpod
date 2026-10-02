# 共享组件收敛计划

依据 `docs/ui-modernization.md` §2–3 与用户本轮要求：尽量沉淀可复用组件，遵守原有分层，不把产品业务移入公共层。

## 边界

- `shared-ui`：视觉 primitives、token、基础键盘/焦点交互、由 props 注入文案的表单字段与空态。不得读取 Pod、发送请求、操作路由或宿主窗口。
- `extension-sdk/react`：已有 AppLayout / TwoPaneLayout、能力与状态适配。此次复用现有协议，不新增视觉系统或业务状态机。
- app / applet：数据、产品文案、业务状态与操作、路由、页面组合。任务执行、AI 配置、索引重建与设备控制继续由各模块负责。

## 实施顺序与并行责任

1. 先使用已有测试保护表单提交、原生控件事件/表单值、弹窗键盘与忙碌状态；缺少保护时补有意义的回归，再改实现。
2. 公共控件：统一 Input 的控件样式，补 NativeSelect、Textarea、Checkbox，保留原生 HTML props / ref / FormData；沿用单层 focus。原生 select 不改成另一套事件 API。
3. 展示组合：从登录内部提取已存在的 Field 为公共 FormField；有真实重复消费者才提取 EmptyState。文案和业务回调由调用方提供，登录密度选择器保持有效。
4. 任务 / 设备 / 宿主：采用公共表单控件与已有 Button；对象行、导航和业务组合保留在其 owner，不为每个 div 建包装。
5. Pod：复用已有 Button、Badge、Dialog 和公共控件；删除手写 modal 焦点循环。模型过滤、权限、提交和 busy 关闭约束留在 Pod applet。
6. 应用层 primitives：核对 ui 本地副本的公开 API，收敛到 shared-ui 公开出口；必要的兼容适配只保留参数映射，不复制样式和基础交互。

## 验证

- 各 lane 先运行相关行为回归；合并后依赖状态检查、所有公共包构建、类型检查、lint 和 UI / Desktop 构建。
- 验证键盘焦点只有一个边框，原生控件提交与禁用语义、Dialog Escape / Tab / 焦点恢复、登录 280×400 native bounds 与 1280×800 workspace content。
- 源码冻结后顺序运行完整单元和完整集成测试，避免并发构建与修改污染证据。
- 最终在真实桌面界面检查主要消费模块；记录变更、删除的重复实现及未覆盖的风险，不用 mock 证据冒充实际运行通过。

不新增外部依赖；新增对已有 workspace 包的依赖需更新锁文件。公共 exports 由控件 lane 单一维护，生成产物由主代理统一构建。
