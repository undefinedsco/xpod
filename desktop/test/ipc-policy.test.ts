import { describe, expect, test } from 'bun:test';
import { isTrustedDesktopShellSender, isTrustedDesktopShellUrl } from '../src/ipc-policy';
const origin = 'http://127.0.0.1:5739';
describe('native host IPC policy', () => {
  test('allows reserved task, device and static shell entries', () => {
    for (const route of ['/tasks', '/tasks?task=123&tab=runs', '/pod/models', '/device/network', '/settings', '/static/app/index.html', '/static/app/auth.html', '/auth/callback?code=test']) {
      expect(isTrustedDesktopShellUrl(origin + route, origin)).toBe(true);
    }
  });
  test('rejects same-origin Pod HTML, API and account pages', () => {
    for (const route of ['/alice/untrusted.html', '/pod/untrusted.html', '/device/untrusted.html', '/tasks/untrusted.html', '/api/admin/status', '/.account/', '/.account/account/', '/tasks-imposter', '/tasks%2Falice.html', '/tasks/%252e%252e/alice/evil.html', '/static/app/evil.html']) {
      expect(isTrustedDesktopShellUrl(origin + route, origin)).toBe(false);
    }
    expect(isTrustedDesktopShellUrl('https://evil.example/tasks', origin)).toBe(false);
  });
  test('requires the current window and main frame; both document URLs must be trusted', () => {
    const input = { isCurrentWindow: true, isMainFrame: true, frameUrl: origin + '/tasks', committedUrl: origin + '/tasks', contentsUrl: origin + '/tasks' };
    expect(isTrustedDesktopShellSender(input, origin)).toBe(true);
    expect(isTrustedDesktopShellSender({ ...input, committedUrl: origin + '/pod/untrusted.html', frameUrl: origin + '/pod/untrusted.html', contentsUrl: origin + '/pod/untrusted.html' }, origin)).toBe(false);
    // Pod HTML cannot acquire host powers with history.pushState('/tasks').
    expect(isTrustedDesktopShellSender({ ...input, committedUrl: origin + '/alice/evil.html' }, origin)).toBe(false);
    expect(isTrustedDesktopShellSender({ ...input, isCurrentWindow: false }, origin)).toBe(false);
    expect(isTrustedDesktopShellSender({ ...input, isMainFrame: false }, origin)).toBe(false);
    expect(isTrustedDesktopShellSender({ ...input, frameUrl: origin + '/alice/evil.html' }, origin)).toBe(false);
    expect(isTrustedDesktopShellSender({ ...input, contentsUrl: origin + '/alice/evil.html' }, origin)).toBe(false);
  });
});
