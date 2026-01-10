# IndexAgent 规范

## 职责

IndexAgent 负责文档索引，帮助用户的文件变得可检索。

## 触发消息

```
用户在 </docs/> 上传了文件 </docs/report.pdf>
用户收藏了文件 </docs/report.pdf>
用户请求深度索引文件 </docs/report.pdf>
用户在对话中提及了文件 </docs/report.pdf>
定时检查：文件 </docs/report.pdf> 未被索引
```

## 任务上下文

AI 决策时可获取的上下文：

| 上下文 | 查询方式 | 决策影响 |
|--------|---------|---------|
| Subject 索引状态 | 读取 `.meta` 中的 `udfs:indexLevel` | 判断已做到什么程度 |
| 是否收藏 | LDP 查询收藏列表 | 收藏的值得更深处理 |
| 最近访问/提及 | LDP 查询访问记录 | 活跃的优先处理 |
| 文件类型 | 读取 Content-Type | 决定用什么工具 |
| 文件大小 | 读取 Content-Length | 小文件可能不需要分块 |
| 是否有缓存 | 读取 `.meta` 中的 `udfs:cachedMarkdown` | 有缓存则跳过 parse |

## 可用工具

### JINA MCP Server

JINA 提供官方 MCP 服务器（`jina-ai/MCP`），Claude Agent 可以直接使用：

| 工具 | 说明 | 调用方式 |
|------|------|---------|
| **Reader** | 将 URL 转换为 LLM 友好的 Markdown | `https://r.jina.ai/{url}` |
| **Search** | 网络搜索，返回结构化结果 | `https://s.jina.ai/{query}` |

- **配置**：在 Claude Agent 的 MCP 配置中添加 JINA MCP Server
- **API Key**：从 Pod 的 `/.credentials/jina` 读取
- **成本**：中（远程 API 调用）

### LDP 接口

- **用途**：查询/写入 Pod 数据
- **能力**：读写文件、读写 `.meta`、查询收藏/访问记录
- **成本**：低

### 文本分块

AI 可以选择合适的方式进行分块：

**Python (langchain-text-splitters)**：
```python
from langchain_text_splitters import MarkdownHeaderTextSplitter

headers_to_split_on = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3"),
]
splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers_to_split_on)
chunks = splitter.split_text(markdown_content)
```

- **成本**：低（本地执行）
- **说明**：AI 可以写 Python 代码执行分块，不限于特定库

### Embedding API

- **用途**：生成向量
- **调用**：通过 Pod 的 EmbeddingService
- **成本**：中（取决于 chunk 数量）

## 索引层级标准

### L0 - 摘要

| 项目 | 说明 |
|------|------|
| 内容 | 文件 summary/describe |
| 来源 | 从周边上下文获取，或根据文件名/类型生成 |
| 成本 | 最低 |
| 产物 | 描述文本 + embedding |

### L1 - 目录

| 项目 | 说明 |
|------|------|
| 内容 | 只看目录结构，生成主要标题的描述 |
| 来源 | PDF/Word：lib 提取 TOC；Markdown：扫描标题行 |
| 成本 | 低 |
| 产物 | 主要标题 chunks + embeddings |
| 注意 | 无 TOC 则跳过 |

### L2 - 全文

| 项目 | 说明 |
|------|------|
| 内容 | 全文分块（所有标题层级） |
| 前置 | 需要完整 parse |
| 成本 | 高 |
| 产物 | 所有 chunks + embeddings |

## Subject 状态存储

### 位置

资源的 `.meta` 辅助资源。

### 状态字段

```turtle
</docs/report.pdf> 
    udfs:indexLevel "L1" ;                    # 当前层级
    udfs:lastIndexedAt "2026-01-09T10:00:00Z"^^xsd:dateTime ;
    udfs:cachedMarkdown </docs/report.pdf.md> .  # parse 缓存位置
```

### Chunk 存储

**边关系结构**（不是嵌套 JSON）：

```turtle
# 文档 → chunk 边关系
</docs/report.pdf> udfs:hasChunk </docs/report.pdf#chunk-1> .
</docs/report.pdf> udfs:hasChunk </docs/report.pdf#chunk-2> .

# chunk → chunk 边关系（父子）
</docs/report.pdf#chunk-2> udfs:parentChunk </docs/report.pdf#chunk-1> .

# chunk 实体（独立内联）
</docs/report.pdf#chunk-1> a udfs:TextChunk ;
    udfs:level 1 ;
    udfs:heading "Introduction" ;
    udfs:startOffset 0 ;
    udfs:endOffset 256 ;
    udfs:vectorId 12345 .
```

## ROI 决策

AI 根据上下文平衡用户 ROI：

| 场景 | 建议层级 | 理由 |
|------|---------|------|
| 新上传的普通文件 | L0 | 成本低，覆盖基础检索 |
| 用户收藏的文件 | L2 | 用户明确关注，值得投入 |
| 用户主动请求 | L2 | 用户明确需要 |
| 对话中提及 | L1 或 L2 | 根据问题复杂度判断 |
| 后台定时扫描 | L0 | 批量处理，控制成本 |
| 小文件（< 1KB） | L0 | 内容少，不需要分块 |

## 渐进式处理

### 流程

1. 读取 Subject 状态 → 获取当前 `indexLevel`
2. 根据上下文决定目标层级
3. 如果目标 > 当前，执行增量处理
4. 更新 Subject 状态

### 缓存复用

- L1 → L2：如果已有 parse 缓存，直接用，不再调用 JINA
- 已有的 chunks 不重复生成 embedding

## 错误处理

| 错误 | 处理 |
|------|------|
| JINA API 失败 | 记录错误，任务失败，可重试 |
| 文件不存在 | 记录错误，任务失败 |
| 无法提取 TOC | 跳过 L1，用 L0 或尝试 L2 |
| Embedding 失败 | 记录错误，任务失败，可重试 |
