import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Input, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmationDialog } from '@undefineds.co/shared-ui';
import { RouteLoadingBoundary } from '../../layout/RouteLoadingBoundary';
import { podDeletionAuthorizationCopy } from '../../auth/xpod-account-copy';

// The standalone device task must not load Account/WebID workspace dependencies.
const AccountAuthBoundary = lazy(() => import('../../auth/AccountAuthBoundary').then(module => ({ default: module.AccountAuthBoundary })));
const SystemSettingsPage = lazy(() => import('./SystemSettingsPage'));

/** Keep the canonical Pod editor redirect while accepting an explicit device deletion task. */
export function PodManagementTaskRoute({ to }: { to: string }) {
  const task = new URLSearchParams(useLocation().search).has('deletionAuthorization');
  return task ? <PodDeletionAuthorizationPanel /> : <Navigate to={to} replace />;
}

export function PodManagementBoundary() {
  const task = new URLSearchParams(useLocation().search).has('deletionAuthorization');
  return task ? <Outlet /> : <RouteLoadingBoundary><AccountAuthBoundary surface="embedded"><Outlet /></AccountAuthBoundary></RouteLoadingBoundary>;
}

/** A task opens the heavy workspace main area directly, including on narrow screens. */
export function PodManagementFrame() {
  const task = new URLSearchParams(useLocation().search).has('deletionAuthorization');
  return task ? <PodDeletionAuthorizationPanel /> : <RouteLoadingBoundary><SystemSettingsPage /></RouteLoadingBoundary>;
}

interface AuthorizationTarget {
  challenge: string;
  podName: string;
  expiresAt: number;
  cloudAccountId: string;
  cloudPodId: string;
  nodeId: string;
  storageUrl: string;
  currentLocalPodId: string;
  ownerWebIds: string[];
  returnUrl: string;
}

function accountReturnUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.endsWith('/.account/account/') ? url.href : null;
  } catch { return null; }
}

/** Task-specific operator surface: query values are only handles, never display facts. */
export function PodDeletionAuthorizationPanel({ locale = 'zh-CN' }: { locale?: 'zh-CN' | 'en' }) {
  const { search } = useLocation();
  const copy = podDeletionAuthorizationCopy[locale];
  const [target, setTarget] = useState<AuthorizationTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);
  const [needsLocal, setNeedsLocal] = useState(false);
  const [localAddress, setLocalAddress] = useState('');
  const [localError, setLocalError] = useState('');
  const busy = useRef(false);
  const epoch = useRef(0);

  const failure = useCallback((code: unknown) => {
    switch (code) {
      case 'POD_DELETE_OPERATOR_REQUIRED':
      case 'POD_DELETE_ORIGIN_REQUIRED': return copy.operator;
      case 'POD_DELETE_AUTHORIZATION_INVALID': return copy.invalid;
      case 'POD_DELETE_GENERATION_CHANGED':
      case 'POD_DELETE_AUTHORIZATION_CONFLICT':
      case 'POD_DELETE_NOT_FOUND': return copy.changed;
      case 'POD_DELETE_NODE_UNAVAILABLE': return copy.unavailable;
      default: return copy.failed;
    }
  }, [copy]);

  const inspect = useCallback(async () => {
    if (busy.current) return;
    const requestEpoch = ++epoch.current;
    const params = new URLSearchParams(search);
    const challenge = params.get('deletionAuthorization');
    const podName = params.get('podName');
    setTarget(null); setReturnUrl(null); setError(''); setDone(false); setConfirming(false); setNeedsLocal(false); setLocalError('');
    if (!challenge || challenge.length > 2048 || !podName || !/^[a-zA-Z0-9_-]{1,64}$/.test(podName)) {
      setError(copy.invalid); return;
    }
    busy.current = true; setPending(true);
    try {
      const response = await fetch('/provision/pods', {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'inspectDeletionAuthorization', challenge, podName }),
      });
      const body = await response.json().catch(() => ({}));
      if (requestEpoch !== epoch.current) return;
      if (!response.ok) {
        const code = body.code ?? body.error ?? body.message;
        const operatorRequired = response.status === 401 || code === 'POD_DELETE_OPERATOR_REQUIRED' || code === 'POD_DELETE_ORIGIN_REQUIRED';
        setNeedsLocal(operatorRequired);
        setError(operatorRequired ? copy.operator : failure(code));
        return;
      }
      const inspected = body.deletionAuthorization as AuthorizationTarget;
      if (!inspected || inspected.challenge !== challenge || inspected.podName !== podName
        || !(inspected.expiresAt > Date.now()) || !accountReturnUrl(inspected.returnUrl)
        || !['cloudAccountId', 'cloudPodId', 'nodeId', 'storageUrl', 'currentLocalPodId'].every((key) => typeof inspected[key as keyof AuthorizationTarget] === 'string' && inspected[key as keyof AuthorizationTarget])
        || !Array.isArray(inspected.ownerWebIds) || inspected.ownerWebIds.some((id) => typeof id !== 'string')) {
        setError(copy.invalid); return;
      }
      setTarget(inspected);
      setReturnUrl(accountReturnUrl(inspected.returnUrl));
    } catch { if (requestEpoch === epoch.current) setError(copy.unavailable); }
    finally { if (requestEpoch === epoch.current) { busy.current = false; setPending(false); } }
  }, [search, copy, failure]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void inspect(); });
    const invalidate = () => { epoch.current++; busy.current = false; };
    return () => { active = false; invalidate(); };
  }, [inspect]);

  const authorize = async () => {
    if (!target || busy.current) return;
    if (target.expiresAt <= Date.now()) { setTarget(null); setConfirming(false); setError(copy.invalid); return; }
    const requestEpoch = epoch.current;
    busy.current = true; setPending(true); setError('');
    try {
      const response = await fetch('/provision/pods', {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'authorizeDeletion', challenge: target.challenge, podName: target.podName, expectedLocalPodId: target.currentLocalPodId }),
      });
      const body = await response.json().catch(() => ({}));
      if (requestEpoch !== epoch.current) return;
      if (!response.ok) {
        const code = body.code ?? body.error ?? body.message;
        const operatorRequired = response.status === 401 || code === 'POD_DELETE_OPERATOR_REQUIRED' || code === 'POD_DELETE_ORIGIN_REQUIRED';
        setNeedsLocal(operatorRequired);
        setError(operatorRequired ? copy.operator : failure(code));
        if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 409) {
          setTarget(null); setConfirming(false);
        }
        return;
      }
      if (body.success !== true || accountReturnUrl(body.returnUrl) !== accountReturnUrl(target.returnUrl)) { setError(copy.invalid); return; }
      setDone(true); setConfirming(false);
    } catch { if (requestEpoch === epoch.current) setError(copy.unavailable); }
    finally { if (requestEpoch === epoch.current) { busy.current = false; setPending(false); } }
  };

  const continueOnDevice = (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError('');
    try {
      const destination = new URL(localAddress.trim());
      const hostname = destination.hostname.toLowerCase();
      const loopbackV4 = /^127(?:\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every((part) => Number(part) <= 255);
      if (!['http:', 'https:'].includes(destination.protocol) || !(['localhost', '[::1]'].includes(hostname) || loopbackV4)
        || destination.username || destination.password || destination.search || destination.hash
        || localAddress.includes('?') || localAddress.includes('#') || /^https?:\/\/[^/]*@/i.test(localAddress.trim())) throw new Error('invalid-local-address');
      const params = new URLSearchParams(search);
      const challenge = params.get('deletionAuthorization');
      const podName = params.get('podName');
      if (!challenge || challenge.length > 2048 || !podName || !/^[a-zA-Z0-9_-]{1,64}$/.test(podName)) throw new Error('invalid-request');
      const basePath = destination.pathname.replace(/\/+$/, '');
      destination.pathname = basePath.endsWith('/settings/pod') ? basePath : `${basePath}/settings/pod`;
      destination.searchParams.set('deletionAuthorization', challenge);
      destination.searchParams.set('podName', podName);
      window.location.assign(destination.href);
    } catch { setLocalError(copy.localInvalid); }
  };

  const facts = target ? <dl className="space-y-3 text-sm">
    <div><dt className="text-muted-foreground">{copy.account}</dt><dd className="break-all">{target.cloudAccountId}</dd></div>
    <div><dt className="text-muted-foreground">{copy.address}</dt><dd className="break-all font-mono">{target.storageUrl}</dd></div>
    {target.ownerWebIds.length ? <div><dt className="text-muted-foreground">{copy.identities}</dt><dd className="space-y-1 break-all">{target.ownerWebIds.map((id) => <p key={id}>{id}</p>)}</dd></div> : null}
  </dl> : null;

  return <section className="mx-auto w-full max-w-2xl p-4 sm:p-6" aria-label={copy.title}>
    <Card><CardHeader><CardTitle>{copy.title}</CardTitle><CardDescription>{copy.lead}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {pending && !target ? <p role="status">{copy.loading}</p> : null}
        {error && !confirming ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {facts}
        {needsLocal ? <form onSubmit={continueOnDevice} className="space-y-3">
          <p className="text-sm text-muted-foreground" id="local-xpod-hint">{copy.localHint}</p>
          <label htmlFor="local-xpod-address" className="block text-sm font-medium">{copy.localAddress}</label>
          <Input id="local-xpod-address" value={localAddress} onChange={(event) => setLocalAddress(event.target.value)}
            aria-describedby="local-xpod-hint" autoComplete="off" spellCheck={false} required />
          {localError ? <p role="alert" className="text-sm text-destructive">{localError}</p> : null}
          <Button type="submit">{copy.localContinue}</Button>
        </form> : null}
        {done ? <p role="status">{copy.done}</p> : null}
        <div className="flex flex-wrap gap-2">
          {target && !done ? <Button disabled={pending} onClick={() => setConfirming(true)}>{copy.allow}</Button> : null}
          {returnUrl && !pending ? <Button asChild variant="outline"><a href={returnUrl}>{done || !target ? copy.back : copy.cancel}</a></Button> : null}
          {!target && !pending ? <Button variant="outline" onClick={() => void inspect()}>{copy.retry}</Button> : null}
        </div>
      </CardContent>
    </Card>
    <ConfirmationDialog open={confirming} onOpenChange={setConfirming} title={copy.title} description={copy.lead}
      confirmVariant="default" confirmLabel={pending ? copy.pending : copy.allow} cancelLabel={copy.cancel} pending={pending} error={error} onConfirm={() => void authorize()}>
      {facts}
    </ConfirmationDialog>
  </section>;
}
