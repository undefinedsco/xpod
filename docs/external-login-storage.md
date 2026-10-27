# 外部身份扩展表设计

状态：已实现，更新于 2026-10-27。升级前须停止旧 worker 并排空授权操作；本次开发未迁移运行中实例的数据。

## 目标与归属

使用一张 `identity_external_identities` 表保存外部身份与现有 `accountId` 的绑定；
取代 `identity_store` 中的 `external-login` 记录和 `identity_external_login_index`。
短期授权事务仍使用 `identity_external_login_transactions`，因为它保存的是一次登录的上下文。

这些数据属于服务端身份库，沿用 `identityDbUrl`，支持 PostgreSQL 和 SQLite。
Drizzle 表定义放在 `src/identity/drizzle/schema.pg.ts` 和 `schema.sqlite.ts`，
建表及旧绑定迁移由 `ExternalIdentityStorage` 统一负责；不存入用户 Pod，不增加数据库地址配置。

## 字段与约束

| 字段 | 约束 | 含义 |
| --- | --- | --- |
| `id` | TEXT，主键 | 绑定记录 ID；迁移时保留原 CSS 登录记录 ID |
| `account_id` | TEXT，非空 | 现有 CSS account 的 ID |
| `provider` | TEXT，非空 | 稳定的身份提供方标识，如 `wechat`、`qq` |
| `namespace` | TEXT，非空 | subject 的有效范围；微信 OpenID 使用 AppID，其他连接器按已验证的身份契约声明 |
| `subject` | TEXT，非空 | 连接器验证后得到的稳定用户标识，不能接受浏览器自报身份 |
| `union_id` | TEXT，可空 | 保留现有可选关联信息，不作为自动合并账号的依据 |
| `created_at` | 时间，非空 | 首次创建绑定记录的时间，创建后不变 |
| `updated_at` | 时间，非空 | 最近一次修改绑定记录的时间；创建时与 created_at 相同 |

时间由服务端生成，统一使用 UTC；物理类型沿用身份库约定：PostgreSQL 使用
带时区 timestamp，SQLite 使用整数 Unix 秒，adapter 提供一致的时间语义。
普通登录、查询及重复绑定不修改 `updated_at`；实际更新可选身份元数据等字段时才更新。
`updated_at` 不作为最近登录时间。身份键与 accountId 不通过普通更新转移；更换归属需要显式解绑及重新认证。

必需索引：

- `UNIQUE (provider, namespace, subject)`：同一个外部身份只属于一个账号。
- `INDEX (account_id)`：查询账号的全部外部登录方式、执行账号清理。

不预设 `UNIQUE (account_id, provider)`：同一账号可绑定同平台不同应用的身份。
是否限制同一应用绑定多个身份，属于产品策略，应显式确定后才增加约束。
provider、namespace 和 subject 必须非空，精确匹配，不做大小写折叠。

`account_id` 的关联目标是现有 CSS account，当前没有可直接引用的独立 `users(id)` 表。
通过统一的账号事务入口检查账号存在性并协调绑定、解绑及账号清理，不声明不存在的外键。

## 应用与连接器声明

微信网站与微信小程序可以都使用 `provider = wechat`，通过各自 AppID 区分 namespace。
由哪个连接器执行授权、入口名称、身份字段映射，统一放在程序侧应用注册声明中。
绑定行只记录身份与账号关系；连接器类型、scope、AppSecret 不复制到绑定行。
登录入口 ID 与身份 provider 分开：前者用于路由和授权事务，后者用于绑定事实。
连接器通过统一工厂注册及创建，详见 [连接器工厂适配](external-login-connectors.md)。

现有微信 `provider = wechat`、`namespace = AppID`、`subject = OpenID` 保持稳定。
更换连接器或出现 UnionID 时，不能直接改变既有身份键。
下表是身份范围示意，QQ 的实际 subject/namespace 必须根据最终采用的连接器契约确认：

| account_id | provider | namespace | subject |
| --- | --- | --- | --- |
| account-001 | wechat | 网站 AppID | 网站下的 OpenID |
| account-001 | wechat | 小程序 AppID | 小程序下的 OpenID |
| account-001 | qq | 连接器声明的身份范围 | 连接器返回并验证的稳定标识 |

小程序仍需实现对应协议插件；建表本身不代表已经支持小程序登录。

## 接入现有 CSS 账号链

通过实现现有 `IndexedStorage` 接口的 adapter，把 `external-login` 类型路由到扩展表，
并将列映射为原来的 `accountId`、`provider`、`namespace`、`subject`、`unionId`。
其他账号类型继续交给原有存储。CSS 看到的仍是同一种登录记录，不保存第二份 JSON 副本。

adapter 要覆盖该类型的定义、索引、查询、遍历、创建、更新和删除契约；
不能只实现登录时的查询，否则解绑保护及其他 CSS 消费方会漏掉这些身份。
`ExternalLoginService` 与 CSS 登录方式枚举通过同一个存储入口读写这张表。

`ExternalIdentityAccountStorage` 实现 CSS `LoginStorage` 接口并负责协调：

- Cloud：内部组合 `LoginMethodGuardStorage + ExternalIdentityStorage + DrizzleIndexedStorage`，保留永久无密码账号策略。
- Local/Standalone：内部组合 CSS `BaseLoginAccountStorage + ExternalIdentityStorage + WrappedIndexedStorage`，
  保留原有登录计数、无登录方式账号的使用限制与过期策略。
  通过继承 CSS 的过期钩子，将 30 分钟后的账号复查和删除放入同一账号锁与事务；
  绑定先完成时保留账号，清理先取得锁时拒绝后续向已删除账号绑定，避免成功绑定后被旧检查结果误删。
- Local 的 `WrappedIndexedStorage` 底层使用 `SqliteKeyValueStorage`，现在复用身份数据库连接和事务，
  避免独立连接争锁，并使账号、计数和绑定共同回滚。
- 其他自定义文件存储不能加入 SQL 原子事务；失败注册和计数有进程内补偿，进程崩溃可能留下无绑定账号，
  不能把这种自定义装配宣称为跨存储原子提交。

Managed Local 的外部账号 authority 规则继续有效。

## 登录、绑定与删除

1. 登录：验证并一次性消费授权事务，向第三方换取身份；按三元组直接读取扩展表，
   取得 `account_id`，验证账号有效，再复用 CSS 会话及 OIDC interaction 完成流程。
2. 绑定：从已认证上下文取得 accountId，验证外部身份；同账号重复绑定返回既有绑定，
   已绑定其他账号则报冲突。数据库唯一约束负责跨 worker 竞争，禁止 upsert 覆盖 account_id。
3. 注册：仅在明确 register 意图下创建账号。使用同一 SQL 存储时，创建账号及绑定应在同一事务中完成；
   `withTransaction` 通过异步上下文将 AccountStore 内部的存储调用路由到同一 SQL 连接。
4. 解绑：按已认证 accountId 和绑定 ID 定位记录；在同一账号的数据库协调边界内，
   统计所有登录方式并删除。密码、其他身份等登录方式的删除必须进入同一协调入口，
   只给微信/QQ 的删除加锁不能防止跨方式并发删除。
5. 删除账号：必须清理全部绑定；普通解绑与整账号销毁是不同操作，不能让最后登录方式保护阻塞合法账号销毁。

事务仅覆盖数据库操作，不在持有数据库事务或账号锁时等待第三方网络请求。
短期事务的 state/proof、actor、interaction 校验及错误脱敏沿用现有机制。

所有共享身份库操作（包括既有 ORM 仓储）须经过 `executeIdentityOperation` 或 SQL 辅助函数；
需要跨异步调用的事务使用 `withIdentityTransaction`，不能直接使用 SQLite 同步驱动的事务回调。
前者让事务外的 SQLite 请求排队，事务内的 PG 操作复用同一连接，防止跨请求读到未提交数据
或将其他请求已报告成功的写入一起回滚。连接器网络请求仍在数据库事务之外完成。

## 升级与迁移

1. 停止所有旧版本 worker，排空授权操作并备份身份库。新旧 worker 不得混跑；
   本次更改无需新增配置键，已有 `identityDbUrl` 和应用凭据继续使用。
2. 首次存储访问时，adapter 在数据库协调锁内检查旧绑定、索引和账号的对应关系。
   未过期 reservation 会阻止迁移；已过期且没有绑定事实的 reservation 可以丢弃。
   重复身份、悬空索引、缺失账号及无索引绑定都报告异常，不自动猜测归属。
3. 同一 SQL 事务中复制绑定、记录 `identity_external_identity_migration` 的 v1 标记并移除旧索引表。
   原记录 ID、accountId 及身份键保持不变；任一步骤失败则回滚。
   旧记录缺少历史时间，两个时间字段统一初始化为本次迁移时间，不表示用户最初授权时间。
4. 提交后清理旧 `external-login` 记录。清理中断时，下次启动根据已提交的标记验证目标记录并继续清理；
   旧行仅是待清理记录，运行时只从新表读取绑定，不提供双读/双写回退。
   SQL 事务已经复制成功的行不会在重复启动时被重新插入或重置时间。
5. `ExternalLoginRepository` 只管理短期授权事务，不再创建或维护 reservation/claim 索引。

QQ、小程序等新增协议适配是后续工作；此变更完成统一身份存储，未新增这些登录入口。

## 验收要求

- PG/SQLite 均验证已有账号登录、多应用绑定、身份冲突、显式注册、最后登录方式保护。
- 跨 worker 验证同身份并发绑定、不同登录方式并发解绑、解绑与绑定/账号删除之间的竞争。
- 故障注入验证创建账号和绑定的回滚；迁移验证冲突报告、失败回滚及重复运行。
- 验证创建时两个时间相同、普通登录及重复绑定不更新时间、真实修改更新时间；重复迁移不能重置时间。
- CSS 契约验证完整 adapter 方法、密码登录、remember、interaction 与账号生命周期。
- Local 过期清理验证空账号正常删除，以及首次密码/外部身份绑定与清理的两个并发顺序。
- 构建、测试类型检查、相关单元测试通过后，按仓库要求运行完整集成测试并在完成前再执行一轮。
- 当前实际 Gateway 的真实扫码、账号和 Pod 链路另行按 `docs/cli-dev-testing.md` 验收，
  隔离测试或 mock 结果不能替代真实实例结果。

## 本次验证记录（2026-10-26）

- `bun run build:ts`、`bun run typecheck:test`、`bun run build:components` 通过。
- 连接器工厂、CSS 登录、身份存储、事务与相关回归：166 项通过，8 项条件跳过。
  其中 PostgreSQL 身份存储的 5 项在完整集成阶段使用真实 PG 全部通过；另 3 项是独立 Matrix PG 测试。
- 连续两轮 `bun run test:integration` 均以 0 退出：每轮运行时前置检查 30 项、
  lite 164 项、full 68 项通过；lite 另有 16 项按现有条件跳过。
  full 包含 PostgreSQL 身份存储测试，覆盖唯一约束、账号及 ORM 写入回滚、独立并发请求、并发解绑和迁移。
- 共享 SQLite 事务隔离回归先在旧代码复现失败，修复后通过；用量增量故障注入确认账号写入失败时，
  Pod 用量一起回滚；连接器多实例、跨入口回调、惰性初始化、失败恢复及错误脱敏均有回归。
- 完整回归发现静态授权页缺少源码已有的 `referrer=no-referrer`，已同步生成页并验证。
- 上述结果来自隔离测试环境；未迁移当前运行实例，未执行真实微信扫码，未新增 QQ / 小程序协议适配。

## 修复与复审记录（2026-10-27）

- 修复 Local/Standalone 空账号过期清理与首次登录方式绑定的竞态：复用 CSS 的 protected 过期钩子，
  在同一账号事务内重新读取登录计数并删除账号，保留原有 30 分钟过期策略。
- 使用真实 SQLite 与 CSS `WrappedIndexedStorage` 新增 4 项回归；旧实现可复现并发绑定成功后被误删，
  修复后空账号清理、首次密码/外部身份绑定及清理先取得锁的用例全部通过。
- `bun run build:ts`、`bun run typecheck:test`、`bun run build:components` 通过。
- 账号生命周期、连接器工厂、身份事务、关联仓储与登录 UI 的专项回归：268 项通过，8 项条件跳过。
  UI 测试使用 `NODE_OPTIONS=--no-experimental-webstorage` 避免 Node 25 的全局 localStorage 干扰 jsdom。
- 修复后及提交前各运行一轮 `bun run test:integration`，两轮均为 262 项通过、16 项条件跳过，
  包含真实 PostgreSQL 身份存储回归。
- 上述回归使用隔离测试环境，真实微信扫码与当前运行实例的数据升级仍需另行验收。
