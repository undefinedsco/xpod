import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  AccountLoginMethodListView,
  AuthSurface,
  type AccountLoginMethod,
} from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';

interface LoginMethodsResponse {
  logins?: Record<string, unknown>;
}

function safeLoginMethods(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].length > 0);
}

export function LoginSelectPage() {
  const { controls, isLoggedIn } = useAuth();
  const [methods, setMethods] = useState<AccountLoginMethod[]>([]);
  const [methodUrls, setMethodUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (isLoggedIn) return;
    let cancelled = false;

    const followPassword = () => {
      if (!cancelled) window.location.href = controls?.html?.password?.login || controls?.password?.login || '/.account/login/password/';
    };

    (async () => {
      try {
        const endpoint = controls?.main?.logins;
        if (!endpoint) {
          followPassword();
          return;
        }
        const response = await fetch(endpoint, { headers: storedAccountTokenHeaders(), credentials: 'include' });
        if (!response.ok) {
          followPassword();
          return;
        }
        const json = await response.json().catch(() => ({})) as LoginMethodsResponse;
        const entries = safeLoginMethods(json.logins);
        if (entries.length === 0) {
          followPassword();
          return;
        }
        if (entries.length === 1) {
          if (!cancelled) window.location.href = entries[0][1];
          return;
        }
        if (cancelled) return;
        const nextUrls: Record<string, string> = {};
        const nextMethods = entries.map(([name, url], index) => {
          const id = `account-login-${index}`;
          nextUrls[id] = url;
          return { id, label: name };
        });
        setMethodUrls(nextUrls);
        setMethods(nextMethods);
      } catch {
        if (!cancelled) {
          setError('Login methods are temporarily unavailable. Please try again.');
          setMethods([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [controls?.html?.password?.login, controls?.main?.logins, controls?.password?.login, isLoggedIn]);

  if (isLoggedIn) return <Navigate to="/.account/account/" replace />;

  if (loading) {
    return (
      <AuthSurface mode="page" title="Sign in">
        <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground">Loading sign-in methods…</div>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface mode="page" title="Sign in">
      <div className="p-4">
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
        <AccountLoginMethodListView
          methods={methods}
          onSelect={(id) => {
            const url = methodUrls[id];
            if (url) window.location.href = url;
          }}
          pending={false}
          copy={{
            title: 'Choose an Account login method',
            description: 'Continue with a method advertised by this Account service.',
            methodActionLabel: 'Continue',
            emptyMessage: 'No sign-in methods are available.',
          }}
        />
      </div>
    </AuthSurface>
  );
}
