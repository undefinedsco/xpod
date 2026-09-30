import { scopeAccountUrl } from './utils/account-interaction-url';
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/AuthContextValue';
import { LoadingScreen } from './components/LoadingScreen';
import { ErrorScreen } from './components/ErrorScreen';
import { ProtectedRoute } from './components/ProtectedRoute';
import { IndexPage } from './pages/IndexPage';
import { WelcomePage } from './pages/WelcomePage';
import { AboutPage } from './pages/AboutPage';
import { AccountPage } from './pages/AccountPage';
import { FirstPodPage } from './pages/FirstPodPage';
import { ConsentPage } from './pages/ConsentPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { LoginSelectPage } from './pages/LoginSelectPage';

/** Exported so route-level admission (About vs. the Account gate) stays testable. */
export function AppRoutes() {
  return (
    <Routes>
      {/* About Xpod is static product information: it owns no Account data, so it
          must render while the Account bootstrap is still resolving or has
          failed, and it must never be redirected into a login flow. */}
      <Route path={scopeAccountUrl("/.account/about/")} element={<AboutPage />} />
      <Route element={<AccountBootstrapGate />}>
        <Route path={scopeAccountUrl("/.account/")} />
        <Route path={scopeAccountUrl("/.account/account/")} element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
        <Route path={scopeAccountUrl("/.account/create-pod/")} element={<ProtectedRoute allowOidcPending><FirstPodPage /></ProtectedRoute>} />
        <Route path={scopeAccountUrl("/.account/login/")} element={<LoginSelectPage />} />
        <Route path={scopeAccountUrl("/.account/login/password/")} />
        <Route path={scopeAccountUrl("/.account/login/password/register/")} />
        <Route path={scopeAccountUrl("/.account/login/password/forgot/")} element={<ForgotPasswordPage />} />
        <Route path={scopeAccountUrl("/.account/login/password/reset/")} element={<ResetPasswordPage />} />
        <Route path={scopeAccountUrl("/.account/oidc/consent/")} element={<ConsentPage />} />
        <Route path="*" element={<Navigate to={scopeAccountUrl("/.account/")} replace />} />
      </Route>
    </Routes>
  );
}

const trimSlashes = (value: string) => value.replace(/\/+$/u, '');

/**
 * The account index (where an OIDC interaction lands), sign in and register are one
 * page instance, mounted here rather than inside their routes. Switching between them
 * changes what the form shows; it never re-creates the page, so nothing typed is lost
 * to a route change. Their routes below only claim the paths.
 */
function PasswordEntryHost() {
  const { pathname } = useLocation();
  const { isLoggedIn } = useAuth();
  const path = trimSlashes(pathname);
  const login = trimSlashes(scopeAccountUrl("/.account/login/password/"));
  const atIndex = path === trimSlashes(scopeAccountUrl("/.account/"));
  if (!atIndex && path !== login && path !== `${login}/register`) return null;
  // Signed in at the index: its redirect rules (consent or Account management) apply.
  if (atIndex && isLoggedIn) return <IndexPage />;
  return <WelcomePage initialIsRegister={path === `${login}/register`} />;
}

/** Account documents wait for the CSS Account bootstrap; About does not. */
function AccountBootstrapGate() {
  const { isInitializing, initError, retry } = useAuth();

  if (isInitializing) return <LoadingScreen />;
  if (initError) return <ErrorScreen message={initError} retry={retry} />;
  return <><PasswordEntryHost /><Outlet /></>;
}

export default function App() {
  // This entry point hosts CSS Account documents, not the WebID auth window.
  // Keep window ownership here so loading/error/form mounts cannot compete.
  useEffect(() => {
    globalThis.xpodDesktop?.setWindowMode?.('workspace');
  }, []);
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
