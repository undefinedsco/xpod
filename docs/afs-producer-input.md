# AFS 显式 producer 构建输入

AFS 的 CLI 构建工具不是运行依赖。`build-client.ts`、`build-package.ts` 和 `check-producer-materials.ts` 必须提供一次 `--cli-package <正常 CLI 包的解包目录>`；没有参数、重复参数或缺失工具均直接失败，不默认解析工作区 CLI。材料索引、公共构建工具和 CLI output 从同一个包的 public exports 读取，类型导入不会在运行期加载 CLI。导出越界或包含符号链接、索引/包身份或版本不一致、工具能力缺失和构建期间摘要变化都会拒绝。

材料 helper 接收这个入口给出的同一个 tools 实例，复用 CLI 的 `verifyProducerSourceArchive` 和 `collectJavascriptNotices`，不维护第二份算法。CLI output 只作为命令构建输入绑定，不随 AFS 共享运行库形成反向 CLI 依赖。

## 源码与发行身份

正常 Bun pack 会改写 manifest 中的 workspace 版本。producer 的 source inventory 继续绑定原始源码 manifest；`runtimeClients[].files` 绑定正规 pack 的实际发行文件字节。两者不可互换，也不能用忽略 devDependencies 或手工规范化 JSON 的办法放宽哈希比较。

每个 runtime client 的 `publication` 指明正常 tarball、其完整 `package/` 前缀文件库存和 source manifest 路径。正常 tarball 和发行库存本身被外层材料库存绑定。consumer 验证完整 archive 与发行库存、source manifest 的实际名称/版本及映射，再验证实际解包 runtime client 的每个文件。旧的源码字节库存不作为发行库存兼容入口。

本改动不安装 SDK，也不把原 workspace SDK 根目录冒充发行 SDK。模块 producer 应使用正常 client archive 的解包产物；现有 `--client-archive` 传输输入仍是这个身份的来源。工作区源码可用于正规构建，不能作为独立消费测试的隐藏依赖。

## 上游调用方适配建议（本分支不修改）

- 根 package.json 的 `build:packages` 中 AFS build 需显式传入已生成 CLI producer 包目录；其余包顺序不变。若使用 workspace 运行 SDK，须先按原 client archive 输入取得正常发行解包目录，而不是改写源码 manifest。
- `.github/workflows/agentfs-module-mounted-acceptance.yml` 的 AFS `build-package.ts` 命令需加入 `--cli-package "$MODULE_RUN_ROOT/producer-cli/package"`，前提是正规 CLI tarball 已解包并校验该目录。不可仅给一个猜测的 sibling path。
- `scripts/agentfs-native-ci/mounted/prepare-module-inputs.ts` 已有 `--cli-archive` 和 `--client-archive`；继续使用正常归档的实际解包字节。producer 准备步骤需传同一个显式 CLI 目录、声明的发行 SDK，并把工具/索引摘要与构建回执绑定。

这些建议由对应流程 owner 整合，不表示原 CI 已完成适配。完整平台/native、服务集成和发布验收另行执行。
