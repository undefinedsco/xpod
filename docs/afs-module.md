# AFS 客户端模块

AFS 的发行与安装契约以 [模块分发规范](module-distribution.md) 为准。目录协议客户端、挂载与搜索命令、workcopy 和本地 SQLite 实现归 `packages/xpod-afs`；认证与凭据存储使用 `@undefineds.co/xpod-cli/client`。服务端保留授权 transport、RDF 索引 adapter 与恢复初始化职责。

## 实现与依赖边界

客户端实现只有一份。服务端兼容入口通过 AFS 的公开子路径转发，不跨包引用源码，不另建认证缓存。workcopy HTTP 客户端接受请求函数与不透明 context；服务端 adapter 每次请求解析现有 owner/task credential，继续使用共享 Pod fetch。拒绝的写请求不得自动刷新凭据并重放。

所有公开子路径转发到同一个 CJS library。异常类身份、SQLite runtime 缓存和认证客户端应在同一进程内保持一致。安装入口与公开桥使用实际安装位置定位自己的 payload；构建机器目录、调用者 cwd 与 PATH 均不能成为已安装 helper 的来源。

workcopy 迁移必须保留 direct、copy、hydrated-object、commit、rollback、hydrate、prune、冲突检测，以及 journal bootstrap、重启回放、幂等、compact 和 afterHash reconciliation。本地 SQLite 不承载 Pod RDF schema，也不替代 models 或 drizzle-solid 的共享建模规则。

## 产物与来源

平台包是包含 `package/` 的自包含 npm tarball；唯一模块声明为 `package.json.xpodModule`，不增加平行的 module.json。完整库存绑定 entry、library、公开 CLI client、helper、运行依赖、原始许可证材料和源码包的路径、摘要、大小与权限。安装不执行脚本或要求用户编译 Rust。

复用已验收原生 helper 时，`nativeBuildSourceSHA` 保留原构建来源，并验证原 archive、receipt、source kit 与完整原生输入。模块源码使用自己的不可变提交和源码清单摘要，不能把原生构建 SHA 当作模块源码 SHA。未提交的预验收包须明确记录 dirty/base commit，不能充当正式发行产物。

混合材料各自保留原始许可证。Xpod 自有源码的 MIT 声明不能扩展成整个原生 helper 的聚合许可证；产物校验通过也不等于完成材料审查。

## 验收层次

1. 源码门禁：包、服务端和测试类型检查，兼容 preview 门禁，以及完整集成测试。
2. 独立安装：真实 tarball 通过生产 ModuleStore 安装到仓库外私有目录，分别在 Node/Bun 验证公开 API、跨桥身份和完整 workcopy 行为；不得沿父目录借用工作区依赖。
3. 原生挂载：同一安装库存中的 helper 通过既有六项实际 kernel mount 用例，保持流式读取、RSS、真实 SIGKILL、恢复、条件写入与清理判据。
4. 模块入口：实际 core → ModuleStore → installed entry → auth proxy → helper → kernel mount，完成文件读写、commit、unmount，并证明代理、helper 与挂载退出。
5. 真实实例：当前域名上的 Pod 读写、Gateway 客户端认证、模型合并列表和有效 Chat 响应分别验收；受控 HTTP fixture 不证明这一层。
6. 发布：不可变源码重建、平台产物与材料审核、实际可获取性以及所需桌面和性能验收完成后，按既有 staging 发布规则交付。

各层记录实际退出码、信号、关闭后的日志摘要、源码与产物绑定，以及实际清理结果。缺失的进程身份属于未知，不能用空集合推导“全部已退出”。
