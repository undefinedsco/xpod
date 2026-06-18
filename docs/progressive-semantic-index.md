# Progressive Semantic Index

本文定义 Xpod 对文件、消息上下文和 Agent 检索使用的分层语义索引模型。它补充
[RDF Engine Spec](rdf-engine-spec.md) 和 [SolidFS Spec](solidfs-spec.md)：SolidFS 仍是文件权威，RDF facts/GSPO 与搜索索引都是派生层；本 spec 只定义如何把文件逐层展开成 Agent 可理解、可检索、可继续精读的语义入口。

## 核心判断

不要默认把所有文件切成原文 chunk 并全量 embedding。Xpod 的检索应该是渐进式的：

```text
L0 文件级摘要全量存在
  -> 当前话题/消息上下文选择候选文件
  -> 对候选文件运行 parser
  -> 按目标文件的自然层级展开 L1..Ln
  -> 只对热节点/当前问题继续展开更细 span 或读取原文行范围
```

其中：

- `L0` 是文件级 retrieval point，不要求完整 parser；它可以由上下文推测，也可以由 Agent 选择读取轻量摘要/预览来生成。
- `L1..Ln` 是 parser 输出的语义树层级，层数随文件结构自然展开。
- Markdown 可映射为 `#` 到 `######`；代码、TTL、JSON/YAML、日志等由 parser 映射成等价的语义树。
- 原文文件仍是权威；长期索引默认存摘要、结构、行范围和关系，不默认持久化全部原文 chunk。
- AI 必须知道当前检索覆盖范围和展开深度，不能把局部/摘要检索误认为全局全文检索。

## 默认 Embedding Profile

默认文本 embedding 使用用户 Pod 里的 DashScope / 千问配置：

```text
provider: dashscope
model: text-embedding-v4
baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
dimension: 1024
maxBatchSize: 10
maxTokensPerInput: 8192
```

规则：

- provider、model、credential 仍复用标准 AI config，不新增 embedding 专用密钥资源。
- `qwen` / `alibaba` 作为 `dashscope` 的输入别名；持久化时优先写 canonical provider `dashscope`。
- 没有显式 `AIConfig.embeddingModel`、但当前 credential/provider 是 DashScope/Qwen/Alibaba 时，运行时使用 `text-embedding-v4` 作为轻量默认 embedding model。
- 请求层使用现有 AI SDK / OpenAI-compatible 抽象；核心只维护 `EmbeddingService.embed/embedBatch`，不引入 LangChain/LlamaIndex 依赖。
- `text-embedding-v4` 单请求条数限制按 10 条切 batch；不同 embedding profile 仍分开索引和比较。

## 三条独立生命周期

架构分成三类对象，每类有独立生命周期。

```text
File / Message Context
  -> L0 source retrieval point
  -> Parser lifecycle
      -> Parsed semantic tree L1..Ln
          -> Retrieval-point lifecycle
              -> Index-method lifecycle
                  -> search / ranking / RDF join
```

### Parser lifecycle

Parser 只负责把源文件投影成语义树：

```text
file content -> ParsedDocumentTree
```

推荐统一输出：

```ts
interface ParsedNode {
  source: string;              // source IRI / URI
  node: string;                // node IRI / URI
  parent?: string;
  level: number;               // 1..N, follows target file structure
  kind: string;                // heading | class | function | method | rdf-resource | config-block | span | ...
  title?: string;
  startLine: number;
  endLine: number;
  summary?: string;
  entities?: string[];
  contentHash: string;
  parser: string;
  parserVersion: string;
  parserOptionsHash?: string;
}
```

Parser state：

```text
missing -> parsing -> ready -> stale -> failed
```

Parser cache key 至少包含：

```text
source + contentHash + parser + parserVersion + parserOptionsHash
```

触发 parser 失效的条件：

- 文件 content hash 变化；
- parser 版本变化；
- parser options 变化；
- 用户或 Agent 要求展开到当前 cache 未覆盖的层级；
- parser 依赖的外部 schema/grammar 版本变化。

### Free-quota-first parser provider policy

外部 parser 的默认选择必须按“可持续免费量”而不是单纯能力排序。Xpod 不应默认消耗平台公共额度；
parser 的 provider、model、credential 必须复用用户 Pod 里的标准 AI config（Provider / Model / Credential），
和 chat / embedding 模型走同一套配置、密钥、代理和默认模型语义。系统只负责路由、缓存、失败降级和 coverage 报告。

免费额度策略分四类：

| Quota class | Meaning | Product use |
| --- | --- | --- |
| `daily-recurring` | 每天刷新，最适合作为默认外部 parser | 默认优先使用；耗尽后当天降级 |
| `monthly-recurring` | 每月刷新，可作为次优默认或 crawl/doc fallback | 需要 usage guard，避免一次任务打满 |
| `rate-limited` | 无明确总量，但受 RPM/IP 限制 | 适合网页、轻量 parser；需要退避重试 |
| `one-time-trial` | 注册赠送或短期试用，额度用完不恢复 | 只用于 benchmark/onboarding，不作为长期默认 |

按当前调研应采用以下 provider 路由（上线前需重新核对官方页面，因为免费额度会变化）：

| Provider | Best for | Free quota shape | Default role |
| --- | --- | --- | --- |
| Jina Reader | 单网页 / URL -> Markdown | rate-limited：无 key 约 20 RPM；免费 key 约 500 RPM | `web.singlePage.primary` |
| Firecrawl | crawl / sitemap / 多页站点抓取 | monthly-recurring：免费计划约 1,000 credits/月 | `web.crawl.primary` |
| PaddleOCR official API | 文档解析、OCR、MCP/Skills 场景 | daily-recurring：官方文档称免费 API 最高支持约 20,000 pages/day | `document.primary` |
| PaddleOCR local plugin | 本地/自托管 OCR 与文档解析 | self-hosted/local：无外部额度，但依赖和模型较重 | `localPlugin` |
| MinerU precise API | PDF、Office、图片、中文论文、表格、公式、复杂版式 | daily-recurring：账号每天约 1,000 页最高优先级；单文件约 200MB/200页 | `document.qualityFallback` |
| MinerU Agent light API | 小文件快速 Markdown | rate-limited：免 token，IP 限频；约 10MB/20页限制 | `document.quickFallback` |
| LlamaParse | MinerU/PaddleOCR 失败后的 SaaS 兜底 | monthly-recurring：Free plan 约 10K credits/月；复杂模式消耗更快 | `document.fallback` |
| OCR.space | 小图片 OCR / 小扫描件 | daily/monthly-recurring：免费约 500 requests/day/IP、25,000 requests/month；文件约 1MB、PDF 约 3页 | `imageOcr.fallback` |
| Unstructured API | onboarding/benchmark | one-time-trial：约 15,000 free pages，无过期 | `benchmarkOnly` |
| Reducto | 高质量复杂文档对照 | one-time-trial：first 15K credits | `benchmarkOnly` |
| Azure Document Intelligence | 企业已有 Azure 时 | monthly-recurring but small：约 500 pages/month | `enterpriseOptional` |
| AWS Textract | 企业 AWS 试用/已有账户 | short trial：新账号约 3 个月免费层 | `enterpriseOptional` |

默认路由：

```yaml
parserRouter:
  web:
    singlePage:
      primary: jina-reader
    crawl:
      primary: firecrawl

  document:
    quick:
      primary: paddleocr-api
      fallback:
        - mineru-agent-light
        - local-lib
    pdfOrOffice:
      primary: paddleocr-api
      fallback:
        - mineru-precise
        - llamaparse
        - local-lib
    imageOcr:
      primary: paddleocr-api
      fallback:
        - ocrspace
        - mineru-precise
        - local-lib

  benchmarkOnly:
    - unstructured
    - reducto
```

### Canonical AI config storage for parser models

Parser provider 不是一套新资源。PaddleOCR、MinerU、LlamaParse 这类 parser 都应建模为普通 `ai:Provider`；
可调用的解析模型建模为 `ai:Model`，并用 `ai:modelType "parser"` 区分 chat / embedding / parser。
密钥仍放 `cred:Credential`，`cred:service "ai"`，通过 `cred:provider` 指向同一个 provider。

```turtle
@prefix ai: <https://vocab.xpod.dev/ai#> .
@prefix cred: <https://vocab.xpod.dev/credential#> .

# /settings/providers/paddleocr.ttl
</settings/providers/paddleocr.ttl>
  a ai:Provider ;
  ai:displayName "PaddleOCR" ;
  ai:hasModel </settings/providers/paddleocr.ttl#pp-ocrv6> ;
  ai:defaultModel </settings/providers/paddleocr.ttl#pp-ocrv6> .

</settings/providers/paddleocr.ttl#pp-ocrv6>
  a ai:Model ;
  ai:displayName "PP-OCRv6" ;
  ai:modelType "parser" ;
  ai:isProvidedBy </settings/providers/paddleocr.ttl> ;
  ai:status "active" .

# /settings/credentials.ttl
<#cred_8f3k2x>
  a cred:Credential ;
  cred:service "ai" ;
  cred:provider </settings/providers/paddleocr.ttl> ;
  cred:status "active" ;
  cred:label "默认" ;
  cred:isDefault true ;
  cred:apiKey "paddle-access-token" .
```

规则：

- 不新增 `ParserProvider` / `ParserCredential` / `ParserModel` 资源；parser 是 AI provider 的一种 model type。
- Credential 资源 id 使用随机 `cred_*`，不要编码 `paddleocr-default` 这类 provider/default 语义；展示名和默认选择分别用 `cred:label`、`cred:isDefault`。
- API token、access token、key 在存储层统一叫 `apiKey`；adapter 内部再映射成 `PADDLEOCR_ACCESS_TOKEN` 或 `Authorization: Bearer`。
- parser router 只能引用 provider/model 的 id 或 IRI，不能直接保存密钥。
- shared `@undefineds.co/models` 需要让 AI config mutation/read 保留 `modelType: "parser"`，避免写入时退化成 `chat`。

当外部免费额度到期、限频、不可达或用户未配置 key 时，必须退回 `local-lib`，而不是静默失败：

```text
external parser unavailable
  -> mark provider usage: exhausted | rate_limited | missing_key | unavailable
  -> fallback to local-lib parser
  -> mark parser coverage lower
  -> tell Agent which parser was used and what fidelity was lost
```

`local-lib` 是一组本地/自托管 parser adapter，而不是单个库。重型本地 parser 不进入 xpod 主发布包，必须通过插件安装：

```text
xpod core
  -> ParserProvider interface
  -> lightweight built-in parsers
  -> optional parser plugins
      - xpod-parser-paddleocr
      - xpod-parser-docling
      - xpod-parser-tesseract
```

PaddleOCR 应作为插件优先集成，而不是主包依赖。原因：PaddleOCR 3.x 的能力很强，但 Python、PaddlePaddle/Transformers、模型文件、OpenVINO/GPU/Apple Silicon 等运行时差异会显著增加安装体积和兼容性风险。插件可以按需安装、单独升级、单独做健康检查，并允许 local/cloud 使用不同后端。

PaddleOCR 插件边界：

| Mode | Use | Packaging |
| --- | --- | --- |
| `paddleocr-api` | 调 PaddleOCR 官方 API，利用每日免费页数 | 轻量 TypeScript adapter，可进普通插件 |
| `paddleocr-local` | 本地 OCR/PP-Structure/PaddleOCR-VL 推理 | Python sidecar/plugin，不进入 xpod core |
| `paddleocr-container` | Cloud/self-hosted GPU/CPU 服务 | 独立镜像，通过 parser provider endpoint 接入 |

插件失败时仍退回普通 `local-lib`，并在 coverage 中标记 `fallback-used`。

| File class | Local fallback expectation |
| --- | --- |
| Markdown/text/code/json/yaml/ttl | built-in parser / tree-sitter / RDF parser；应可稳定产出 L1..Ln 或 line ranges |
| HTML | Readability/HTML-to-Markdown 类本地转换 |
| PDF text layer | 本地 PDF text extractor，质量低于 MinerU/LlamaParse，但不消耗额度 |
| Scanned PDF/image OCR | 本地 OCR 可选；没有 OCR runtime 时只返回低 coverage |
| Office docs | 本地转换器可选；不可用时降级为 metadata/L0 |

外部 parser 与 local-lib 的选择必须写入 coverage：

```ts
interface ParserProviderUsage {
  provider: string;
  quotaClass: 'daily-recurring' | 'monthly-recurring' | 'rate-limited' | 'one-time-trial' | 'self-hosted' | 'local-lib';
  status: 'ready' | 'exhausted' | 'rate-limited' | 'missing-key' | 'unavailable' | 'fallback-used';
  resetAt?: string;
  usedPages?: number;
  remainingPages?: number;
  source: 'user-pod-config' | 'local-runtime' | 'system-default';
}
```

缓存必须先于额度消耗：

```text
cache key = fileDigest + parserProvider + parserVersion + parserOptionsHash + pageRange
```

命中缓存时不调用外部 API。对页数型 provider，按 page range 渐进解析；系统给出激进的预算和默认建议，但具体页段由 Agent 决定，且不能上传即全文解析。

### Agent-decided page-window policy

PaddleOCR official API 的免费页数足够大时，系统不应该硬编码“每次固定解析多少页”。系统负责管理 provider/model/token、缓存、coverage 和硬性安全边界，并把当前预算、provider 状态、文件元信息、已有 coverage 暴露给 Agent；Agent 根据当前任务决定是否解析、解析哪几页、一次解析多少页。预算不是纯硬错误：Agent 预计超预算时应向用户说明收益和成本，并请求确认或降级。上传/同步文件时仍只建 L0，不自动全文解析；只有 Agent、用户或检索流程实际需要读文档内容时才消耗外部 parser 额度。

```yaml
parserPolicy:
  provider: paddleocr
  model: pp-ocrv6

  l0:
    parseExternal: false
    decisionOwner: agent
    allowContextInference: true
    allowLightweightPreview: true
    suggestion:
      localPreviewPages: 1
      localPreviewBytes: 65536

  decision:
    owner: agent
    defaultSuggestion:
      initialPages: 20
      structureProbeMaxPages: 50
      pageWindow: 50
      maxPageWindow: 100
    allowAgentOverride: true
    requireReason: true
    exposeBudgetToAgent: true
    overBudgetBehavior: ask-user-or-degrade

  systemPrefetch:
    owner: system
    triggers:
      - user-open-detail
      - user-scroll-near-unparsed-page
      - user-search-within-document
    lookAheadPages: 10
    maxLookAheadPages: 30
    respectHardLimits: true

  hardLimits:
    maxPagesPerRun: 500
    maxPagesPerFilePerDay: 1000
    maxDailyProviderBudgetRatio: 0.8
```

行为：

1. 文件入库只创建 L0 候选；Agent 可选择仅用上下文推测，也可读取轻量预览/摘要生成 L0，但不调用 PaddleOCR 做完整解析。
2. Agent 看到 L0、用户问题、文件页数、剩余额度、已解析 coverage 后，决定是否调用 parser。
3. 系统给默认建议：首次可解析 20 页，结构探测可到 50 页，后续窗口建议 50 页，单窗口不超过 100 页。
4. Agent 可以选择更小窗口、更大窗口、指定页段或跳过解析，但必须给出 reason，并受 hard limits 约束。
5. Agent 判断会超出建议预算但仍值得解析时，应向用户说明预计页数、收益、额度影响，并请求确认；用户拒绝或无响应时降级到已有 coverage / local preview / metadata-only。
6. 用户打开文档详情并向下翻页、接近未解析页段或在文档内搜索时，由系统做提前解析/预取，不需要 Agent 决策；系统预取只为交互体验服务，仍记录 coverage 并遵守 hard limits。
7. 自动解析单 Run 最多 500 页，单文件每天最多 1000 页。
8. 自动任务默认最多使用 provider 当日可用预算的 80%。以 20,000 pages/day 估算，自动预算约 16,000 页/天。
9. 用户显式触发“全文解析/继续解析”可以突破单 Run 限制，但仍应受 daily provider budget 和账号级限额保护。

### System-driven prefetch

不是所有解析都由 Agent 决策。用户正在 UI 中打开文档详情、翻页、滚动接近未解析页段、或在文档内搜索时，系统可以主动预取解析结果。这类解析属于交互式缓存预热，不需要 Agent 写 reason，但必须记录触发来源和 coverage。

```ts
interface SystemParserPrefetch {
  source: string;
  provider: 'paddleocr';
  model: 'pp-ocrv6';
  pageRange: string;
  trigger: 'user-open-detail' | 'user-scroll-near-unparsed-page' | 'user-search-within-document';
  visiblePage?: number;
  lookAheadPages: number;
  budgetBefore: {
    fileRemainingPagesToday: number;
    providerRemainingPagesToday?: number;
  };
}
```

预取策略建议：

- 打开详情页：确保当前页和后续 10 页 ready；
- 滚动接近未解析区域：提前 10 页，网络/额度充足时最多 30 页；
- 文档内搜索：优先解析目录/已命中附近页段；
- 预取不得突破 hard limits；达到软预算时停止并提示“继续解析需要确认”。

Agent 发起 parser run 时必须显式记录决策：

```ts
interface ParserDecision {
  source: string;
  provider: 'paddleocr';
  model: 'pp-ocrv6';
  pageRange: string;
  reason: string;
  expectedUse: 'structure-probe' | 'answer-evidence' | 'table-extraction' | 'ocr' | 'full-import';
  budgetBefore: {
    runRemainingPages: number;
    fileRemainingPagesToday: number;
    providerRemainingPagesToday?: number;
  };
}
```

每次 parser run 必须记录实际页段和 coverage，例如：

```ts
{
  provider: 'paddleocr',
  model: 'pp-ocrv6',
  pageRange: '1-20',
  coverage: 'partial',
  decisionOwner: 'agent',
  reason: 'Need a structure probe before answering questions about this PDF.',
  nextAction: 'expand pageRange 21-50 if answer evidence is insufficient',
}
```

Sources to re-check before implementation:

- Jina Reader: <https://jina.ai/reader/>
- Firecrawl pricing: <https://www.firecrawl.dev/pricing>
- MinerU API docs: <https://mineru.net/apiManage/docs>
- LlamaIndex/LlamaParse pricing: <https://www.llamaindex.ai/pricing>
- OCR.space API: <https://ocr.space/ocrapi>
- Unstructured pricing: <https://unstructured.io/pricing>
- Reducto pricing: <https://reducto.ai/pricing>
- Azure AI Document Intelligence pricing: <https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/>
- AWS Textract pricing: <https://aws.amazon.com/textract/pricing/>
- PaddleOCR releases: <https://github.com/PaddlePaddle/PaddleOCR/releases>
- PaddleOCR docs: <https://www.paddleocr.ai/main/en/index.html>
- PaddleOCR installation / optional dependency groups: <https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/installation.en.md>

### Retrieval-point lifecycle

Retrieval point 是 Agent 和搜索系统真正召回的语义入口。它可以来自：

- L0 文件级摘要；
- parser tree 的 L1..Ln 节点；
- 当前 run/thread/task/message 上下文；
- 热节点下临时展开的 span；
- 用户显式指定的文件/行范围。

推荐模型：

```ts
interface RetrievalPoint {
  point: string;               // point IRI / URI
  source: string;
  node?: string;
  level: number;               // 0 for source summary, 1..N for parsed tree
  kind: 'file-summary' | 'section' | 'symbol' | 'resource' | 'config-block' | 'hot-span' | string;
  title?: string;
  summary: string;
  startLine?: number;
  endLine?: number;
  coverage: 'summary-only' | 'line-addressable' | 'raw-cached';
  freshness: 'ready' | 'stale' | 'building' | 'failed';
  contentHash?: string;
  expiresAt?: string;
}
```

Retrieval point state：

```text
candidate -> indexed -> hot -> expired -> stale
```

Retrieval point 生命周期可以比 parser 更短。例如 hot span 可以只服务当前 run，run 结束后降级或删除；L0 文件摘要则应该尽量全量、长期存在。

### Index-method lifecycle

Index method 是召回 retrieval point 的具体方法，可替换、可多后端实现：

- GSPO / RDF facts：存语义目录、关系、状态、权限相关边；
- FTS5 / PostgreSQL text：存 lexical postings、BM25、phrase/prefix 命中；
- turbovec / pgvector / vector component table：存 embedding / ANN 派生索引；
- entity bridge：存 point/chunk 到 RDF entity/predicate 的 mention；
- recency/hotness ranker：存或计算近期使用、消息引用、工具调用痕迹。

推荐状态：

```ts
interface IndexMethodState {
  method: 'gspo' | 'fts' | 'vector' | 'entity' | 'recency' | string;
  point: string;
  status: 'none' | 'building' | 'ready' | 'stale' | 'failed';
  version: string;
  indexedAt?: string;
  error?: string;
}
```

Index method state：

```text
not-indexed -> building -> ready -> stale -> rebuilding -> ready
```

触发 index method 失效的条件：

- retrieval point summary/title/line range 变化；
- embedding model 或 vector backend 版本变化；
- FTS tokenizer/analyzer 版本变化；
- entity extractor 版本变化；
- ACL/ACR scope materialization 变化；
- source content hash 与 index checkpoint 不一致。

## Level 语义

### L0：Source-level semantic summary

L0 每个文件至少一条，要求全量覆盖。L0 不要求完整 parser，但 L0 的生成方式由 Agent 决定：有些文件可以只从上下文推测；有些文件需要读取轻量摘要、首屏、第一页或已有 preview 后再生成。

L0 source 可以来自：

- path / filename / extension / content type；
- size / mtime / git status；
- message、run、thread、task 中对该文件的提及；
- 工具调用历史、最近打开/修改；
- 用户上传、拖拽、重命名、移动时给出的描述；
- 相邻文件、README、目录名、同仓库约定；
- 已知 tags/entities；
- 旧 parser cache 摘要或旧 L0 摘要；
- Agent 决定读取的轻量本地 preview，例如文本头部、PDF 首 1 页、Office 元数据/摘要页。

L0 必须记录实际生成方式。`mode` 不是用户配置项，也不是预设策略；它是系统在生成 L0 后写入的结果记录，用来告诉 Agent 这条摘要到底来自上下文推测、轻量预览还是旧缓存。不能把上下文推测伪装成正文解析，也不能把轻量 preview 伪装成完整 parser-confirmed content：

```ts
interface L0SourceSummary {
  source: string;
  summary?: string;
  mode: 'context-inferred' | 'lightweight-preview' | 'old-cache';
  confidence: 'low' | 'medium' | 'high';
  evidence: Array<'path' | 'mime' | 'message-context' | 'tool-history' | 'user-description' | 'neighbor-files' | 'old-cache' | 'local-preview'>;
  previewRange?: {
    pages?: string;
    bytes?: number;
    lines?: string;
  };
  parserConfirmed: false;
}
```

Agent 选择 L0 生成方式的建议如下。这里的 `mode` 是生成后的审计字段，不要求用户手动配置：

| Situation observed at runtime | L0 generation result |
| --- | --- |
| 文件名/路径/上下文已经足够明确 | `mode = context-inferred` |
| 用户问题依赖文档主题但不需要结构细节 | `mode = lightweight-preview` |
| 文件曾解析过且 hash 未变或可降级复用 | `mode = old-cache` |
| 用户需要表格/公式/版面/页级证据 | 不停留在 L0，进入 parser L1+ |

### Source usage context for Agent decisions

为了让 Agent 判断 L0 是否足够、是否需要读取 preview 或启动 parser，系统必须提供文件在产品上下文里的使用痕迹。这个上下文不是 parser 结果，而是 source usage graph / activity index。

推荐结构：

```ts
interface SourceUsageContext {
  source: string;
  mentions: Array<{
    surface: 'chat' | 'task' | 'run' | 'message' | 'tool-call' | 'upload' | 'ui-open';
    resource: string;            // chat/thread/message/run/tool call IRI or id
    title?: string;
    excerpt?: string;            // short context around mention, not full transcript
    mentionedAs?: string;        // filename, pasted path, attachment label, etc.
    actor?: string;
    timestamp: string;
    confidence: 'low' | 'medium' | 'high';
  }>;
  recentActions: Array<{
    action: 'uploaded' | 'opened' | 'edited' | 'moved' | 'renamed' | 'attached' | 'referenced' | 'generated';
    resource: string;
    timestamp: string;
    actor?: string;
  }>;
  relatedSources?: Array<{
    source: string;
    relation: 'same-folder' | 'linked-from-message' | 'generated-from' | 'attached-together' | 'referenced-by-same-run';
  }>;
}
```

Agent 决策时应看到：

```text
source L0 summary + source usage context + current user question + parser coverage + budget
```

例如：

- 文件在某个 chat 里作为附件上传，并且用户说“这是合同初稿”；Agent 可以先用上下文生成 L0。
- 文件路径叫 `scan001.pdf`，上下文缺失；Agent 应读取 lightweight preview 或请求 parser。
- 文件在某个 run 的工具调用里被生成，且 run 说明是“导出的财务表”；Agent 可以把该 run context 作为 L0 evidence。

系统应限制 context excerpt 长度，只提供判断 L0/解析策略所需的短上下文，避免把整段聊天重复塞入 retrieval。

L0 回答：

```text
这个文件大概是什么？
当前问题是否可能需要它？
是否值得运行 parser 展开 L1..Ln？
```

### L1..Ln：Parser semantic tree levels

L1 开始必须来自 parser 或 parser-like 投影。

Markdown：

```text
L1 = # heading
L2 = ## heading
L3 = ### heading
...
L6 = ###### heading
```

代码：

```text
L1 = top-level export / class / function / module / major declaration
L2 = method / nested function / interface member / class field
L3+ = block-level semantic region / doc comment section / hot span / line range
```

TTL/RDF：

```text
L1 = graph/resource group / ontology section
L2 = subject/resource cluster / shape/class/property group
L3+ = predicate group / statement span / by-line range
```

JSON/YAML/config：

```text
L1 = top-level key / object block
L2 = nested object/array section
L3+ = leaf block / repeated item / hot span
```

不要硬编码最大层级。`level` 随目标文件的自然结构展开。

## 存储边界

GSPO/RDF 适合存 semantic catalog：

```ttl
<file:src/runtime/SessionManager.ts>
  a xpod:IndexedSource ;
  xpod:path "src/runtime/SessionManager.ts" ;
  xpod:l0Summary "Manages agent sessions and run restoration." ;
  xpod:hasRetrievalPoint <file:src/runtime/SessionManager.ts#l0> ;
  xpod:hasIndexNode <file:src/runtime/SessionManager.ts#node-SessionManager> .

<file:src/runtime/SessionManager.ts#node-SessionManager>
  a xpod:IndexNode ;
  xpod:level 1 ;
  xpod:kind "class" ;
  xpod:title "SessionManager" ;
  xpod:startLine 20 ;
  xpod:endLine 240 .
```

FTS/vector/entity backend 适合存 method-specific index，不应把以下内容塞进 GSPO：

- token posting；
- per-term frequency posting；
- embedding float 或 ANN graph edge；
- 每次 query 的临时 score；
- 大规模 per-topic relevance matrix；
- 全量原文 chunk 副本。

共同 join anchor 应该是：

```text
source IRI/URI + retrieval point IRI/URI + optional stable numeric point id
```

FTS、vector、entity、GSPO 可以分表存储，但必须通过这个 anchor join。

## Query / Agent contract

任何检索结果都必须暴露覆盖范围和展开深度，避免 AI 把局部结果误认为全局事实。

推荐返回：

```ts
interface RetrievalCoverage {
  sourceCatalog: 'full' | 'partial';
  searchedLevel: number;
  maxAvailableLevel?: number;
  parserStatus: 'ready' | 'stale' | 'missing' | 'failed' | 'partial';
  rawContent: 'not-read' | 'line-range-read' | 'cached-preview';
  indexMethodsUsed: string[];
  vectorCoverage?: 'none' | 'summary-only' | 'section-only' | 'hot-only' | 'full';
  textCoverage?: 'none' | 'summary-only' | 'section-only' | 'hot-only' | 'full';
  warnings?: string[];
  nextActions?: string[];
}
```

面向 Agent 的提示必须表达：

```text
This retrieval searched full L0 source summaries and selected parsed levels only.
Raw file content is not globally chunk-indexed.
If evidence is insufficient, expand the relevant node or read source line ranges.
```

## Retrieval flow

推荐默认流程：

```text
user prompt + thread/run/task/message context
  -> build topic profile
  -> search/rank L0 source summaries
  -> choose candidate sources
  -> parse candidate sources to L1..Ln as needed
  -> create/update retrieval points
  -> index retrieval points through available methods
  -> retrieve/rerank points
  -> RDF/GSPO join for relationships and permissions
  -> read exact line ranges only when evidence requires raw content
```

问题越细，展开层级越高；但展开必须有边界：最大文件数、最大节点数、最大行数、最大 embedding 调用、最大 wall time。

## Vector backend note

`turbovec` 可作为 local-first compressed vector backend candidate，但只负责 retrieval point 的 ANN 派生索引：

```text
turbovec: stable point id -> compressed embedding
RDF/DB: source/node/point metadata, permissions, content hash, lifecycle state
```

它不能成为事实源。cloud 可先保持 PostgreSQL vector component / pgvector-compatible baseline；如果引入 turbovec artifact，需要额外定义锁、flush、checkpoint、rebuild 和 Pod 迁移策略。

## 验收标准

实现该 spec 时至少验证：

1. 每个文件都有 L0 retrieval point，AI 能看到全量/部分覆盖状态。
2. Markdown parser 能把 H1-H6 映射为 L1-L6。
3. 代码 parser 能把 top-level symbol 和 method 映射为 L1/L2。
4. 文件 hash 变化会让 parser cache、retrieval point 和 index method state 正确 stale/rebuild。
5. 检索结果带 `RetrievalCoverage`，不会把 partial search 伪装成 global search。
6. FTS/vector/entity 与 GSPO 能通过 retrieval point anchor join。
7. 原文仍从 SolidFS/文件系统按 line range 读取，不依赖长期 chunk 副本作为事实源。

## Related implementations to track

CodeGraph、Semble、tree-sitter/LSP based code indexer、ripgrep 这类实现应作为长期跟踪对象，
但不能替代 Xpod 的核心模型。它们是 Progressive Semantic Index 在代码域或文本域的特例实现。

需要持续跟踪的维度：

| Implementation class | Track for | Boundary in Xpod |
| --- | --- | --- |
| Semble / semantic code search | file/symbol retrieval、semantic ranking、local index UX、CLI baseline | 可作为 code-domain parser/search adapter 或 benchmark 对照，不进入事实源 |
| CodeGraph-style systems | symbol graph、import/call/reference graph、incremental update | 可映射为 parser tree + GSPO relation，不能绑死整体架构 |
| tree-sitter / LSP | multi-language parser、stable symbol id、incremental parse | parser backend candidate |
| ripgrep / grep-like tools | raw lexical search、line evidence baseline、local filesystem truth | benchmark baseline 和 fallback tool，不作为 semantic index |
| QLever-style SPARQL+Text | word/entity occurrence 与 RDF join 的设计经验 | 只吸收 text/entity/RDF join 思想，不暴露 QLever backend |
| turbovec / vector engines | compressed ANN、allowlist filtering、local-first vector artifact | index-method backend candidate，metadata/authority 仍在 RDF/DB/SolidFS |

跟踪结论必须回到三条生命周期：

```text
Parser lifecycle
Retrieval-point lifecycle
Index-method lifecycle
```

外部产品如果只覆盖代码 parser 或搜索 ranking，只能作为对应生命周期的 adapter / baseline，
不能把 Xpod 的 workspace、Pod、message、task、run、RDF 权限和 coverage 语义降级为 code-only search。

## Productized benchmark

Progressive Semantic Index 的 benchmark 不应只是一次性脚本。它应该成为产品能力：

```text
Benchmark = retrieval quality evaluation + index health + agent context observability
```

目标不是追通用 MTEB 或 QLever benchmark，而是回答：

```text
给定一个真实 thread/run/task 问题，系统是否用合理成本找到了正确文件、结构节点和证据行？
如果没有，系统是否诚实暴露 coverage 并给出下一步 expand/read/index 建议？
```

### Benchmark as product surfaces

建议产品化为以下 surfaces：

| Surface | Purpose |
| --- | --- |
| Retrieval report | 每次 Agent context retrieval 输出 source/node/evidence recall、coverage、成本和 explain |
| Golden cases | 从真实历史问题沉淀的 workspace/thread/run 检索用例 |
| Regression gate | parser/index/ranking 变更后自动跑 golden cases，防止召回和 coverage 退化 |
| Admin / dashboard | 展示 index coverage、stale/failed parser cache、vector/text readiness、慢 retrieval |
| Agent self-check | 当 coverage 不足时，让 Agent 知道该 expand node、read line range 或 request indexing |
| External baseline comparison | rg、Semble/CodeGraph adapter、raw chunk embedding、L0-only、progressive/hybrid 的对照 |

### Core benchmark contract

推荐 case 输入：

```ts
interface RetrievalBenchmarkCase {
  id: string;
  workspace: string;
  question: string;
  threadMessages?: string[];
  runHistory?: string[];
  expectedEvidence: Array<{
    source: string;
    startLine?: number;
    endLine?: number;
    nodeTitle?: string;
    reason?: string;
  }>;
}
```

推荐输出：

```ts
interface RetrievalBenchmarkReport {
  caseId: string;
  strategy: 'rg' | 'external-code-search' | 'raw-chunk-embedding' | 'l0-only' | 'progressive' | 'hybrid';
  sourceRecallAtK: Record<number, number>;
  nodeRecallAtK: Record<number, number>;
  evidenceRecallAtK: Record<number, number>;
  mrr: number;
  parsedFiles: number;
  parsedNodes: number;
  embeddedPoints: number;
  returnedTokens: number;
  latencyMs: number;
  coverageHonest: boolean;
  suggestedNextActionCorrect?: boolean;
  warnings: string[];
}
```

### Strategies to compare

每个 golden case 至少比较：

1. `rg`：原始文件关键词检索 baseline；
2. `external-code-search`：Semble / CodeGraph-style adapter，如可用；
3. `raw-chunk-embedding`：全量 raw chunk RAG baseline；
4. `l0-only`：只使用文件级摘要；
5. `progressive`：L0 -> parser L1..Ln -> line range；
6. `hybrid`：progressive + FTS/entity/vector/RDF join。

### Product metrics

核心指标不是单纯 latency 或 topK 命中，而是：

```text
evidence recall / cost
```

必须同时记录：

- `Source Recall@K`：正确文件是否进入前 K；
- `Node Recall@K`：正确 parser node 是否进入前 K；
- `Evidence Recall@K`：正确 line range 是否被找到；
- `MRR`：第一个正确证据排第几；
- `Parse Cost`：解析文件数、节点数、行数；
- `Embedding Cost`：embedding 点数、模型、token/调用数；
- `Returned Token Cost`：交给 Agent 的上下文 token；
- `Latency p50/p95`：检索耗时；
- `Coverage Honesty`：partial search 是否明确告知；
- `Escalation Success`：初次不够时，expand/read/index 建议是否能找到证据。

### Runtime use

Benchmark 报告应复用于运行时：

```text
retrieval report -> dashboard/admin -> regression gate -> Agent self-check
```

这样 benchmark 不是研发侧临时验证，而是产品里的 retrieval observability。用户或团队能看到：

- 当前 workspace 哪些文件只有 L0；
- 哪些 parser cache stale/failed；
- 哪些 retrieval 经常需要 expand；
- 哪些 query 依赖 raw line read；
- 哪些外部 baseline 比当前 progressive strategy 更好；
- 最近一次 ranking/index/parser 改动是否让 golden cases 退化。


## Space-efficient authority model

Progressive Semantic Index 的空间模型必须坚持：

```text
raw content authority = SolidFS / local filesystem / object storage
semantic index = location refs + retrieval points + optional projections + embedding artifacts
```

也就是说，默认不把每个 raw chunk 的完整原文复制进长期索引。索引层只记录足够恢复和定位原文的结构信息。

### What can be stored broadly

以下内容空间可控，可以全量或较全量存储：

- L0 source summary / metadata；
- `ParsedNode` tree；
- node title / kind / heading path / symbol name；
- `startLine` / `endLine` / optional byte offsets；
- `contentHash` / `nodeHash` / `anchorHash`；
- retrieval point records；
- entity mentions；
- parser/index lifecycle state；
- embedding vectors or compressed vector artifacts for L0/L1/L2 and selected hot nodes。

### What should not be stored by default

以下内容不应默认全量持久化：

- 每个 node 的完整原文 body；
- 每个 raw chunk 的完整原文；
- token posting 写入 GSPO；
- ANN graph edges 写入 GSPO；
- 每次 query 的临时 score；
- 大规模 per-topic relevance matrix。

如果需要 snippet 或 debug，可存短 `contentPreview`；它不是事实源，必须带 hash/version，并可随时删除重建。

### Location refs

只存位置要求位置可验证、可失效、可重定位。推荐最小结构：

```ts
interface LocationRef {
  source: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  startByte?: number;
  endByte?: number;
  anchorHash?: string;      // hash of the referenced range
  headingPath?: string[];
  symbolPath?: string[];
}
```

当 source `contentHash` 变化：

```text
if anchor/hash/path can relocate:
  update location refs and mark derived indexes stale/rebuild
else:
  mark retrieval point stale and require reparse
```

### Projection and embedding policy

Summary/projection 不是必填字段，而是可选派生投影。Embedding input 不必等于 summary。

```ts
type ProjectionKind =
  | 'title'
  | 'signature'
  | 'docstring'
  | 'first-paragraph'
  | 'extractive-summary'
  | 'abstractive-summary'
  | 'raw-range'
  | 'hybrid';
```

推荐策略：

- 有标题、docstring、first paragraph 时，优先 extractive projection；
- node 内容短且 embedding model 放得下时，可直接用 raw range 生成 embedding，不必生成摘要；
- 内容长、结构复杂、当前 topic 重要时，才由 AI 生成 abstractive summary；
- topic-specific summary 生命周期应短于 generic summary；
- projection 必须记录 `inputHash`、source hash、model/prompt version 和生成者。

Embedding 可以较全量覆盖 retrieval points，但优先级应是：

```text
L0 source summary
  -> L1/L2 parser nodes
  -> selected deeper nodes
  -> hot raw spans on demand
```

使用 turbovec 等压缩向量时，可考虑对所有 stable retrieval points 存 compressed embedding；但 raw content 仍从 source 文件读取。

### Space comparison intuition

传统 raw chunk RAG 常见布局：

```text
source file + raw chunk copies + float32 embeddings + metadata
```

Progressive Semantic Index 推荐布局：

```text
source file + location refs + semantic tree + optional projection + compressed embeddings
```

这会显著降低存储放大，并避免 chunk 原文与权威文件不一致。长期事实仍由 SolidFS/文件系统负责，索引层全部可删除、可重建、可按 hash/version 判定 stale。


## Product-generated evaluation dataset

Progressive Semantic Index 的 benchmark dataset 不应只靠研发手工维护。它应该从真实用户对主理人/Agent 的需求中持续沉淀：

```text
conversation
  -> user need detection
  -> sample extraction
  -> evidence/reference capture
  -> evaluation dataset
  -> benchmark/regression/dashboard
  -> retrieval/index/ranking optimization
```

目标是让产品自己识别哪些 retrieval 场景最重要，并持续在这些指标上优化，而不是只追通用 IR/MTEB/QLever benchmark。

### User need mining

从会话、任务、Run 结果中抽取用户真实需求：

```ts
interface UserNeed {
  id: string;
  sourceConversation: string;
  sourceMessages: string[];
  needType:
    | 'find-file'
    | 'explain-code'
    | 'debug-issue'
    | 'summarize-doc'
    | 'trace-decision'
    | 'modify-feature'
    | 'compare-options'
    | 'retrieve-history';
  question: string;
  implicitContext: string[];
  successCriteria?: string[];
}
```

高价值入口：

- 用户问“在哪里 / 为什么 / 刚才说的那个 / 这个逻辑谁负责”；
- Agent 成功完成代码或文档修改，且验证通过；
- 用户纠正“不是这个文件 / 不是这个意思 / 应该看某文档”；
- 用户追加提示后才找到答案，形成 hard sample；
- 用户或团队显式 pin 正确证据、关键文件、失败检索。

### Retrieval samples

用户需求会被转成可评估的 retrieval sample：

```ts
interface RetrievalSample {
  id: string;
  need: string;
  workspace: string;
  query: string;
  threadContext: string[];
  expectedEvidence?: EvidenceRef[];
  expectedSources?: string[];
  expectedNodes?: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  confidence: 'auto' | 'human-confirmed';
}

interface EvidenceRef {
  source: string;
  startLine?: number;
  endLine?: number;
  node?: string;
  reason: string;
  confidence: 'auto' | 'human-confirmed';
}
```

Expected evidence 可以来自：

- 成功回答中引用的文件/行；
- 成功代码修改的 changed/touched files；
- 测试通过的修复路径；
- 用户确认或 pin 的证据；
- 失败后用户给出的纠正线索。

### Evaluation results

每次 retrieval strategy 对 sample 的运行结果应进入 evaluation result：

```ts
interface EvaluationResult {
  sample: string;
  strategy: string;
  sourceRecallAtK: Record<number, number>;
  nodeRecallAtK: Record<number, number>;
  evidenceRecallAtK: Record<number, number>;
  mrr: number;
  coverageHonest: boolean;
  cost: {
    parsedFiles: number;
    parsedNodes: number;
    embeddedPoints: number;
    returnedTokens: number;
    latencyMs: number;
  };
  userCorrection?: boolean;
  expandedSuccessfully?: boolean;
}
```

### Dataset scope and privacy

Dataset 必须跟随 workspace / Pod / team 权限，不默认上传裸原文：

- sample 引用 source id、node id、line range、hash 和摘要；
- 原文仍留在 SolidFS / local filesystem / object storage；
- local workspace 的 dataset 默认本地保存；
- cloud/team dataset 遵守 workspace/team ACL；
- 用户必须能删除样本、证据引用和 derived summaries；
- 脱敏/跨团队聚合只能使用 opt-in 的匿名统计。

### Product optimization loop

该 dataset 反过来驱动：

- L0 source summary 是否有效；
- parser 层级是否足够；
- retrieval point selection 是否正确；
- ranking 是否把正确文件/节点排前；
- coverage 是否诚实；
- 哪些 source/node 应长期 hot；
- 哪些 parser/backend/adapter 值得优化；
- Semble/CodeGraph/rg/raw-chunk embedding 等 baseline 是否优于当前策略。

建议主指标：

```text
Successful Evidence Retrieval Rate
= 在预算内找到用户需求所需证据，并明确暴露 coverage 的比例
```

辅指标：

- `Source Recall@5`；
- `Evidence Recall@10`；
- `MRR`；
- `Cost per successful sample`；
- `User correction rate`；
- `Expand success rate`；
- `Regression count`；
- `Coverage honesty rate`。

### Product surfaces

Product-generated dataset 应成为用户和团队可观察的产品能力：

- dashboard 展示 failing needs、hard samples、recall trend、cost trend；
- Agent run report 展示本次 retrieval 是否命中历史 golden samples；
- regression gate 在 parser/index/ranking 变更后自动跑 team/workspace golden cases；
- 用户可 pin / unpin / correct evidence；
- 系统可从失败样本建议扩展 parser、补摘要、提高 index level 或更换 retrieval strategy。


## Stable source identity and locator relations

Base-relative id 只能解决 Pod/base 迁移，不能解决同一个 workspace 内任意文件夹移动。若把 source 或 retrieval point 的长期 identity 直接建在 relative path 上：

```text
docs/old/a.md#node-x
```

那么移动 `docs/old/ -> docs/new/` 仍会导致所有 path-derived subject/object 需要改写。因此任意文件夹移动必须使用 inode-like stable source identity，并把 URI/path 作为可变 locator relation。

### Correct boundary

```text
stable source identity:
  sourceId / source inode
  parser nodes
  retrieval points
  embeddings
  entity mentions
  parser cache

mutable locator relation:
  currentUri
  currentPath
  previousUri / alias
  prefix rewrite rule
```

内部 join 使用 `sourceId` / retrieval point id；外部过滤、权限和展示仍使用 full URI/current locator。

### URI filtering still works

查询层接受 full IRI / URI prefix：

```text
full URI / prefix
  -> locator resolver
  -> sourceId set
  -> join parser/retrieval/vector/entity indexes
```

例如：

```text
https://pod/alice/docs/new/
  -> source_locators WHERE currentUri STARTS WITH prefix
  -> sourceIds
  -> retrieval points / embeddings
```

所以 stable source identity 不是取消 URI 过滤，而是把 URI 过滤变成 locator resolution 的第一步。

### Two-phase move handling

文件夹移动应分两阶段：

```text
Phase 1: lightweight locator update
  - update source currentUri/currentPath, or record prefix rewrite rule
  - keep sourceId stable
  - keep parser nodes / retrieval points / embeddings unchanged
  - URI filters resolve through current locator graph immediately

Phase 2: URI-derived catch-up
  - refresh path-derived L0 summaries
  - refresh FTS path tokens / display cache / breadcrumbs
  - refresh graph/source prefix materialization
  - refresh RDF graph facts if graph URI follows locator
  - compact previous locator / rewrite rules
```

Phase 1 是 correctness path；Phase 2 是 derived cache catch-up。查询正确性不能依赖过期的 path-derived cache。

### Prefix rewrite optimization

大目录移动可以先记录 O(1) rewrite rule：

```ts
interface LocatorRewriteRule {
  workspace: string;
  fromPrefix: string;
  toPrefix: string;
  status: 'active' | 'compacting' | 'done';
  createdAt: string;
}
```

读取 current locator 时先应用 active rewrite rules，后台再批量 materialize 到 `source_locators` 并删除 rewrite rule。

### RDF content caveat

必须区分 locator URI 和用户 RDF 内容里的业务 IRI：

```text
locator move != RDF content IRI rewrite
```

对于 Xpod-owned index graph，sourceId/retrieval point 可以保持稳定；但如果 `.ttl` 内容里的 subject/object IRI 本身包含旧路径，移动文件不会自动改变这些 RDF term 的语义。若 named graph URI 跟文件 locator 绑定，则 graph projection 需要在 Phase 2 做 old graph delete / new graph insert；parser/vector/search artifact 可以通过 `sourceId + contentHash` 复用。
