import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthProvider, useAuth } from './auth.tsx';
import { AccountSecurityPage } from './pages/account-security.tsx';
import {
  ForgotPasswordPage,
  RegisterPage,
  ResetPasswordPage,
  SignInPage,
  SignInVerifyPage,
  VerifyConfirmPage,
  VerifyEmailPage,
} from './pages/auth-pages.tsx';
import { LifecycleHarnessPage } from './pages/harness.tsx';
import {
  BrandSettingsPage,
  FirstBrandPage,
  NewBrandPage,
  OnboardingPage,
  WorkspaceHomePage,
  WorkspaceSettingsPage,
  WorkspacesPage,
} from './pages/workspace-pages.tsx';
import {
  AcceptInvitationPage,
  AccessSettingsPage,
  InvitePage,
  MemberPage,
  PeoplePage,
  TeamPage,
  TeamsPage,
} from './pages/people-pages.tsx';
import { Link, matchPath, Router, useRouter } from './router.tsx';
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
  '/workspaces': WorkspacesPage,
  '/invitations/accept': AcceptInvitationPage,
  '/account/security': AccountSecurityPage,
  '/status': () => <App />,
  // Local/test component harness (the page itself renders "not found" unless enabled).
  '/_harness/lifecycle': LifecycleHarnessPage,
};

function Home() {
  const { me } = useAuth();
  const { navigate } = useRouter();
  if (me !== undefined)
    queueMicrotask(() => navigate(me ? '/onboarding' : '/sign-in', { replace: true }));
  return <Page title="Loading">{null}</Page>;
}

/** Workspace routes carry public IDs in the path; the server re-derives authority on every call. */
const PARAM_ROUTES: Array<[string, (p: Record<string, string>) => React.JSX.Element]> = [
  ['/workspaces/:ws/first-brand', (p) => <FirstBrandPage ws={p.ws!} />],
  ['/workspaces/:ws/settings', (p) => <WorkspaceSettingsPage ws={p.ws!} />],
  ['/workspaces/:ws/settings/access', (p) => <AccessSettingsPage ws={p.ws!} />],
  ['/workspaces/:ws/people', (p) => <PeoplePage key={p.ws} ws={p.ws!} />],
  ['/workspaces/:ws/people/invite', (p) => <InvitePage ws={p.ws!} />],
  ['/workspaces/:ws/people/:mem', (p) => <MemberPage key={p.mem} ws={p.ws!} member={p.mem!} />],
  ['/workspaces/:ws/teams', (p) => <TeamsPage ws={p.ws!} />],
  ['/workspaces/:ws/teams/:team', (p) => <TeamPage key={p.team} ws={p.ws!} team={p.team!} />],
  ['/workspaces/:ws/brands/new', (p) => <NewBrandPage ws={p.ws!} />],
  [
    '/workspaces/:ws/brands/:brand',
    (p) => <BrandSettingsPage key={p.brand} ws={p.ws!} brand={p.brand!} />,
  ],
  ['/workspaces/:ws', (p) => <WorkspaceHomePage key={p.ws} ws={p.ws!} />],
];

function Routes() {
  const { path } = useRouter();
  if (path === '/') return <Home />;
  const Component = ROUTES[path];
  if (Component) return <Component />;
  for (const [pattern, render] of PARAM_ROUTES) {
    const params = matchPath(pattern, path);
    if (params) return render(params);
  }
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
