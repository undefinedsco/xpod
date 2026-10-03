# 登录 Web 入口与品牌资产留档（2026-10-01）

本次修正的行为与呈现以 [登录前门 spec §13](../superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md) 为准。账号服务负责身份/授权/安全，完整工作台负责 Pod/AI/系统管理；入口双向可发现，Consent 快速创建另有同 UID 轻页面。

正式标志来自 homepage 的已选定“留缝折角”，墨水紫 #563E84。以下文件从 `/Users/ganlu/develop/homepage/public/brand/` 按原字节复制，只复用资产，不重画或覆盖旧探索稿。16px 用于浏览器标签，24px 保留为小尺寸品牌来源。

| 留档文件 | SHA-256 |
|---|---|
| `ui/public/brand/xpod-app-16.svg` | `fd592d689daf097eb5514c99e2581869260af2b14332fcb36b0dcc4854cb2bf5` |
| `ui/public/brand/xpod-app-24.svg` | `8281e5b398e1f8115310c2119b58b8f168628626e4f45969d963ea0ca1249dbc` |

生产 Account 模板使用 `/app/brand/xpod-app-16.svg`；Vite 文档的相对部署前缀由构建工具按各自 base 处理。标签文字区分账号服务与工作台，不保留默认 `ui` 标题。

源图标文件保存在 `ui/public/brand/`，与本次源码修正一起待提交。早期 HTML 原型仍是本机 `.test-data/login-lead/reference/` 的视觉参照，不是最终界面或设备能力证明；用户原上传 HTML 的临时路径已失效，此文档不冒称已找回原件。

输入框外观继续复用 shared-ui `Input`，焦点边界在控件内重合，避免边框与外圈形成两个分离框。邮箱选择兼容集中在 `packages/shared-ui/src/email-input.tsx`，登录、注册和找回密码共用；对照观察、校验约束及验收边界见 spec §13.4。实际 Chrome 的匿名页面复用了编译后的 Account 资产，没有提交账号或密码，没有修改扩展配置。

## 2026-10-02 入口补正

用户确认 Web 始终轻量，重管理仅桌面。`XpodProductEntry` 以 preload bridge 分流 dashboard、settings 和 callback；浏览器不会初始化桌面 Solid runtime 或加载完整工作台。浏览器提供真实 releases 下载入口和账号页，已有桌面由用户打开。原 Consent 任务只保留于原浏览器标签页，进入指引和点击返回时均确认原 Account/interaction；返回原 Consent 后重新选择并明确授权。没有跨进程自动携带 UID，也没有假定已经实现系统 deep link。单次删除授权继续使用受服务端管理员权限保护的轻量任务页面。

`XpodLoginBrand` 已移除旧 shield 引用，复用共享正式 `XpodMark`；控件尺寸和布局继续使用原公共样式。

用户随后将部署 tag 修订为 **logo + info**：同一个正式 Xpod 主标配“云端”“托管部署”或“独立部署”小下标，不再单列 tag。直接复用原服务栏的品牌位置，桌面首次登录替换原品牌插槽，回调页沿用原有品牌尺寸，避免重复 logo。悬停、键盘聚焦或点击 info 展开部署类型、当前访问地址、分配的节点/服务地址及不同源的账号服务；再次点击、Escape 或点击外部收起。详情允许长地址换行，窄屏不超过视口宽度。

共享 `BrandInfo` 只接收宿主的 `logo`、`info` 和可访问名称，不认识 Xpod、edition 或接口。`XpodDeploymentIdentity` 作为业务 adapter 查询、验证元数据并传入品牌变体与详情，在 Account、桌面首次 WebID、内嵌登录和回调中复用。信息来自公共 `/api/service-info` 的真实 edition 与已有预配状态；尚未分配的地址明确显示“尚未分配”，不能把本机监听地址当成分配成功。该接口只提供经 HTTP(S) 白名单清洗的展示信息，不返回预配码、凭据或 token，也不参与认证授权判断。
