# PushdownSparqlDataAccessor 详细设计文档

## 1. 概述

### 1.1 背景

当前 xpod 使用 `quadstore + quadstore-comunica` 执行 SPARQL 查询，存在严重性能问题：

```
实际场景：查询 3 条消息，扫描了 18,367 条记录
```

**根本原因**：
- Comunica 不下推条件 - FILTER、ORDER BY、LIMIT 在 JS 内存层处理
- 全表扫描 - 默认图查询会扫描所有 graph

**核心发现**：quadstore 底层已支持 Range 查询、LIMIT、ORDER BY、6 组索引，但 Comunica 没有利用这些能力。

### 1.2 目标

1. **性能优化**：减少扫描行数，利用 quadstore 的索引能力
2. **渐进式支持**：支持的查询模式下推执行，不支持的优雅回退到 Comunica
3. **接口兼容**：保持与 CSS DataAccessor 接口完全兼容
4. **正确性保证**：任何情况下都保证查询结果正确

### 1.3 Phase 1 范围

- 单个 BGP（一个三元组模式）
- FILTER：数值/日期范围比较 (`>`, `<`, `>=`, `<=`, `=`, `!=`)
- ORDER BY + LIMIT 下推
- 不支持的查询回退到 Comunica

---

## 2. 整体架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PushdownSparqlDataAccessor                          │
│                                                                             │
│  ┌─────────────┐                                                            │
│  │   SPARQL    │                                                            │
│  │   String    │                                                            │
│  └──────┬──────┘                                                            │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────┐                                                            │
│  │  SparqlParser│  (sparqljs)                                               │
│  │   parse()   │                                                            │
│  └──────┬──────┘                                                            │
│         │ AST                                                               │
│         ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        QueryAnalyzer                                 │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │ PatternAnalyzer│  │FilterAnalyzer│  │ OrderAnalyzer│               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  └──────────────────────────┬──────────────────────────────────────────┘   │
│                             │ QueryPlan                                     │
│                             ▼                                               │
│                    ┌────────────────┐                                       │
│                    │ canPushdown?   │                                       │
│                    └───────┬────────┘                                       │
│                            │                                                │
│              ┌─────────────┴─────────────┐                                  │
│              │ YES                       │ NO                               │
│              ▼                           ▼                                  │
│  ┌───────────────────────┐    ┌───────────────────────┐                    │
│  │    IndexSelector      │    │   FallbackExecutor    │                    │
│  │  (选择最优索引)        │    │   (Comunica Engine)   │                    │
│  └───────────┬───────────┘    └───────────┬───────────┘                    │
│              │                            │                                 │
│              ▼                            │                                 │
│  ┌───────────────────────┐                │                                 │
│  │  PushdownExecutor     │                │                                 │
│  │  ┌─────────────────┐  │                │                                 │
│  │  │ PatternBuilder  │  │                │                                 │
│  │  │ (构建查询模式)   │  │                │                                 │
│  │  └─────────────────┘  │                │                                 │
│  │  ┌─────────────────┐  │                │                                 │
│  │  │ RangeBuilder    │  │                │                                 │
│  │  │ (构建Range条件) │  │                │                                 │
│  │  └─────────────────┘  │                │                                 │
│  │  ┌─────────────────┐  │                │                                 │
│  │  │ MemoryFilter    │  │                │                                 │
│  │  │ (内存过滤)      │  │                │                                 │
│  │  └─────────────────┘  │                │                                 │
│  └───────────┬───────────┘                │                                 │
│              │                            │                                 │
│              ▼                            ▼                                 │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                      quadstore.getStream()                            │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│              │                            │                                 │
│              └────────────┬───────────────┘                                 │
│                           ▼                                                 │
│                   ┌─────────────┐                                           │
│                   │   Result    │                                           │
│                   │  Bindings   │                                           │
│                   └─────────────┘                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
|------|------|------|------|
| **SparqlParser** | 解析 SPARQL 字符串为 AST | SPARQL string | sparqljs AST |
| **QueryAnalyzer** | 分析 AST，判断是否可下推 | AST | QueryPlan |
| **IndexSelector** | 根据查询模式选择最优索引 | QueryPlan | IndexChoice |
| **PushdownExecutor** | 构建 quadstore 查询并执行 | QueryPlan + IndexChoice | Bindings |
| **FallbackExecutor** | 使用 Comunica 执行查询 | SPARQL string | Bindings |

---

## 3. 数据结构定义

### 3.1 QueryPlan（查询计划）

```typescript
/**
 * 查询计划 - QueryAnalyzer 的输出
 */
interface QueryPlan {
  // ========== 下推决策 ==========
  /** 是否可以下推执行 */
  canPushdown: boolean;
  /** 不可下推的原因 */
  reason?: string;

  // ========== 查询模式 ==========
  /** SELECT 变量列表 */
  variables: string[];
  /** BGP 三元组模式（Phase 1 只支持单个） */
  triplePattern: TriplePattern | null;
  /** Graph 模式 */
  graphPattern: GraphPattern | null;

  // ========== 条件 ==========
  /** FILTER 条件列表 */
  filters: FilterCondition[];
  /** ORDER BY 条件 */
  orderBy: OrderByCondition | null;
  /** LIMIT */
  limit: number | null;
  /** OFFSET */
  offset: number | null;
}

/**
 * 三元组模式
 */
interface TriplePattern {
  subject: PatternTerm;
  predicate: PatternTerm;
  object: PatternTerm;
}

/**
 * 模式中的 Term（变量或固定值）
 */
interface PatternTerm {
  type: 'variable' | 'fixed';
  value: string;           // 变量名或 IRI/Literal 值
  termType?: string;       // 'NamedNode' | 'Literal'
  datatype?: string;       // Literal 的数据类型
}

/**
 * Graph 模式
 */
interface GraphPattern {
  type: 'fixed' | 'variable' | 'default';
  value?: string;          // Graph IRI 或变量名
}

/**
 * FILTER 条件
 */
interface FilterCondition {
  /** 过滤的变量名 */
  variable: string;
  /** 运算符 */
  operator: ComparisonOp | StringOp;
  /** 比较值 */
  value: {
    termType: 'Literal' | 'NamedNode';
    value: string;
    datatype?: string;
  };
  /** 是否可下推到 quadstore */
  canPushdown: boolean;
  /** 不可下推的原因 */
  pushdownReason?: string;
}

type ComparisonOp = '>' | '<' | '>=' | '<=' | '=' | '!=';
type StringOp = 'strstarts' | 'contains' | 'regex';

/**
 * ORDER BY 条件
 */
interface OrderByCondition {
  variable: string;
  descending: boolean;
}
```

### 3.2 IndexChoice（索引选择）

```typescript
/**
 * 索引选择结果
 */
interface IndexChoice {
  /** 选择的索引名称 */
  index: IndexName;
  /** 索引的字段顺序 */
  order: QuadPosition[];
  /** 选择此索引的原因 */
  reason: string;
  /** 预估的扫描效率（0-1，越高越好） */
  efficiency: number;
}

type IndexName = 'GSPO' | 'GPOS' | 'GOSP' | 'SPOG' | 'POSG' | 'OSPG';
type QuadPosition = 'graph' | 'subject' | 'predicate' | 'object';
```

### 3.3 QuadstoreQuery（quadstore 查询）

```typescript
/**
 * quadstore 查询模式
 */
interface QuadstorePattern {
  subject?: Term | RangePattern;
  predicate?: Term | RangePattern;
  object?: Term | RangePattern;
  graph?: Term | RangePattern;
}

/**
 * Range 查询模式
 */
interface RangePattern {
  termType: 'Range';
  gt?: Term;   // greater than
  gte?: Term;  // greater than or equal
  lt?: Term;   // less than
  lte?: Term;  // less than or equal
}

/**
 * quadstore 查询选项
 */
interface QuadstoreOptions {
  /** 排序字段 */
  order?: QuadPosition[];
  /** 是否倒序 */
  reverse?: boolean;
  /** 限制返回数量 */
  limit?: number;
}
```

### 3.4 ExecutionResult（执行结果）

```typescript
/**
 * 查询执行结果
 */
interface ExecutionResult {
  /** 结果绑定列表 */
  bindings: Binding[];
  /** 执行统计 */
  stats: ExecutionStats;
}

type Binding = Map<string, Term>;

/**
 * 执行统计
 */
interface ExecutionStats {
  /** 是否使用了下推 */
  pushdownUsed: boolean;
  /** 执行时间（毫秒） */
  executionTime: number;
  /** 扫描的 quad 数量 */
  scannedQuads: number;
  /** 在内存中过滤掉的数量 */
  filteredInMemory: number;
  /** 使用的索引 */
  indexUsed?: IndexName;
  /** 回退原因（如果回退） */
  fallbackReason?: string;
}
```

---

## 4. 模块详细设计

### 4.1 QueryAnalyzer

#### 4.1.1 职责

将 sparqljs AST 转换为 QueryPlan，判断查询是否可以下推。

#### 4.1.2 接口

```typescript
class QueryAnalyzer {
  /**
   * 分析 SPARQL AST，生成查询计划
   */
  analyze(ast: ParsedQuery): QueryPlan;

  /**
   * 分析 WHERE 子句中的模式
   */
  private analyzePatterns(patterns: Pattern[]): {
    triplePattern: TriplePattern | null;
    graphPattern: GraphPattern | null;
    filters: FilterCondition[];
    unsupportedPatterns: string[];
  };

  /**
   * 分析 FILTER 表达式
   */
  private analyzeFilter(expr: Expression): FilterCondition | null;

  /**
   * 分析 ORDER BY 子句
   */
  private analyzeOrderBy(order: Ordering[]): OrderByCondition | null;
}
```

#### 4.1.3 下推判断规则

| 查询特征 | 可下推 | 说明 |
|----------|--------|------|
| 单个 BGP | ✓ | Phase 1 核心支持 |
| 多个 BGP | ✗ | Phase 2 支持 join |
| OPTIONAL | ✗ | 回退到 Comunica |
| UNION | ✗ | 回退到 Comunica |
| MINUS | ✗ | 回退到 Comunica |
| SERVICE | ✗ | 回退到 Comunica |
| FILTER (>, <, >=, <=) | ✓ | Range 查询 |
| FILTER (=, !=) | ✓ | 精确匹配/排除 |
| FILTER (STRSTARTS) | ✓ | 转为 Range |
| FILTER (CONTAINS) | 部分 | 下推 BGP，内存过滤 |
| FILTER (REGEX) | 部分 | 下推 BGP，内存过滤 |
| ORDER BY (单变量) | ✓ | 如果变量在 quad 位置上 |
| ORDER BY (多变量) | ✗ | 回退到 Comunica |
| ORDER BY (表达式) | ✗ | 回退到 Comunica |
| LIMIT | ✓ | 直接下推 |
| OFFSET | ✓ | 与 LIMIT 组合 |

#### 4.1.4 FILTER 下推判断

```typescript
/**
 * 判断 FILTER 是否可下推
 */
private canPushdownFilter(filter: FilterCondition, triplePattern: TriplePattern): boolean {
  // 1. 变量必须在三元组模式中
  const varPosition = this.findVariablePosition(filter.variable, triplePattern);
  if (!varPosition) {
    return false; // 变量不在 BGP 中
  }

  // 2. 运算符必须支持 Range 查询
  if (!['>', '<', '>=', '<=', '=', 'strstarts'].includes(filter.operator)) {
    return false;
  }

  // 3. 值类型必须支持比较
  if (filter.value.termType === 'Literal') {
    const datatype = filter.value.datatype;
    const supportedTypes = [
      'http://www.w3.org/2001/XMLSchema#integer',
      'http://www.w3.org/2001/XMLSchema#decimal',
      'http://www.w3.org/2001/XMLSchema#double',
      'http://www.w3.org/2001/XMLSchema#dateTime',
      'http://www.w3.org/2001/XMLSchema#date',
      'http://www.w3.org/2001/XMLSchema#string',
    ];
    if (datatype && !supportedTypes.includes(datatype)) {
      return false;
    }
  }

  return true;
}
```

### 4.2 IndexSelector

#### 4.2.1 职责

根据查询计划选择最优的 quadstore 索引。

#### 4.2.2 quadstore 索引

| 索引 | 字段顺序 | 适用场景 |
|------|----------|----------|
| **GSPO** | Graph → Subject → Predicate → Object | 指定 graph + subject 查询 |
| **GPOS** | Graph → Predicate → Object → Subject | 指定 graph + predicate，按 object 排序 |
| **GOSP** | Graph → Object → Subject → Predicate | 指定 graph，按 object 查询 |
| **SPOG** | Subject → Predicate → Object → Graph | 跨 graph 按 subject 查询 |
| **POSG** | Predicate → Object → Subject → Graph | 跨 graph 按 predicate + object |
| **OSPG** | Object → Subject → Predicate → Graph | 跨 graph 按 object 查询 |

#### 4.2.3 接口

```typescript
class IndexSelector {
  /**
   * 选择最优索引
   */
  selectIndex(plan: QueryPlan): IndexChoice;

  /**
   * 计算索引的匹配分数
   */
  private calculateIndexScore(
    index: IndexName,
    plan: QueryPlan
  ): number;
}
```

#### 4.2.4 索引选择算法

```typescript
selectIndex(plan: QueryPlan): IndexChoice {
  const indexes: IndexName[] = ['GSPO', 'GPOS', 'GOSP', 'SPOG', 'POSG', 'OSPG'];
  const indexOrders: Record<IndexName, QuadPosition[]> = {
    'GSPO': ['graph', 'subject', 'predicate', 'object'],
    'GPOS': ['graph', 'predicate', 'object', 'subject'],
    'GOSP': ['graph', 'object', 'subject', 'predicate'],
    'SPOG': ['subject', 'predicate', 'object', 'graph'],
    'POSG': ['predicate', 'object', 'subject', 'graph'],
    'OSPG': ['object', 'subject', 'predicate', 'graph'],
  };

  let bestIndex: IndexName = 'SPOG';
  let bestScore = -1;
  let bestReason = '';

  for (const index of indexes) {
    const order = indexOrders[index];
    let score = 0;
    let prefixLength = 0;

    // 计算前缀匹配长度
    for (const pos of order) {
      if (this.hasFixedValue(plan, pos)) {
        prefixLength++;
        score += 10; // 固定值匹配得分
      } else if (this.hasRangeFilter(plan, pos)) {
        score += 5;  // Range 过滤得分
        break;       // Range 之后不能继续前缀匹配
      } else {
        break;
      }
    }

    // ORDER BY 加分
    if (plan.orderBy) {
      const orderPos = this.getVariablePosition(plan, plan.orderBy.variable);
      const orderIndex = order.indexOf(orderPos);
      if (orderIndex === prefixLength) {
        score += 8; // ORDER BY 字段紧跟在前缀之后
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestReason = `前缀匹配 ${prefixLength} 个字段`;
    }
  }

  return {
    index: bestIndex,
    order: indexOrders[bestIndex],
    reason: bestReason,
    efficiency: bestScore / 30, // 归一化
  };
}
```

### 4.3 PushdownExecutor

#### 4.3.1 职责

将 QueryPlan 转换为 quadstore API 调用并执行。

#### 4.3.2 接口

```typescript
class PushdownExecutor {
  constructor(private store: Quadstore);

  /**
   * 执行下推查询
   */
  async execute(plan: QueryPlan, indexChoice: IndexChoice): Promise<ExecutionResult>;

  /**
   * 构建 quadstore 查询模式
   */
  private buildPattern(plan: QueryPlan): QuadstorePattern;

  /**
   * 构建 Range 条件
   */
  private buildRange(filter: FilterCondition): RangePattern;

  /**
   * 构建查询选项
   */
  private buildOptions(plan: QueryPlan, indexChoice: IndexChoice): QuadstoreOptions;

  /**
   * 应用内存过滤器
   */
  private applyMemoryFilters(
    quad: Quad,
    filters: FilterCondition[],
    variableBindings: Map<string, QuadPosition>
  ): boolean;
}
```

#### 4.3.3 执行流程

```typescript
async execute(plan: QueryPlan, indexChoice: IndexChoice): Promise<ExecutionResult> {
  const startTime = Date.now();
  const results: Binding[] = [];
  let scannedQuads = 0;
  let filteredInMemory = 0;

  // 1. 构建查询模式和选项
  const pattern = this.buildPattern(plan);
  const options = this.buildOptions(plan, indexChoice);

  // 2. 执行 quadstore 查询
  const { iterator } = await this.store.getStream(pattern, options);

  // 3. 遍历结果
  for await (const quad of iterator) {
    scannedQuads++;

    // 4. 构建变量绑定
    const binding = this.buildBinding(quad, plan.triplePattern, plan.graphPattern);

    // 5. 应用内存过滤器（不可下推的 FILTER）
    const memoryFilters = plan.filters.filter(f => !f.canPushdown);
    if (memoryFilters.length > 0) {
      if (!this.applyMemoryFilters(binding, memoryFilters)) {
        filteredInMemory++;
        continue;
      }
    }

    results.push(binding);

    // 6. 检查 LIMIT
    if (plan.limit && results.length >= plan.limit + (plan.offset || 0)) {
      break;
    }
  }

  // 7. 应用 OFFSET
  const finalResults = plan.offset ? results.slice(plan.offset) : results;

  return {
    bindings: finalResults,
    stats: {
      pushdownUsed: true,
      executionTime: Date.now() - startTime,
      scannedQuads,
      filteredInMemory,
      indexUsed: indexChoice.index,
    },
  };
}
```

#### 4.3.4 Range 构建

```typescript
private buildRange(filter: FilterCondition): RangePattern {
  const term = this.buildTerm(filter.value);
  
  switch (filter.operator) {
    case '>':
      return { termType: 'Range', gt: term };
    case '>=':
      return { termType: 'Range', gte: term };
    case '<':
      return { termType: 'Range', lt: term };
    case '<=':
      return { termType: 'Range', lte: term };
    case 'strstarts':
      // STRSTARTS 转为前缀范围
      const prefix = filter.value.value;
      const boundary = '\uDBFF\uDFFF'; // quadstore boundary
      return {
        termType: 'Range',
        gte: literal(prefix),
        lt: literal(prefix + boundary),
      };
    default:
      throw new Error(`Unsupported operator for range: ${filter.operator}`);
  }
}
```

### 4.4 FallbackExecutor

#### 4.4.1 职责

当查询不可下推时，使用 Comunica 引擎执行。

#### 4.4.2 接口

```typescript
class FallbackExecutor {
  constructor(private engine: Engine);

  /**
   * 使用 Comunica 执行查询
   */
  async execute(query: string, reason: string): Promise<ExecutionResult>;
}
```

---

## 5. 类设计

### 5.1 PushdownSparqlDataAccessor

```typescript
/**
 * SPARQL 查询下推数据访问器
 * 
 * 通过将查询条件下推到 quadstore 层来优化查询性能。
 */
export class PushdownSparqlDataAccessor implements DataAccessor {
  // ========== 依赖 ==========
  private readonly store: Quadstore;
  private readonly engine: Engine;
  
  // ========== 组件 ==========
  private readonly parser: SparqlParser;
  private readonly analyzer: QueryAnalyzer;
  private readonly indexSelector: IndexSelector;
  private readonly pushdownExecutor: PushdownExecutor;
  private readonly fallbackExecutor: FallbackExecutor;
  
  // ========== 统计 ==========
  private readonly stats: PushdownStats;

  constructor(endpoint: string, identifierStrategy: IdentifierStrategy);

  // ========== DataAccessor 接口 ==========
  async canHandle(representation: Representation): Promise<void>;
  async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>>;
  async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata>;
  async getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata>;
  async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void>;
  async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata): Promise<void>;
  async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void>;
  async deleteResource(identifier: ResourceIdentifier): Promise<void>;

  // ========== SPARQL 查询接口 ==========
  async executeSparqlSelect(query: string): Promise<ExecutionResult>;
  async executeSparqlConstruct(query: string): Promise<Guarded<Readable>>;
  async executeSparqlAsk(query: string): Promise<boolean>;
  async executeSparqlUpdate(query: string): Promise<void>;

  // ========== 统计接口 ==========
  getStats(): PushdownStats;
  resetStats(): void;

  // ========== 生命周期 ==========
  async open(): Promise<void>;
  async close(): Promise<void>;
}
```

### 5.2 统计信息

```typescript
interface PushdownStats {
  /** 总查询数 */
  totalQueries: number;
  /** 下推执行的查询数 */
  pushdownQueries: number;
  /** 回退到 Comunica 的查询数 */
  fallbackQueries: number;
  /** 总扫描 quad 数 */
  totalScannedQuads: number;
  /** 总内存过滤数 */
  totalFilteredInMemory: number;
  /** 按索引统计使用次数 */
  indexUsage: Record<IndexName, number>;
}
```

---

## 6. 执行流程

### 6.1 SELECT 查询流程

```
executeSparqlSelect(query)
    │
    ▼
┌─────────────────┐
│ 1. 解析 SPARQL   │
│    parser.parse │
└────────┬────────┘
         │ AST
         ▼
┌─────────────────┐
│ 2. 分析查询      │
│ analyzer.analyze│
└────────┬────────┘
         │ QueryPlan
         ▼
┌─────────────────┐
│ 3. canPushdown? │
└────────┬────────┘
         │
    ┌────┴────┐
    │ YES     │ NO
    ▼         ▼
┌────────┐  ┌────────────┐
│ 4a.    │  │ 4b.        │
│ 选择   │  │ 回退执行    │
│ 索引   │  │ fallback   │
└───┬────┘  │ Executor   │
    │       │ .execute() │
    ▼       └─────┬──────┘
┌────────┐        │
│ 5a.    │        │
│ 下推   │        │
│ 执行   │        │
│ push   │        │
│ down   │        │
│ Exec   │        │
│ .exec  │        │
└───┬────┘        │
    │             │
    └──────┬──────┘
           ▼
    ┌─────────────┐
    │ 6. 返回结果  │
    │ Execution   │
    │ Result      │
    └─────────────┘
```

### 6.2 下推执行详细流程

```
pushdownExecutor.execute(plan, indexChoice)
    │
    ▼
┌─────────────────────────────────┐
│ 1. buildPattern(plan)          │
│    - 固定值 → Term              │
│    - 可下推 FILTER → Range      │
│    - 变量 → undefined           │
└────────────────┬────────────────┘
                 │ QuadstorePattern
                 ▼
┌─────────────────────────────────┐
│ 2. buildOptions(plan, index)   │
│    - order: 根据 ORDER BY       │
│    - reverse: DESC → true       │
│    - limit: LIMIT + OFFSET      │
└────────────────┬────────────────┘
                 │ QuadstoreOptions
                 ▼
┌─────────────────────────────────┐
│ 3. store.getStream(pattern,    │
│                    options)     │
└────────────────┬────────────────┘
                 │ AsyncIterator<Quad>
                 ▼
┌─────────────────────────────────┐
│ 4. for await (quad of iterator)│
│    │                            │
│    ├─► buildBinding(quad)       │
│    │                            │
│    ├─► applyMemoryFilters()     │
│    │   (不可下推的 FILTER)       │
│    │                            │
│    ├─► 检查 LIMIT               │
│    │                            │
│    └─► results.push(binding)    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 5. 应用 OFFSET                  │
│    results.slice(offset)        │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 6. 返回 ExecutionResult         │
└─────────────────────────────────┘
```

---

## 7. 文件结构

```
src/storage/accessors/
├── PushdownSparqlDataAccessor.ts      # 主入口
├── pushdown/
│   ├── index.ts                       # 导出
│   ├── types.ts                       # 类型定义
│   ├── QueryAnalyzer.ts               # 查询分析器
│   ├── IndexSelector.ts               # 索引选择器
│   ├── PushdownExecutor.ts            # 下推执行器
│   ├── FallbackExecutor.ts            # 回退执行器
│   └── utils/
│       ├── RangeBuilder.ts            # Range 构建工具
│       ├── PatternBuilder.ts          # Pattern 构建工具
│       └── MemoryFilter.ts            # 内存过滤工具

tests/storage/accessors/
├── PushdownSparqlDataAccessor.test.ts # 集成测试
├── pushdown/
│   ├── QueryAnalyzer.test.ts          # 分析器单元测试
│   ├── IndexSelector.test.ts          # 索引选择单元测试
│   ├── PushdownExecutor.test.ts       # 执行器单元测试
│   └── utils/
│       └── RangeBuilder.test.ts       # 工具单元测试
```

---

## 8. 测试策略

### 8.1 单元测试

| 模块 | 测试内容 |
|------|----------|
| QueryAnalyzer | AST 分析、下推判断、FILTER 解析 |
| IndexSelector | 索引选择算法、分数计算 |
| PushdownExecutor | Pattern 构建、Range 构建、内存过滤 |
| RangeBuilder | 各种 FILTER 的 Range 转换 |

### 8.2 集成测试

| 测试场景 | 说明 |
|----------|------|
| 简单 SELECT + LIMIT | 验证基本下推 |
| FILTER 范围查询 | 验证 Range 下推 |
| ORDER BY + LIMIT | 验证排序下推 |
| 不支持的模式回退 | 验证 OPTIONAL/UNION 回退 |
| 结果正确性 | 对比 Comunica 结果 |

### 8.3 性能测试

| 指标 | 说明 |
|------|------|
| 扫描行数对比 | 下推 vs Comunica |
| 执行时间对比 | 下推 vs Comunica |
| 不同数据量下的性能 | 100/1000/10000 条 |

### 8.4 W3C 合规测试

使用 `third_party/w3c-rdf-tests/sparql/sparql11/` 测试套件，记录通过率。

---

## 9. 实现计划

### Phase 1（2-3 天）

1. [ ] 定义类型和接口 (`types.ts`)
2. [ ] 实现 QueryAnalyzer
3. [ ] 实现 IndexSelector
4. [ ] 实现 PushdownExecutor（基础版）
5. [ ] 实现 FallbackExecutor
6. [ ] 集成到 PushdownSparqlDataAccessor
7. [ ] 单元测试和集成测试

### Phase 2（后续）

1. [ ] 多 BGP join 支持
2. [ ] STRSTARTS 前缀优化
3. [ ] Graph 前缀 Range（需扩展 quadstore）

---

## 10. 风险与注意事项

1. **正确性优先**：任何不确定的情况都回退到 Comunica
2. **Range 边界**：使用 quadstore 的 boundary（`\uDBFF\uDFFF`）
3. **默认图语义**：保持 union of named graphs 语义
4. **类型安全**：所有类型转换需要验证
5. **内存控制**：大结果集需要流式处理
