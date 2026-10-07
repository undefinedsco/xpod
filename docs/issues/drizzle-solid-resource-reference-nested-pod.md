# 规范 Pod 根重复资源布局片段时的公开引用解析

2026-10-03，安装版本 `@undefineds.co/drizzle-solid@0.3.24`，共享模型 `@undefineds.co/models@0.2.59`。

使用公开 `chatResource.buildIri('https://a/alice/.data/chat/tenant/', { id: 'x' })` 构建合法 Chat IRI，
再调用公开 `parsePodResourceRef(chatResource, iri)`，得到的 key 是 `tenant/.data/chat/x`，而不是 `x`。
原因是 `relativeSubjectFromRef` 用 `indexOf(resourcePath)` 截取第一个布局片段；规范 Pod 根本身包含该片段时，
根的一部分被当成资源变量。公开 builder 的精确往返因此失败，严格 adapter 正确拒绝了本来合法的资源。

这属于依赖的公共解析契约缺口，不修改共享 Chat 布局，也不在产品 adapter 复制路径规则或增加猜测回退。
修复限定到依赖现有引用解析：绝对 HTTP(S) 引用从 URL 路径中的最后一个资源布局位置解析，
匹配不进入 query 或 fragment，截取仍保留原始完整剩余引用；保留原有相对引用语义。
解析只提供布局变量，不能证明推断根已注册或证明资源 owner；生产 C2 仍须严格登记根与完整 WebID 绑定校验。

首版 last-match 补丁曾搜索整个 IRI，独立审核复现 Message 和 Thread 的 fragment 含 `/.data/` 时
被截成 `z`，丢失真实文档及主体身份。已增加两个公共 builder 反例，修复必须通过这两个回归。

回归使用公开 models builder 和公开 parser，覆盖普通根、重复布局根、多重重复根、归一化输入、
相对引用及 Message/Thread 的 fragment。输入 `id` 可能被公共 builder 归一化，不能直接将它当作原始 key。
补丁通过既有版本的正式 Bun patch 固化；其他既有补丁保持原样。真实 Gateway 与最终 C2 集成需在修改后复验。
