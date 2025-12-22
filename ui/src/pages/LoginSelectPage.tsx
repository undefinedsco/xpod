import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { CardWrapper } from '../components/CardWrapper';
import { LoadingScreen } from '../components/LoadingScreen';

export function LoginSelectPage() {
  const { controls } = useAuth();
  const [logins, setLogins] = useState<[string, string][]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
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
          setLogins(entries);
        }
      } catch {
        window.location.href = controls?.html?.password?.login || '/.account/login/password/';
      } finally {
        setIsLoading(false);
      }
    })();
  }, [controls]);

  if (isLoading) return <LoadingScreen />;

  return (
    <CardWrapper title="Select Login Method">
      <div className="space-y-2">
        {logins.map(([name, url]) => (
          <a key={name} href={url} className="block w-full py-3 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-center text-white text-sm font-medium">
            {name}
          </a>
        ))}
      </div>
    </CardWrapper>
  );
}
