import { describe, expect, it } from 'vitest';
import { formatNetworkDiagnosticReport } from './network-diagnostic-report';

describe('formatNetworkDiagnosticReport', () => {
  it('exports timestamped structured diagnostic evidence without configuration secrets', () => {
    expect(formatNetworkDiagnosticReport({
      generatedAt: '2026-08-09T12:00:00.000Z',
      endpoint: 'https://xpod.example/',
      checks: [
        { id: 'dns', label: 'DNS resolution', status: 'ok', detail: '203.0.113.8' },
        { id: 'tls', label: 'TLS handshake', status: 'warning', detail: 'certificate expires soon' },
      ],
    })).toBe([
      'Xpod Network Diagnostics',
      'Generated: 2026-08-09T12:00:00.000Z',
      'Canonical URL: https://xpod.example/',
      '',
      '[OK] DNS resolution',
      '203.0.113.8',
      '',
      '[WARNING] TLS handshake',
      'certificate expires soon',
    ].join('\n'));
  });
});
