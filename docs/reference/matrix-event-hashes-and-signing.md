# Matrix 事件哈希与签名：实现参考

日期：2026-09-26。用途：实现 `matrix-service-identity-contract.md` 第 3 节所需的
event_id / 内容哈希 / 签名规则，附**可复现来源**与**测试向量**。

来源（本仓库网络下用 `curl` 拉取 `matrix-spec` 源码，MCP 的 fetch 对
`raw.githubusercontent.com` 有 SSRF 限制，故改用 shell 获取）：

- `content/rooms/fragments/v4-event-ids.md` → event_id 定义
- `content/server-server-api.md` → 内容哈希与 reference hash 算法
- `content/appendices.md` → Canonical JSON、签名结构、测试向量
- `content/rooms/fragments/v11-redactions.md` → room v11 redaction 规则

## 1. event_id（room v4 及以后，含 v11）

> The event ID is the **reference hash** of the event encoded using
> **URL-safe unpadded Base64**. Event IDs are still prefixed with `$`,
> e.g. `$Rqnc-F-dvnEYJTyHq_iKxU2bZ1CI92-kuZq3a5lr5Zg`.

## 2. 内容哈希（content hash）

1. 移除 `unsigned`、`signatures`、`hashes` 三个属性；
2. 按 Canonical JSON 编码；
3. SHA-256；
4. 结果以 **unpadded Base64** 存入 `hashes.sha256`。

理由（规范原文）：`unsigned` 可被其他服务器修改；`signatures` 依赖当前 `hashes` 值；
`hashes` 未来可能含多种算法，不能自指。

### 2.1 `event_id` 同样必须排除（实现事实，非规范原文）

room v4 及以后 event_id 是事件自身的哈希，**在哈希发生时还不存在**：先算内容哈希，再写入
`hashes`，再由 redaction 后的对象算出 id。因此实现都把 id 放在参与哈希的 JSON 之外。核对
来源（`develop` 分支，`curl` 拉取 `raw.githubusercontent.com`）：

- `synapse/crypto/event_signing.py`：`check_event_content_hash` 校验
  `compute_content_hash(event.get_pdu_json(), …)`，而 `compute_content_hash` 只移除
  `age_ts` / `unsigned` / `signatures` / `hashes` / `outlier` / `destinations`；
- `rust/src/events/mod.rs`：`Event::get_pdu_json` → `get_dict` → `pythonize(parsed_event)`，
  序列化的是解析后的事件 JSON，**不含** `event_id`；id 是 `Event` 结构体上另存的缓存字段
  （模块注释：format v1 从 JSON 读，v2+ 由 canonical-JSON 哈希推导）。

结论：**重算内容哈希时必须排除 `event_id`**。否则把一个从 Pod 读回、id 已附加的事件重新
哈希，会与发送方的哈希不一致，而这种不一致与内容是否被篡改无关。本仓库因此让
`computeContentHash` 移除 `unsigned` / `signatures` / `hashes` / `event_id` 四个键：结果只
取决于事件本身，与调用方是否把 id 放在同一对象里无关。id 的完整性由 reference hash
（`eventIdMatches`）独立保障，不依赖内容哈希。

## 3. reference hash（用于 event_id）

1. 先对事件执行**该 room version 的 redaction 算法**；
2. 移除 `signatures` 与 `unsigned`；
3. Canonical JSON 编码；
4. SHA-256。

**注意**：reference hash 与内容哈希职责不同，不得混用；签名也覆盖 redaction 后的对象。

## 4. room v11 redaction

保留的顶层键：`event_id`、`type`、`room_id`、`sender`、`state_key`、`content`、
`hashes`、`signatures`、`depth`、`prev_events`、`auth_events`、`origin_server_ts`。

`content` 一并清空，除非事件类型属于下列白名单：

| 事件类型 | 允许保留的 content 键 |
| --- | --- |
| `m.room.member` | `membership`、`join_authorised_via_users_server`（以及 `third_party_invite.signed`） |
| `m.room.create` | 全部 |
| `m.room.join_rules` | `join_rule`、`allow` |
| `m.room.power_levels` | `ban`、`events`、`events_default`、`invite`、`kick`、`redact`、`state_default`、`users`、`users_default` |
| `m.room.history_visibility` | `history_visibility` |
| `m.room.redaction` | `redacts` |

## 5. Canonical JSON

- **最短 UTF-8 JSON 编码**，对象键按 **Unicode 码点**字典序排序；
- 数字必须是整数，范围 `[-(2**53)+1, (2**53)-1]`，**无指数、无小数**，不出现 `-0`；
- 浮点值不允许；
- 非 ASCII 码点直接以 UTF-8 输出，**不用 `\u` 转义**。

规范给出的参考实现（Python）：

```py
json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('UTF-8')
```

转义仅限：`\b \t \n \f \r \" \\` 以及 `\u000X`/`\u001X` 形式的其余控制字符。

## 6. 签名

结构：

```json
"signatures": {
  "<server name>": { "ed25519:<key id>": "<unpadded base64 签名>" }
}
```

流程（规范示例代码的语义）：

1. 计算内容哈希并写入 `hashes`；
2. 对事件执行 redaction，得到 stripped object；
3. 对 stripped object 中移除 `unsigned`、`signatures`，Canonical JSON 编码，用
   Ed25519 私钥签名；
4. 把签名并入原事件的 `signatures`（因此 redaction 后仍可验证）。

验签方需要：解析 server name → 取该服务器公钥（`/_matrix/key/v2/server`）→ 按 key ID
选择 → 对同一 stripped + Canonical JSON 结果验签。

## 7. 测试向量

Canonical JSON（规范原文示例）：

| 输入 | 期望输出 |
| --- | --- |
| `{}` | `{}` |
| `{"one":1,"two":"Two"}` | `{"one":1,"two":"Two"}` |
| `{"b":"2","a":"1"}` | `{"a":"1","b":"2"}` |

### 不可复现的规范示例（不作为向量）

规范 appendices 的 "Signing Details" 给出下面这个对象（signing name `example.org`，
key id `ed25519:1`）：

```json
{
  "name": "example.org",
  "signing_keys": { "ed25519:1": "XSl0kuyvrXNj6A+7/tkrB9sxSbRi08Of5uRhxOqZtEQ" },
  "unsigned": { "age_ts": 922834800000 },
  "signatures": {
    "example.org": {
      "ed25519:1": "s76RUgajp8w172am0zQb/iPTHsRnb4SkrzGoeCOSFfcBY2V/1c8QfrmdXHpvnc2jK5BD1WiJIxiMW95fMjK7Bw"
    }
  }
}
```

**本仓库无法用它做测试向量**：按 `sign_json` 的语义（移除 `signatures` 与 `unsigned` 后
Canonical JSON 签名），用文中公钥对这组数据验签**不通过**；原因未确认（该小节讲的是结构，
可能取自更早的示例或另有构造）。Ed25519 与 SPKI 重建路径本身已用自签往返验证可用，
因此登记为"不可复现示例"，等能对账时再决定是否纳入。

### 仓库内自建的向量

`tests/api/matrix/protocol/eventIntegrity.test.ts` 固定：

- 规范给出的 3 个 Canonical JSON 向量；
- 码点排序（`Ｚ` U+FF3A 在 `😀` U+1F600 之前）、最小转义、整数边界与浮点/负零拒绝；
- redaction 白名单（含 `m.room.member` 的 `third_party_invite.signed` 与 `m.room.create` 全量 content）；
- Ed25519 自签往返、篡改与错误签名者/错误 key id/缺签名 fail-closed；
- `unsigned` 变化不影响验签；
- 附加 `event_id` 不改变内容哈希（第 2.1 节），而改动 content 会改变它；
- 签名覆盖 redaction 后的对象：只改 content（`m.room.message` 的内容会被 redaction 清空）
  签名仍有效，改 `sender` 等 redaction 保留字段则签名失效；
- server key 以标准 unpadded base64 发布并可解析回公钥。

**签名算法本身仍需外部对账**：以上是自洽性证明，不等于与其它 Matrix 实现对等。
与独立实现互验属服务身份契约的验收门禁。

## 8. 仓库内可用的实现依赖

| 能力 | 现状 |
| --- | --- |
| Canonical JSON | 依赖树已有 `canonicalize@1.0.8`（RFC 8785）。**注意**：规范正文只要求"最短编码 + 键按码点排序 + 整数范围"，未引用 RFC 8785；两者在整数/浮点与转义细节上是否完全一致需用第 7 节向量固定，不得默认等价 |
| Ed25519 | `node:crypto` 原生支持 Ed25519；`jose@5.10.0` 与 `tweetnacl@0.14.5` 也可用。仓库**尚未**有事件签名实现 |
| SHA-256 / base64 | `node:crypto` |

## 9. 落地时不可省略的三件事

1. **固定规范版本**：本参考基于 `matrix-spec` 源码主干（拉取日期见文首），实现须记录
   对应版本或提交，避免规范漂移后无法对账。
2. **测试向量入库**：第 7 节的向量与签名示例必须成为仓库内的可执行测试，覆盖字段排除、
   键序（含非 ASCII）、整数边界、redaction 白名单。
3. **不混淆三种值**：内容哈希、reference hash、签名各自的对象与用途不同；事件 ID 一致
   或签名有效都不能替代事件授权与状态解析。
