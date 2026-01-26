/**
 * Task Schema - Pod RDF 表定义
 *
 * 简化模型：消息 + Agent
 *
 * 任务系统只负责：
 * - 接收任务 (agent + message)
 * - 调度执行
 * - 记录状态
 *
 * 具体怎么处理、用什么工具、做到什么程度，全部由 Agent 自己决定。
 */

import { podTable, string, datetime, json } from '@undefineds.co/drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../vocab';

/**
 * 任务状态
 */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type TaskStatusType = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Task - 任务实例
 *
 * 存储位置: /tasks/{YYYY-MM-DD}.ttl (按天分片)
 *
 * RDF 示例:
 * <#task-abc123> a udfs:Task ;
 *     udfs:agent "indexing" ;
 *     udfs:message "用户在 </docs/> 上传了文件 </docs/report.pdf>" ;
 *     udfs:status "pending" ;
 *     udfs:createdAt "2026-01-09T10:00:00Z"^^xsd:dateTime .
 */
export const Task = podTable(
  'Task',
  {
    id: string('id').primaryKey(),
    agent: string('agent'),
    message: string('message'),
    status: string('status'),
    createdAt: datetime('createdAt'),
    startedAt: datetime('startedAt'),
    completedAt: datetime('completedAt'),
    result: json('result'),
    error: string('error'),
  },
  {
    base: '/tasks/',
    type: UDFS.Task,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);

/**
 * 获取今天的任务文件路径
 */
export function getTodayTaskPath(): string {
  const today = new Date().toISOString().split('T')[0];
  return `/tasks/${today}.ttl`;
}

/**
 * 获取指定日期的任务文件路径
 */
export function getTaskPathForDate(date: Date): string {
  const dateStr = date.toISOString().split('T')[0];
  return `/tasks/${dateStr}.ttl`;
}

