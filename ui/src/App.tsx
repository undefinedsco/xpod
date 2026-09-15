import { scopeAccountUrl } from './utils/account-interaction-url';
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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

function AppRoutes() {
  const { isInitializing, initError, retry } = useAuth();
  
  if (isInitializing) return <LoadingScreen />;
  if (initError) return <ErrorScreen message={initError} retry={retry} />;

  return (
    <Routes>
      <Route path={scopeAccountUrl("/.account/")} element={<IndexPage />} />
      <Route path={scopeAccountUrl("/.account/about/")} element={<AboutPage />} />
      <Route path={scopeAccountUrl("/.account/account/")} element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
      <Route path={scopeAccountUrl("/.account/create-pod/")} element={<ProtectedRoute allowOidcPending><FirstPodPage /></ProtectedRoute>} />
      <Route path={scopeAccountUrl("/.account/login/")} element={<LoginSelectPage />} />
      <Route path={scopeAccountUrl("/.account/login/password/")} element={<WelcomePage key="login" initialIsRegister={false} />} />
      <Route path={scopeAccountUrl("/.account/login/password/register/")} element={<WelcomePage key="register" initialIsRegister={true} />} />
      <Route path={scopeAccountUrl("/.account/login/password/forgot/")} element={<ForgotPasswordPage />} />
      <Route path={scopeAccountUrl("/.account/login/password/reset/")} element={<ResetPasswordPage />} />
      <Route path={scopeAccountUrl("/.account/oidc/consent/")} element={<ConsentPage />} />
      <Route path="*" element={<Navigate to={scopeAccountUrl("/.account/")} replace />} />
    </Routes>
  );
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
