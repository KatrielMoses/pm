import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthProvider, useAuth } from './auth.tsx';
import { AccountSecurityPage } from './pages/account-security.tsx';
import {
  ForgotPasswordPage,
  OnboardingPage,
  RegisterPage,
  ResetPasswordPage,
  SignInPage,
  SignInVerifyPage,
  VerifyConfirmPage,
  VerifyEmailPage,
} from './pages/auth-pages.tsx';
import { Link, Router, useRouter } from './router.tsx';
import { StepUpProvider } from './stepup.tsx';
import { Page } from './ui/layout.tsx';
import './styles.css';

const ROUTES: Record<string, () => React.JSX.Element> = {
  '/sign-in': SignInPage,
  '/sign-in/verify': SignInVerifyPage,
  '/register': RegisterPage,
  '/verify-email': VerifyEmailPage,
  '/verify-email/confirm': VerifyConfirmPage,
  '/forgot-password': ForgotPasswordPage,
  '/reset-password': ResetPasswordPage,
  '/onboarding': OnboardingPage,
  '/account/security': AccountSecurityPage,
  '/status': () => <App />,
};

function Home() {
  const { me } = useAuth();
  const { navigate } = useRouter();
  if (me !== undefined)
    queueMicrotask(() => navigate(me ? '/onboarding' : '/sign-in', { replace: true }));
  return <Page title="Loading">{null}</Page>;
}

function Routes() {
  const { path } = useRouter();
  if (path === '/') return <Home />;
  const Component = ROUTES[path];
  if (Component) return <Component />;
  return (
    <Page title="Page not found">
      <p>
        <Link to="/">Go to the start page</Link>
      </p>
    </Page>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <AuthProvider>
        <StepUpProvider>
          <Routes />
        </StepUpProvider>
      </AuthProvider>
    </Router>
  </StrictMode>,
);
