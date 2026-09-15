import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/** Tray links use the host Router so its SessionProvider stays mounted. */
export function XpodDesktopNavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => globalThis.xpodDesktop?.onNavigate?.((route) => {
    const target = new URL(route, window.location.origin);
    if (target.origin !== window.location.origin) return;
    void navigate(`${target.pathname}${target.search}${target.hash}`);
  }), [navigate]);
  return null;
}
