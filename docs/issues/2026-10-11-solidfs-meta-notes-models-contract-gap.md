# SolidFS metadata-note 与 models 契约缺口

状态：已确认，待 models 定义对齐；AFS 模块迁移保留既有输出，不宣称共享模型契约已通过。

## 场景与复现

服务原公开 API `src/solidfs/SolidFsMetaNotes.ts` 提供 `buildFileMetadataNote` 和 `buildReaderCoverageNote`。调用前者，传入合法 subject/about、title/description 和 `materializationClass: 'placeholder-r2'`；输出 Turtle 声明 `@prefix udfs: <https://vocab.undefineds.co/udfs#>`，并使用 `udfs:Note`、`udfs:noteKind "file-metadata"` 和 `udfs:materializationClass`。

对照已安装 `@undefineds.co/models` 0.2.60 的 `dist/namespaces.js`，以及 models 仓库 `src/namespaces.ts`：权威 UDFS 命名空间为 `https://undefineds.co/ns#`。相同短名称因此生成不同资源 IRI；Turtle 可解析并不能证明符合 models 契约。

## 已确认的差异

- models 定义 Note、noteKind、readerVersion、coverageUnit、coveredRange、readUnits、totalUnits、status，但 helper 使用另一命名空间。
- models 的 `src/reader-materialization.ts` 定义 `ReaderMaterializationProvenance`，使用 readerEngine、noteKind reader-materialization，状态为 complete/stale。
- 当前 models 的源码及安装产物中未找到 helper 的 FileMetadataNoteInput、ReaderCoverageNoteInput、materializationClass 枚举（byline-local/placeholder-r2/hydrated-r2）、readerKind、file-metadata/reader-coverage noteKind，以及 none/partial/failed 状态的对应声明。helper 的 mediaType/byteSize/contentHash 也未在 UDFS 声明中找到。

## 根因与修复归属

历史 helper 在 Xpod 内自行声明字段、枚举和词表，未以共享 models 为权威。模块抽离只能改变实现位置，不能解决共享定义归属，也不能把可解析性测试当作建模一致性证明。

先在 models 补齐或明确复用的 schema、词表和枚举，并决定现有输出的迁移策略；随后 AFS adapter 消费同一权威定义，删除本地共享规则副本。不得静默改变已公开 API 的 IRI 或状态含义，也不得在业务调用方增加地址兼容分支。此 helper 只序列化内容，不执行 Pod CRUD；本报告不授权绕过 drizzle-solid。

本轮允许原样移动既有实现到唯一 AFS 位置，根目录只公共转发。该步骤保留已存在的契约缺口，不能宣称 metadata-note 与 models 已对齐。既有行为测试应继续验证输出和非法输入；后续 models 修复还需明确 schema/词表一致性回归。
