import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AccountPage account operation errors', () => {
  const source = readFileSync(resolve(process.cwd(), 'ui/src/pages/AccountPage.tsx'), 'utf8');

  it('uses inline account errors instead of native alerts', () => {
    expect(source).toContain('const [accountError, setAccountError]');
    expect(source).toContain("message === 'fetch failed'");
    expect(source).toContain("message.includes('Failed to fetch')");
    expect(source).toContain('无法加载账号信息，请检查网络后重试。');
    expect(source).toContain('{accountError && (');
    expect(source).toContain('无法创建存储空间');
    expect(source).toContain('请先创建存储空间，再创建客户端凭据');
    expect(source).not.toContain('Pod 信息正在同步');
    expect(source).toContain('本机存储尚未完成绑定');
    expect(source).toContain('handleRepairLocalBinding');
  });
});

describe('account UI source errors', () => {
  const sources = [
    'ui/src/pages/AccountPage.tsx',
    'ui/src/pages/WelcomePage.tsx',
    'ui/src/pages/ForgotPasswordPage.tsx',
    'ui/src/pages/ConsentPage.tsx',
    'ui/src/pages/FirstPodPage.tsx',
  ].map((path) => [path, readFileSync(resolve(process.cwd(), path), 'utf8')] as const);

  it('keeps account flow failures inline instead of using native alerts', () => {
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/\balert\s*\(/);
    }
  });
});

describe('account provisioning UI boundaries', () => {
  const sources = [
    'ui/src/pages/AccountPage.tsx',
    'ui/src/pages/ConsentPage.tsx',
    'ui/src/pages/FirstPodPage.tsx',
    'ui/src/components/FirstPodCreator.tsx',
    'ui/src/utils/consent-first-pod.ts',
    'ui/src/utils/provision-scope.ts',
    'ui/src/utils/registration-flow.ts',
    'ui/src/utils/storage-scope.ts',
  ].map((path) => [path, readFileSync(resolve(process.cwd(), path), 'utf8')] as const);

  it('does not call Local provider lookup endpoints from the browser', () => {
    for (const [path, source] of sources) {
      expect(source, path).not.toContain('lookupProvisionScopedWebIds');
      expect(source, path).not.toContain('/provision/webids');
      expect(source, path).not.toMatch(/new URL\(`?\/provision\/pods/);
    }
  });
});
