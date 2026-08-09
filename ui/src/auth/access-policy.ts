export type AccessRequirement = 'public' | 'local-host' | 'account' | 'webid';

const localSettingsSubjects = new Set(['storage', 'runtime', 'cloud', 'advanced']);
const podSettingsSubjects = new Set(['pod', 'identity-access']);

export function accessRequirementForPathname(pathname: string): AccessRequirement {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/status' || normalized.startsWith('/status/')) return 'account';
  if (normalized === '/dashboard' || normalized.startsWith('/dashboard/')) return 'account';
  if (normalized === '/network' || normalized.startsWith('/network/')) return 'local-host';
  if (normalized === '/ai-config' || normalized.startsWith('/ai-config/')) return 'webid';
  if (normalized === '/ai-connections' || normalized.startsWith('/ai-connections/')) return 'webid';

  const settingsSegments = normalized.match(/^\/settings\/(.+)$/)?.[1]?.split('/');
  const settingsSubject = settingsSegments?.[0] === 'system' ? settingsSegments[1] : settingsSegments?.[0];
  if (settingsSubject && localSettingsSubjects.has(settingsSubject)) return 'local-host';
  if (settingsSubject && podSettingsSubjects.has(settingsSubject)) return 'webid';
  if (settingsSubject === 'network' || settingsSubject === 'services') return 'local-host';
  if (settingsSubject === 'models' || settingsSubject === 'ai-config') return 'webid';
  return 'public';
}
