import { useRef, useState } from 'react';
import { Button } from '@undefineds.co/shared-ui';

/** Only the desktop host can safely close its current login interaction. */
export function DesktopLoginReturnAction() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  if (!window.xpodDesktop?.cancelLogin) return null;

  const returnToApplication = async () => {
    const desktop = window.xpodDesktop;
    if (submitting.current || !desktop?.cancelLogin) return;
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      await desktop.cancelLogin();
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      {failed && <p role="alert" className="text-sm text-destructive">返回应用未完成，请重试。</p>}
      <Button type="button" variant="ghost" className="w-full" disabled={pending} aria-busy={pending}
        onClick={() => void returnToApplication()}>
        {pending ? '正在返回…' : '返回应用'}
      </Button>
    </div>
  );
}
