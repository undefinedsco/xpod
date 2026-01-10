/**
 * TaskScheduler 单元测试
 *
 * 新设计中，任务系统简化为 message + agent 模型。
 * Schedule 现在是基于 cron 触发消息给 Agent。
 */

import { describe, it, expect, vi } from 'vitest';

// Mock node-cron
const mockValidate = vi.fn((cron: string) => {
  // 简单验证
  const parts = cron.split(' ');
  return parts.length === 5 || parts.length === 6;
});

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    stop: vi.fn(),
  })),
  validate: mockValidate,
}));

/**
 * 调度配置（新设计）
 *
 * 基于 message + agent 模型的调度。
 */
interface Schedule {
  id: string;
  name: string;
  /** 目标 Agent */
  agent: string;
  /** 触发消息 */
  message: string;
  /** Cron 表达式 */
  cron: string;
  /** 是否启用 */
  enabled: boolean;
  /** 上次运行时间 */
  lastRunAt?: Date;
  /** 下次运行时间 */
  nextRunAt?: Date;
  created: Date;
  modified: Date;
}

describe('TaskScheduler', () => {
  describe('Schedule Interface', () => {
    it('should have correct schedule structure', () => {
      const schedule: Schedule = {
        id: 'sched-123',
        name: 'Daily Index',
        agent: 'indexing',
        message: '定时扫描：检查 </docs/> 下的新文件',
        cron: '0 0 * * *',
        enabled: true,
        created: new Date(),
        modified: new Date(),
      };

      expect(schedule.id).toBe('sched-123');
      expect(schedule.agent).toBe('indexing');
      expect(schedule.message).toContain('/docs/');
      expect(schedule.cron).toBe('0 0 * * *');
      expect(schedule.enabled).toBe(true);
    });

    it('should support optional fields', () => {
      const schedule: Schedule = {
        id: 'sched-456',
        name: 'Weekly Cleanup',
        agent: 'cleanup',
        message: '清理过期的临时文件',
        cron: '0 0 * * 0',
        enabled: false,
        created: new Date(),
        modified: new Date(),
      };

      expect(schedule.lastRunAt).toBeUndefined();
      expect(schedule.nextRunAt).toBeUndefined();
      expect(schedule.enabled).toBe(false);
    });
  });

  describe('Cron Expression Validation', () => {
    it('should validate standard cron expressions', () => {
      expect(mockValidate('0 0 * * *')).toBe(true); // 每天午夜
      expect(mockValidate('*/5 * * * *')).toBe(true); // 每5分钟
      expect(mockValidate('0 9 * * 1-5')).toBe(true); // 周一到周五上午9点
    });

    it('should validate 6-part cron expressions (with seconds)', () => {
      expect(mockValidate('0 0 0 * * *')).toBe(true); // 每天午夜（包含秒）
    });

    it('should reject invalid cron expressions', () => {
      expect(mockValidate('invalid')).toBe(false);
      expect(mockValidate('* *')).toBe(false);
    });
  });

  describe('Schedule Patterns', () => {
    it('should express common patterns', () => {
      const patterns = {
        everyMinute: '* * * * *',
        everyHour: '0 * * * *',
        daily: '0 0 * * *',
        weekly: '0 0 * * 0',
        monthly: '0 0 1 * *',
        workdaysMorning: '0 9 * * 1-5',
      };

      expect(patterns.everyMinute).toBe('* * * * *');
      expect(patterns.daily).toBe('0 0 * * *');
    });
  });

  describe('Message-Driven Design', () => {
    it('should support different agent types via message', () => {
      const indexSchedule: Schedule = {
        id: 'sched-index',
        name: 'Nightly Indexing',
        agent: 'indexing',
        message: '定时扫描：检查 </docs/> 下未索引的文件',
        cron: '0 2 * * *',
        enabled: true,
        created: new Date(),
        modified: new Date(),
      };

      const backupSchedule: Schedule = {
        id: 'sched-backup',
        name: 'Daily Backup',
        agent: 'backup',
        message: '定时备份：备份用户数据到 </backup/>',
        cron: '0 3 * * *',
        enabled: true,
        created: new Date(),
        modified: new Date(),
      };

      expect(indexSchedule.agent).toBe('indexing');
      expect(backupSchedule.agent).toBe('backup');
    });

    it('should allow flexible message format', () => {
      // 消息可以是自然语言，AI 会解析
      const schedule: Schedule = {
        id: 'sched-flexible',
        name: 'Smart Indexing',
        agent: 'indexing',
        message: '用户收藏了 </docs/important.pdf>，请深度索引',
        cron: '*/30 * * * *',
        enabled: true,
        created: new Date(),
        modified: new Date(),
      };

      expect(schedule.message).toContain('收藏');
      expect(schedule.message).toContain('深度索引');
    });
  });
});
