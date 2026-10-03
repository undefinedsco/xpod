# 浏览器授权返回页 · 2026-10-03

[received.html](received.html) 是从 `src/api/ai-gateway/connect/AuthorizationCallbackPage.ts` 的正式渲染函数生成的静态快照，可直接打开查看。它只含呈现和固定的 `xpod://ai-connections` 导航链接，不含授权码、state、账号或凭据。产品实现以该源文件为准，行为契约以[共享登录 spec §13.13](../../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md)为准，快照不是另一套模板。

采用正式折角主标、墨水紫 `#563E84`、暖底色 `#F7F4ED` 和系统字体。单列状态页将标题、解释、主操作和手动返回提示分开，保留足够留白；支持系统明暗主题和窄屏。

正式实现包含四种状态：已接收、链接失效、授权未完成、接收失败。已接收仅表示回调已接收，连接是否完成由桌面应用判定。页面不自动唤起应用，不加载外部资源或执行脚本。

视觉验收覆盖四状态 × 两主题 × 360/1280px 共 16 个场景，检查布局、长文本、对比度、键盘焦点及外部资源。截图和安全摘要保存在忽略目录 `.test-data/gpt61-callback-page/`，包括 `received-light-1280.png`、`visual-safe.json` 和 `report-safe.json`。实际 Chrome 的返回按钮已通过系统确认弹窗唤回安装版 Xpod，两次返回均复用同一 renderer。分项结果与尚未解决的公网路由问题见[验收记录](../../testing/2026-10-02-local-consent-acceptance.md)。
