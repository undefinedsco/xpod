import type { NetworkDiagnosticCheckResult } from '../../api/network-settings';

export function formatNetworkDiagnosticReport(input: {
  generatedAt: string;
  endpoint?: string;
  checks: NetworkDiagnosticCheckResult[];
}): string {
  const header = [
    'Xpod Network Diagnostics',
    `Generated: ${input.generatedAt}`,
    `Canonical URL: ${input.endpoint ?? 'Unavailable'}`,
  ];
  const checks = input.checks.flatMap((check) => [
    '',
    `[${check.status.toUpperCase()}] ${check.label}`,
    ...(check.detail ? [check.detail] : []),
  ]);
  return [...header, ...checks].join('\n');
}
