import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoadingScreen } from './components/LoadingScreen';
import { ErrorScreen } from './components/ErrorScreen';
import { ProtectedRoute } from './components/ProtectedRoute';
import { IndexPage } from './pages/IndexPage';
import { WelcomePage } from './pages/WelcomePage';
import { AccountPage } from './pages/AccountPage';
import { ConsentPage } from './pages/ConsentPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginSelectPage } from './pages/LoginSelectPage';

function AppRoutes() {
  const { isInitializing, initError } = useAuth();
  
  if (isInitializing) return <LoadingScreen />;
  if (initError) return <ErrorScreen message={initError} />;

  return (
    <Routes>
      <Route path="/.account/" element={<IndexPage />} />
      <Route path="/.account/account/" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
      <Route path="/.account/login/" element={<LoginSelectPage />} />
      <Route path="/.account/login/password/" element={<WelcomePage initialIsRegister={false} />} />
      <Route path="/.account/login/password/register/" element={<WelcomePage initialIsRegister={true} />} />
      <Route path="/.account/login/password/forgot/" element={<ForgotPasswordPage />} />
      <Route path="/.account/oidc/consent/" element={<ConsentPage />} />
      <Route path="*" element={<Navigate to="/.account/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
