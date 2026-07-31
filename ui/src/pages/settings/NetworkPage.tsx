import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { Activity, Globe2, Network, RefreshCw, RotateCcw, ShieldCheck, Wifi } from 'lucide-react';
import {
  fetchNetworkSettingsStatus,
  renewNetworkCertificate,
  runNetworkDiagnostics,
  type NetworkDiagnosticCheckResult,
  type NetworkSettingsStatus,
} from '../../api/network-settings';
import { useXpodSolidRuntime } from '../../solid/useXpodSolidRuntime';

export default function NetworkPage() {
  const runtime = useXpodSolidRuntime();
  const [status, setStatus] = useState<NetworkSettingsStatus>();
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnosticCheckResult[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const requestIdRef = useRef(0);
  const diagnoseActionIdRef = useRef(0);
  const renewActionIdRef = useRef(0);
  const activeIdentityKeyRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const canLoad = runtime.state.status === 'authenticated' && Boolean(runtime.webId && runtime.podUrl);
  const identityKey = canLoad ? `${runtime.webId}\n${runtime.podUrl}` : undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      diagnoseActionIdRef.current += 1;
      renewActionIdRef.current += 1;
    };
  }, []);

  const isCurrentRequest = useCallback((requestId: number, requestIdentityKey: string) => (
    mountedRef.current
    && requestIdRef.current === requestId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const isCurrentDiagnoseAction = useCallback((actionId: number, requestIdentityKey: string) => (
    mountedRef.current
    && diagnoseActionIdRef.current === actionId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const isCurrentRenewAction = useCallback((actionId: number, requestIdentityKey: string) => (
    mountedRef.current
    && renewActionIdRef.current === actionId
    && activeIdentityKeyRef.current === requestIdentityKey
  ), []);

  const loadStatus = useCallback(async () => {
    const podUrl = runtime.podUrl;
    const requestIdentityKey = identityKey;
    if (!podUrl || !requestIdentityKey) {
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setError(undefined);
    try {
      const nextStatus = await fetchNetworkSettingsStatus({
        podUrl,
        authenticatedFetch: runtime.fetch,
      });
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setStatus(nextStatus);
      }
    } catch {
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setError('Network settings request failed. Please try again.');
      }
    } finally {
      if (isCurrentRequest(requestId, requestIdentityKey)) {
        setLoading(false);
      }
    }
  }, [identityKey, isCurrentRequest, runtime.fetch, runtime.podUrl]);

  useEffect(() => {
    activeIdentityKeyRef.current = identityKey;
    requestIdRef.current += 1;
    diagnoseActionIdRef.current += 1;
    renewActionIdRef.current += 1;
    setStatus(undefined);
    setDiagnostics([]);
    setError(undefined);
    setLoading(false);
    setDiagnosing(false);
    setRenewing(false);
    if (identityKey) {
      void loadStatus();
    }
  }, [identityKey, loadStatus]);

  const runDiagnose = useCallback(async () => {
    const podUrl = runtime.podUrl;
    const requestIdentityKey = identityKey;
    if (!podUrl || !requestIdentityKey) {
      return;
    }
    const actionId = diagnoseActionIdRef.current + 1;
    diagnoseActionIdRef.current = actionId;
    setDiagnosing(true);
    setError(undefined);
    try {
      const result = await runNetworkDiagnostics({
        podUrl,
        authenticatedFetch: runtime.fetch,
      });
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setDiagnostics(result.checks);
      }
    } catch {
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setError('Network diagnostics failed. Please try again.');
      }
    } finally {
      if (isCurrentDiagnoseAction(actionId, requestIdentityKey)) {
        setDiagnosing(false);
      }
    }
  }, [identityKey, isCurrentDiagnoseAction, runtime.fetch, runtime.podUrl]);

  const renewCertificate = useCallback(async () => {
    const podUrl = runtime.podUrl;
    const requestIdentityKey = identityKey;
    if (!podUrl || !requestIdentityKey) {
      return;
    }
    const actionId = renewActionIdRef.current + 1;
    renewActionIdRef.current = actionId;
    setRenewing(true);
    setError(undefined);
    try {
      await renewNetworkCertificate({
        podUrl,
        authenticatedFetch: runtime.fetch,
      });
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        await loadStatus();
      }
    } catch {
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        setError('Certificate renewal failed. Please try again.');
      }
    } finally {
      if (isCurrentRenewAction(actionId, requestIdentityKey)) {
        setRenewing(false);
      }
    }
  }, [identityKey, isCurrentRenewAction, loadStatus, runtime.fetch, runtime.podUrl]);

  const sections = useMemo(() => [
    { key: 'local', title: 'Local', values: status?.addresses.local ?? [] },
    { key: 'lan', title: 'LAN', values: status?.addresses.lan ?? [] },
    { key: 'public', title: 'Public', values: status?.addresses.public ?? [] },
  ], [status]);

  return (
    <TwoPaneLayout
      mode="auto"
      header={<NetworkHeader loading={loading} onRefresh={loadStatus} />}
      list={
        <aside className="flex h-full flex-col gap-3 border-r border-border bg-muted/30 p-4">
          <EndpointCard endpoint={status?.endpoint} loading={loading && !status} />
          <AddressCard sections={sections} loading={loading && !status} />
        </aside>
      }
      main={
        <section className="flex min-h-full flex-col gap-4 bg-background p-6">
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <CapabilityCard status={status} />
          <ActionsCard
            status={status}
            diagnostics={diagnostics}
            diagnosing={diagnosing}
            renewing={renewing}
            onDiagnose={runDiagnose}
            onRenewCertificate={renewCertificate}
          />
        </section>
      }
      className="min-h-full"
    />
  );
}

function NetworkHeader({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">Network</div>
        <div className="truncate text-xs text-muted-foreground">Endpoint, DNS, TLS, tunnel, and connectivity diagnostics</div>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
        Refresh
      </Button>
    </div>
  );
}

function EndpointCard({ endpoint, loading }: { endpoint?: string; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="h-4 w-4" aria-hidden="true" />
          Endpoint
        </CardTitle>
        <CardDescription>{loading ? 'Resolving endpoint' : 'Current reachable API origin'}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="break-words text-sm text-foreground">{endpoint || 'Unsupported'}</div>
      </CardContent>
    </Card>
  );
}

function AddressCard({
  sections,
  loading,
}: {
  sections: Array<{ key: string; title: string; values: string[] }>;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wifi className="h-4 w-4" aria-hidden="true" />
          Addresses
        </CardTitle>
        <CardDescription>{loading ? 'Refreshing addresses' : 'Reported by runtime network capability'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections.map((section) => (
          <div key={section.key}>
            <div className="text-xs font-medium text-muted-foreground">{section.title}</div>
            {section.values.length > 0 ? (
              <div className="mt-1 space-y-1">
                {section.values.map((value) => (
                  <div key={value} className="break-words text-sm text-foreground">{value}</div>
                ))}
              </div>
            ) : (
              <div className="mt-1 text-sm text-muted-foreground">Unsupported</div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CapabilityCard({ status }: { status?: NetworkSettingsStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4" aria-hidden="true" />
          Capabilities
        </CardTitle>
        <CardDescription>Server-declared network support</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <CapabilityRow label="TLS" capability={status?.tls} extra={status?.tls.expiresAt ? `Expires ${formatDateTime(status.tls.expiresAt)}` : undefined} />
        <CapabilityRow label="DNS" capability={status?.dns} />
        <CapabilityRow label="Tunnel" capability={status?.tunnel} />
      </CardContent>
    </Card>
  );
}

function ActionsCard({
  status,
  diagnostics,
  diagnosing,
  renewing,
  onDiagnose,
  onRenewCertificate,
}: {
  status?: NetworkSettingsStatus;
  diagnostics: NetworkDiagnosticCheckResult[];
  diagnosing: boolean;
  renewing: boolean;
  onDiagnose: () => void;
  onRenewCertificate: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" aria-hidden="true" />
          Actions
        </CardTitle>
        <CardDescription>Only actions allowed by the Network capability are shown</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {status?.actions.diagnose ? (
            <Button type="button" size="sm" variant="outline" onClick={onDiagnose} disabled={diagnosing}>
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              Diagnose
            </Button>
          ) : null}
          {status?.actions.renewCertificate ? (
            <Button type="button" size="sm" variant="subtle" onClick={onRenewCertificate} disabled={renewing}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Renew certificate
            </Button>
          ) : null}
        </div>
        {diagnostics.length > 0 ? (
          <div className="space-y-2">
            {diagnostics.map((check) => (
              <div key={check.id} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{check.label}</div>
                  <Badge variant={check.status === 'ok' ? 'secondary' : 'outline'}>{check.status}</Badge>
                </div>
                {check.detail ? <div className="mt-1 break-words text-xs text-muted-foreground">{check.detail}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No diagnostics run yet.</div>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityRow({
  label,
  capability,
  extra,
}: {
  label: string;
  capability?: { supported: boolean; status: string };
  extra?: string;
}) {
  const supported = capability?.supported === true;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">{supported ? label : `${label} unsupported`}</div>
          <div className="text-xs text-muted-foreground">{capability?.status ?? 'loading'}</div>
        </div>
        <Badge variant={supported ? 'secondary' : 'outline'}>{supported ? 'Supported' : 'Unsupported'}</Badge>
      </div>
      {extra ? <div className="mt-2 text-xs text-muted-foreground">{extra}</div> : null}
    </div>
  );
}

function formatDateTime(value?: string): string {
  if (!value) return 'Not observed';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not observed';
  return date.toLocaleString();
}
