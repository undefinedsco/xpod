/**
 * TaskScheduler - Cron 调度器
 *
 * 从 Pod 加载调度定义，使用 node-cron 在内存中执行
 * 调度定义存储在 /settings/schedules.ttl
 */

import { getLoggerFor } from 'global-logger-factory';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { eq } from 'drizzle-solid';
import type { SolidDatabase } from 'drizzle-solid';

import { scheduleTable, type TaskClassType } from './schema';
import type { Schedule, TaskQueue, TaskScheduler as ITaskScheduler } from './types';

export interface TaskSchedulerOptions {
  /**
   * Pod base URL
   */
  podBaseUrl: string;
  /**
   * 任务队列
   */
  taskQueue: TaskQueue;
  /**
   * drizzle-solid 数据库实例
   */
  db: SolidDatabase<{ schedule: typeof scheduleTable }>;
}

/**
 * Cron 调度器实现
 */
export class TaskSchedulerImpl implements ITaskScheduler {
  protected readonly logger = getLoggerFor(this);
  private readonly podBaseUrl: string;
  private readonly taskQueue: TaskQueue;
  private readonly db: SolidDatabase<{ schedule: typeof scheduleTable }>;

  private jobs = new Map<string, ScheduledTask>();
  private running = false;

  public constructor(options: TaskSchedulerOptions) {
    this.podBaseUrl = options.podBaseUrl.endsWith('/') ? options.podBaseUrl : `${options.podBaseUrl}/`;
    this.taskQueue = options.taskQueue;
    this.db = options.db;
  }

  /**
   * 启动调度器（加载所有启用的调度）
   */
  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('TaskScheduler is already running');
      return;
    }

    this.logger.info('Starting TaskScheduler...');

    try {
      // 从 Pod 加载所有启用的调度
      const schedules = await this.db
        .select()
        .from(scheduleTable)
        .where(eq(scheduleTable.enabled, true));

      for (const schedule of schedules) {
        this.scheduleJob(this.dbScheduleToSchedule(schedule as Record<string, unknown>));
      }

      this.running = true;
      this.logger.info(`TaskScheduler started with ${this.jobs.size} scheduled jobs`);
    } catch (error) {
      this.logger.error(`Failed to start TaskScheduler: ${error}`);
      throw error;
    }
  }

  /**
   * 停止调度器
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping TaskScheduler...');

    for (const [id, job] of this.jobs) {
      job.stop();
      this.logger.debug(`Stopped job ${id}`);
    }
    this.jobs.clear();

    this.running = false;
    this.logger.info('TaskScheduler stopped');
  }

  /**
   * 添加调度
   */
  public addSchedule(schedule: Schedule): void {
    if (!cron.validate(schedule.cron)) {
      throw new Error(`Invalid cron expression: ${schedule.cron}`);
    }

    // 如果已存在，先移除
    if (this.jobs.has(schedule.id)) {
      this.removeSchedule(schedule.id);
    }

    this.scheduleJob(schedule);
    this.logger.info(`Added schedule ${schedule.id} with cron ${schedule.cron}`);
  }

  /**
   * 移除调度
   */
  public removeSchedule(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
      this.logger.info(`Removed schedule ${scheduleId}`);
    }
  }

  /**
   * 获取调度器状态
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * 获取所有活跃的调度 ID
   */
  public getActiveScheduleIds(): string[] {
    return Array.from(this.jobs.keys());
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * 创建并启动 cron job
   */
  private scheduleJob(schedule: Schedule): void {
    const job = cron.schedule(schedule.cron, async () => {
      await this.executeSchedule(schedule);
    });

    this.jobs.set(schedule.id, job);
    this.logger.debug(`Scheduled job ${schedule.id} with cron ${schedule.cron}`);
  }

  /**
   * 执行调度（创建任务）
   */
  private async executeSchedule(schedule: Schedule): Promise<void> {
    this.logger.info(`Executing schedule ${schedule.id}: ${schedule.name}`);

    try {
      // 创建任务实例
      await this.taskQueue.createTask({
        '@type': schedule.taskClass,
        target: schedule.target ?? this.podBaseUrl,
        instruction: schedule.instruction,
        payload: schedule.payload ?? {},
        source: 'schedule',
        schedule: `${this.podBaseUrl}settings/schedules.ttl#${schedule.id}`,
      });

      // 更新 lastRunAt
      await this.db
        .update(scheduleTable)
        .set({
          lastRunAt: new Date(),
          modified: new Date(),
        })
        .where(eq(scheduleTable.id, schedule.id));

      this.logger.info(`Schedule ${schedule.id} executed successfully`);
    } catch (error) {
      this.logger.error(`Failed to execute schedule ${schedule.id}: ${error}`);
    }
  }

  /**
   * 将数据库记录转换为 Schedule 接口
   */
  private dbScheduleToSchedule(dbSchedule: Record<string, unknown>): Schedule {
    return {
      id: dbSchedule.id as string,
      name: (dbSchedule.name as string) ?? '',
      taskClass: (dbSchedule.taskClass as TaskClassType) ?? 'IndexTask',
      instruction: dbSchedule.instruction as string | undefined,
      cron: (dbSchedule.cron as string) ?? '0 0 * * *',
      target: dbSchedule.target as string | undefined,
      payload: dbSchedule.payload as Record<string, unknown> | undefined,
      enabled: (dbSchedule.enabled as boolean) ?? false,
      lastRunAt: dbSchedule.lastRunAt as Date | undefined,
      nextRunAt: dbSchedule.nextRunAt as Date | undefined,
      created: (dbSchedule.created as Date) ?? new Date(),
      modified: (dbSchedule.modified as Date) ?? new Date(),
    };
  }
}
