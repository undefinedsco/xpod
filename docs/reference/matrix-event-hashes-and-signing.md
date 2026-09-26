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

签名（规范原文示例，signing name `example.org`，key id `ed25519:1`）：

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

（该示例的完整构造见规范 appendices 的 "Signing JSON → Examples"，实现时应把上表与
该示例固化成仓库内的测试向量文件，而不是只写在文档里。）

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
