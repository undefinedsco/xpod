/**
 * Task System - 基于消息路由的任务系统
 *
 * 核心思想：
 * - 任务系统是消息路由器，将消息发送给对应的 AI Agent 处理
 * - 不做策略封装，只提供工具和标准
 * - AI 自己决策：用什么工具、做到什么程度
 * - 不做固化流程：AI 的使命是帮助用户，随着理解加深持续进化
 */

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * 任务
 *
 * 简化模型：消息 + Agent
 */
export interface Task {
  /** 任务 ID */
  id: string;

  /** 发给哪个 AI Agent */
  agent: string;

  /** 任务消息/上下文 */
  message: string;

  /** 任务状态 */
  status: TaskStatus;

  /** 创建时间 */
  createdAt: Date;

  /** 开始执行时间 */
  startedAt?: Date;

  /** 完成时间 */
  completedAt?: Date;

  /** 执行结果 */
  result?: unknown;

  /** 错误信息 */
  error?: string;
}

/**
 * 创建任务的输入
 */
export interface CreateTaskInput {
  /** 发给哪个 AI Agent */
  agent: string;

  /** 任务消息/上下文 */
  message: string;
}

/**
 * AI Agent 接口
 */
export interface Agent {
  /** Agent 名称 */
  readonly name: string;

  /** Agent 描述 */
  readonly description: string;

  /**
   * 执行任务
   * @param message 任务消息
   * @param context 执行上下文
   * @returns 执行结果
   */
  execute(message: string, context: AgentContext): Promise<AgentResult>;
}

/**
 * Agent 执行上下文
 */
export interface AgentContext {
  /** 任务 ID */
  taskId: string;

  /** Pod base URL */
  podBaseUrl: string;

  /** OAuth access token（用于 MCP 访问 Pod） */
  accessToken?: string;

  /** 获取认证 fetch（用于访问 Pod 资源） */
  getAuthenticatedFetch(): Promise<typeof fetch>;

  /** 更新任务状态 */
  updateStatus(status: TaskStatus): Promise<void>;

  /** 日志 */
  log: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * Agent 执行结果
 */
export interface AgentResult {
  /** 是否成功 */
  success: boolean;

  /** 结果数据 */
  data?: unknown;

  /** 错误信息 */
  error?: string;

  /** 使用统计 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    turns: number;
    durationMs: number;
  };
}

/**
 * 任务队列接口
 */
export interface TaskQueue {
  /**
   * 创建任务
   */
  createTask(input: CreateTaskInput): Promise<Task>;

  /**
   * 获取任务
   */
  getTask(taskId: string): Promise<Task | null>;

  /**
   * 获取任务列表
   */
  listTasks(options?: ListTasksOptions): Promise<Task[]>;

  /**
   * 更新任务状态
   */
  updateTaskStatus(taskId: string, status: TaskStatus, updates?: Partial<Task>): Promise<void>;

  /**
   * 删除任务
   */
  deleteTask(taskId: string): Promise<void>;

  /**
   * 获取队列统计
   */
  getStats(): Promise<TaskQueueStats>;
}

/**
 * 列表查询选项
 */
export interface ListTasksOptions {
  /** 任务状态过滤 */
  status?: TaskStatus;

  /** Agent 过滤 */
  agent?: string;

  /** 限制数量 */
  limit?: number;

  /** 偏移量 */
  offset?: number;

  /** 排序字段 */
  orderBy?: 'createdAt' | 'startedAt' | 'completedAt';

  /** 排序方向 */
  order?: 'asc' | 'desc';
}

/**
 * 队列统计
 */
export interface TaskQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
  byAgent: Record<string, number>;
}

/**
 * 任务执行器接口
 */
export interface TaskExecutor {
  /**
   * 注册 Agent
   */
  registerAgent(agent: Agent): void;

  /**
   * 启动执行器
   */
  start(): Promise<void>;

  /**
   * 停止执行器
   */
  stop(): Promise<void>;

  /**
   * 手动触发执行
   */
  trigger(taskId: string): Promise<void>;

  /**
   * 获取执行器状态
   */
  isRunning(): boolean;
}
