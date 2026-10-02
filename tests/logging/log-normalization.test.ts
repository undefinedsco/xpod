import { afterEach, describe, expect, it, vi } from 'vitest';

import { Supervisor } from '../../src/supervisor/Supervisor';

afterEach(() => { vi.unstubAllEnvs(); });

describe('supervisor log facts', () => {
  it('normalizes CSS and Components logs before source/level filtering and redacts secrets', () => {
    const supervisor = new Supervisor({ handleProcessSignals: false });
    supervisor.addLog('css', 'info', '2026-10-02 12:00:00 [Store] \u001b[34mdebug\u001b[39m: apiKey=private-secret');
    supervisor.addLog('api', 'info', '2026-10-02T12:00:00.001Z [Components.js] \u001b[33mwarn\u001b[39m: check configuration');
    expect(supervisor.getLogs({ source: 'css', level: 'debug' })).toEqual([
      expect.objectContaining({ source: 'css', level: 'debug', message: '2026-10-02 12:00:00 [Store] debug: apiKey=***' }),
    ]);
    expect(supervisor.getLogs({ source: 'api', level: 'warn' })).toHaveLength(1);
    expect(supervisor.getLogs({ source: 'css', level: 'info' })).toEqual([]);
  });

  it('normalizes real child output in both the log buffer and retained crash tail', async () => {
    const supervisor = new Supervisor({ handleProcessSignals: false, maxRestarts: 0 });
    const line = '2026-10-02 12:00:00 [Api] \u001b[33mwarn\u001b[39m: token=private-token';
    supervisor.register({ name: 'api', command: process.execPath, args: ['-e', `console.log(${JSON.stringify(line)}); process.exit(1);`] });
    try {
      supervisor.start('api');
      const deadline = Date.now() + 10_000;
      while (supervisor.getStatus('api')?.status !== 'given-up' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(supervisor.getStatus('api')?.status).toBe('given-up');
      expect(supervisor.getLogs({ source: 'api', level: 'warn' })).toEqual([expect.objectContaining({
        source: 'api', level: 'warn', message: '2026-10-02 12:00:00 [Api] warn: token=***',
      })]);
      expect(supervisor.getStatus('api')?.lastOutput).toEqual(['2026-10-02 12:00:00 [Api] warn: token=***']);
    } finally {
      await supervisor.stopAll();
    }
  });

  it('does not infer source or level from ordinary message contents', () => {
    vi.stubEnv('XPOD_TEST_SECRET', 'opaque-secret-fixture');
    const supervisor = new Supervisor({ handleProcessSignals: false });
    supervisor.addLog('api', 'info', 'connection rejected opaque-secret-fixture');
    expect(supervisor.getLogs()[0].message).toBe('connection rejected [redacted:XPOD_TEST_SECRET]');
    supervisor.addLog('api', 'error', 'query text [CssStore] debug: not a log header');
    expect(supervisor.getLogs()[1]).toMatchObject({ source: 'api', level: 'error' });
  });
});
