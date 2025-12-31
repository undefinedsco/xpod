import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';
import { LoadingScreen } from '../components/LoadingScreen';

export function LoginSelectPage() {
  const { controls, isLoggedIn } = useAuth();
  const [logins, setLogins] = useState<[string, string][]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // If already logged in, redirect to dashboard
    if (isLoggedIn) {
      window.location.href = '/.account/account/';
      return;
    }

    (async () => {
      try {
        if (controls?.main?.logins) {
          const res = await fetch(controls.main.logins, { headers: { Accept: 'application/json' }, credentials: 'include' });
          const json = await res.json();
          const entries = Object.entries(json.logins || {}) as [string, string][];
          if (entries.length === 1) {
            window.location.href = entries[0][1];
            return;
          }
          if (entries.length === 0) {
            // No login methods configured, go to password login
            window.location.href = '/.account/login/password/';
            return;
          }
          setLogins(entries);
        } else {
          // No logins endpoint, default to password login
          window.location.href = '/.account/login/password/';
          return;
        }
      } catch {
        window.location.href = controls?.html?.password?.login || '/.account/login/password/';
      } finally {
        setIsLoading(false);
      }
    })();
  }, [controls, isLoggedIn]);

  if (isLoading) return <LoadingScreen />;

  return (
    <CardWrapper title="Select Login Method">
      <div className="space-y-2">
        {logins.map(([name, url]) => (
          <a key={name} href={url} className="block w-full py-3 px-4 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 rounded-xl text-center text-zinc-700 text-sm font-medium">
            {name}
          </a>
        ))}
      </div>
    </CardWrapper>
  );
}
