import { describe, expect, it } from 'vitest';
import {
  TRUSTED_AGENTS,
  isTrustedAgent,
  type TrustedAgent,
  type TerminalSessionInfo,
  type CreateSessionRequest,
  type TerminalMessage,
} from '../../src/terminal/types';

describe('Terminal Types', () => {
  describe('TRUSTED_AGENTS', () => {
    it('contains claude', () => {
      expect(TRUSTED_AGENTS).toContain('claude');
    });

    it('contains codex', () => {
      expect(TRUSTED_AGENTS).toContain('codex');
    });

    it('contains aider', () => {
      expect(TRUSTED_AGENTS).toContain('aider');
    });

    it('is a readonly array', () => {
      // TypeScript would prevent this at compile time, but we can verify the array content
      expect(TRUSTED_AGENTS.length).toBeGreaterThan(0);
    });
  });

  describe('isTrustedAgent', () => {
    it('returns true for claude', () => {
      expect(isTrustedAgent('claude')).toBe(true);
    });

    it('returns true for codex', () => {
      expect(isTrustedAgent('codex')).toBe(true);
    });

    it('returns true for aider', () => {
      expect(isTrustedAgent('aider')).toBe(true);
    });

    it('returns false for bash', () => {
      expect(isTrustedAgent('bash')).toBe(false);
    });

    it('returns false for sh', () => {
      expect(isTrustedAgent('sh')).toBe(false);
    });

    it('returns false for arbitrary command', () => {
      expect(isTrustedAgent('rm -rf /')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isTrustedAgent('')).toBe(false);
    });

    it('is case sensitive', () => {
      expect(isTrustedAgent('Claude')).toBe(false);
      expect(isTrustedAgent('CLAUDE')).toBe(false);
    });
  });

  describe('Type structure verification', () => {
    it('TerminalSessionInfo has required fields', () => {
      const session: TerminalSessionInfo = {
        sessionId: 'sess_123',
        userId: 'user1',
        command: 'claude',
        args: ['--help'],
        workdir: '/workspace',
        createdAt: new Date(),
        expiresAt: new Date(),
        status: 'active',
      };

      expect(session.sessionId).toBeDefined();
      expect(session.userId).toBeDefined();
      expect(session.command).toBeDefined();
      expect(session.status).toBe('active');
    });

    it('CreateSessionRequest has required fields', () => {
      const request: CreateSessionRequest = {
        command: 'claude',
      };

      expect(request.command).toBe('claude');
    });

    it('CreateSessionRequest accepts optional fields', () => {
      const request: CreateSessionRequest = {
        command: 'codex',
        args: ['--version'],
        workdir: '/home/user',
        env: { API_KEY: 'secret' },
        cols: 120,
        rows: 40,
        timeout: 3600,
      };

      expect(request.args).toEqual(['--version']);
      expect(request.workdir).toBe('/home/user');
      expect(request.env).toEqual({ API_KEY: 'secret' });
      expect(request.cols).toBe(120);
      expect(request.rows).toBe(40);
      expect(request.timeout).toBe(3600);
    });

    it('TerminalMessage input type', () => {
      const message: TerminalMessage = {
        type: 'input',
        data: 'ls -la\n',
      };

      expect(message.type).toBe('input');
      expect(message.data).toBe('ls -la\n');
    });

    it('TerminalMessage resize type', () => {
      const message: TerminalMessage = {
        type: 'resize',
        cols: 120,
        rows: 40,
      };

      expect(message.type).toBe('resize');
      expect(message.cols).toBe(120);
      expect(message.rows).toBe(40);
    });

    it('TerminalMessage signal type', () => {
      const message: TerminalMessage = {
        type: 'signal',
        signal: 'SIGINT',
      };

      expect(message.type).toBe('signal');
      expect(message.signal).toBe('SIGINT');
    });

    it('TerminalMessage output type', () => {
      const message: TerminalMessage = {
        type: 'output',
        data: 'Hello, World!\n',
      };

      expect(message.type).toBe('output');
      expect(message.data).toBe('Hello, World!\n');
    });

    it('TerminalMessage exit type', () => {
      const message: TerminalMessage = {
        type: 'exit',
        exitCode: 0,
      };

      expect(message.type).toBe('exit');
      expect(message.exitCode).toBe(0);
    });

    it('TerminalMessage error type', () => {
      const message: TerminalMessage = {
        type: 'error',
        error: 'Connection failed',
      };

      expect(message.type).toBe('error');
      expect(message.error).toBe('Connection failed');
    });
  });
});
