import { lazy, Suspense, useEffect, type ReactElement } from 'react';
import type { ShellDestination } from '@pm/contracts/shell';
import { App } from './App.tsx';
import { useAuth } from './auth.tsx';
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
import { DocumentPage } from './pages/document-pages.tsx';
import { KnowledgePage } from './pages/knowledge-pages.tsx';
import { NotificationCentrePage, NotificationSettingsPage } from './pages/notify-pages.tsx';
import { LifecycleHarnessPage } from './pages/harness.tsx';
import {
  AcceptInvitationPage,
  AccessSettingsPage,
  InvitePage,
  MemberPage,
  PeoplePage,
  TeamPage,
  TeamsPage,
} from './pages/people-pages.tsx';
import { ProjectPage, ProjectsPage } from './pages/project-pages.tsx';
import { ProjectlessTasksPage, TaskPage } from './pages/task-pages.tsx';
import { TimeApprovalsPage, TimePage, TimeReportPage } from './pages/time-pages.tsx';
import { TodayPage } from './pages/today-pages.tsx';
import { CapacityPage } from './pages/capacity-pages.tsx';
// 5B pages load on first use, so every other page keeps its startup cost.
const GoalsPage = lazy(() =>
  import('./pages/goal-pages.tsx').then((m) => ({ default: m.GoalsPage })),
);
const GoalPage = lazy(() =>
  import('./pages/goal-detail-pages.tsx').then((m) => ({ default: m.GoalPage })),
);
const PortfolioPage = lazy(() =>
  import('./pages/portfolio-pages.tsx').then((m) => ({ default: m.PortfolioPage })),
);
const loadingGoals = (
  <p className="loading" role="status">
    Loading…
  </p>
);
import {
  ApprovalsPage,
  FieldSetsPage,
  FieldsPage,
  WorkflowsPage,
} from './pages/workflow-pages.tsx';
import {
  FavoritesPage,
  HomePage,
  NotAvailablePage,
  PreferencesPage,
  RecentPage,
  SharedWithMePage,
  UnavailableDestinationPage,
  WorkspaceRootPage,
} from './pages/shell-pages.tsx';
import {
  BrandSettingsPage,
  FirstBrandPage,
  NewBrandPage,
  OnboardingPage,
  WorkspaceSettingsPage,
  WorkspacesPage,
} from './pages/workspace-pages.tsx';
import { useRouter } from './router.tsx';
import { AppShell } from './shell/layout.tsx';
import { canSee, matchRoute, ROUTES, type RouteDef } from './shell/registry.ts';
import {
  isNotAvailable,
  isSignedOut,
  useWorkspaceShell,
  WorkspaceShellProvider,
} from './shell/workspace.tsx';
import {
  InboxPage,
  IntakeFormPage,
  IntakeFormsPage,
  NotePage,
  NotesPage,
} from './pages/capture-pages.tsx';
import { CalendarPage, MyWorkPage, SavedViewPage, SavedViewsPage } from './pages/view-pages.tsx';
import { Page } from './ui/layout.tsx';

type Params = Record<string, string>;
type Render = (p: Params) => ReactElement;

const destination = (d: ShellDestination): Render =>
  d === 'home'
    ? (p) => <HomePage key={p.ws} ws={p.ws!} />
    : d === 'today'
      ? (p) => <TodayPage key={p.ws} ws={p.ws!} />
      : d === 'projects'
        ? (p) => <ProjectsPage key={p.ws} ws={p.ws!} />
        : d === 'inbox'
          ? (p) => <InboxPage key={p.ws} ws={p.ws!} />
          : () => <UnavailableDestinationPage destination={d} />;

/**
 * Every registry route maps to exactly one page. The registry unit test checks that this record
 * covers every route id, so no navigation entry can lead nowhere.
 */
export const ROUTE_COMPONENTS: Record<string, Render> = {
  home: destination('home'),
  today: destination('today'),
  inbox: destination('inbox'),
  my_work: (p) => <MyWorkPage key={p.ws} ws={p.ws!} />,
  projects: destination('projects'),
  project: (p) => <ProjectPage key={p.prj} ws={p.ws!} prj={p.prj!} />,
  project_section: (p) => <ProjectPage key={p.prj} ws={p.ws!} prj={p.prj!} section={p.section!} />,
  tasks: (p) => <ProjectlessTasksPage ws={p.ws!} />,
  notes: (p) => <NotesPage key={p.ws} ws={p.ws!} />,
  note: (p) => <NotePage key={p.note} ws={p.ws!} note={p.note!} />,
  intake_forms: (p) => <IntakeFormsPage key={p.ws} ws={p.ws!} />,
  intake_form: (p) => <IntakeFormPage key={p.form} ws={p.ws!} form={p.form!} />,
  workflows: (p) => <WorkflowsPage ws={p.ws!} />,
  fields: (p) => <FieldsPage ws={p.ws!} />,
  field_sets: (p) => <FieldSetsPage ws={p.ws!} />,
  approvals: (p) => <ApprovalsPage ws={p.ws!} />,
  notifications: (p) => <NotificationCentrePage key={p.ws} ws={p.ws!} />,
  notification_settings: (p) => <NotificationSettingsPage key={p.ws} ws={p.ws!} />,
  time: (p) => <TimePage key={p.ws} ws={p.ws!} />,
  time_approvals: (p) => <TimeApprovalsPage key={p.ws} ws={p.ws!} />,
  time_report: (p) => <TimeReportPage key={p.ws} ws={p.ws!} />,
  capacity: (p) => <CapacityPage key={p.ws} ws={p.ws!} />,
  task: (p) => <TaskPage key={p.tsk} ws={p.ws!} tsk={p.tsk!} />,
  calendar: (p) => <CalendarPage key={p.ws} ws={p.ws!} />,
  knowledge: (p) => <KnowledgePage key={p.ws} ws={p.ws!} />,
  document: (p) => <DocumentPage key={p.doc} ws={p.ws!} doc={p.doc!} />,
  goals: (p) => (
    <Suspense fallback={loadingGoals}>
      <GoalsPage key={p.ws} ws={p.ws!} />
    </Suspense>
  ),
  goal: (p) => (
    <Suspense fallback={loadingGoals}>
      <GoalPage key={p.goal} ws={p.ws!} goal={p.goal!} />
    </Suspense>
  ),
  portfolio: (p) => (
    <Suspense fallback={loadingGoals}>
      <PortfolioPage key={p.ws} ws={p.ws!} />
    </Suspense>
  ),
  reports: destination('reports'),
  shared: (p) => <SharedWithMePage key={p.ws} ws={p.ws!} />,
  views: (p) => <SavedViewsPage key={p.ws} ws={p.ws!} />,
  view: (p) => <SavedViewPage key={p.view} ws={p.ws!} view={p.view!} />,
  favorites: (p) => <FavoritesPage key={p.ws} ws={p.ws!} />,
  recent: (p) => <RecentPage key={p.ws} ws={p.ws!} />,
  people: (p) => <PeoplePage key={p.ws} ws={p.ws!} />,
  invite: (p) => <InvitePage ws={p.ws!} />,
  person: (p) => <MemberPage key={p.mem} ws={p.ws!} member={p.mem!} />,
  teams: (p) => <TeamsPage ws={p.ws!} />,
  team: (p) => <TeamPage key={p.team} ws={p.ws!} team={p.team!} />,
  brand_new: (p) => <NewBrandPage ws={p.ws!} />,
  brand: (p) => <BrandSettingsPage key={p.brand} ws={p.ws!} brand={p.brand!} />,
  first_brand: (p) => <FirstBrandPage ws={p.ws!} />,
  workspace_settings: (p) => <WorkspaceSettingsPage ws={p.ws!} />,
  access_settings: (p) => <AccessSettingsPage ws={p.ws!} />,
  workspace_root: (p) => <WorkspaceRootPage key={p.ws} ws={p.ws!} />,
  preferences: () => <PreferencesPage />,
  account_security: () => <AccountSecurityPage />,
  workspaces: () => <WorkspacesPage />,
  onboarding: () => <OnboardingPage />,
  accept_invitation: () => <AcceptInvitationPage />,
  sign_in: () => <SignInPage />,
  sign_in_verify: () => <SignInVerifyPage />,
  register: () => <RegisterPage />,
  verify_email: () => <VerifyEmailPage />,
  verify_confirm: () => <VerifyConfirmPage />,
  forgot_password: () => <ForgotPasswordPage />,
  reset_password: () => <ResetPasswordPage />,
  status: () => <App />,
  harness: () => <LifecycleHarnessPage />,
  root: () => <RootRedirect />,
};

function RootRedirect() {
  const { me } = useAuth();
  const { navigate } = useRouter();
  useEffect(() => {
    if (me !== undefined) navigate(me ? '/onboarding' : '/sign-in', { replace: true });
  }, [me, navigate]);
  return <Page title="Loading">{null}</Page>;
}

/** Signed-out visitors go to sign-in first (ST-41); nothing renders until the session is known. */
function RequireSession({ children }: { children: ReactElement }) {
  const { me } = useAuth();
  const { navigate } = useRouter();
  useEffect(() => {
    if (me === null) navigate('/sign-in', { replace: true });
  }, [me, navigate]);
  if (!me) return <Page title="Loading">{null}</Page>;
  return children;
}

/**
 * Workspace pages render only once the server context confirms membership; a route the principal
 * may not use renders the canonical not-available state (never a partial page).
 */
function WorkspaceGate({ def, params }: { def: RouteDef | null; params: Params }) {
  const shellState = useWorkspaceShell()!;
  const { refresh } = useAuth();
  // A session that ended while the tab was open (revoked, removed, signed out elsewhere) is not a
  // connection problem: re-reading the session signs the tab out, and RequireSession then goes to
  // sign-in, as a fresh load would.
  const signedOut = isSignedOut(shellState.failure);
  useEffect(() => {
    if (signedOut) void refresh();
  }, [signedOut, refresh]);
  if (signedOut) return <Page title="Loading">{null}</Page>;
  if (shellState.failure) {
    if (isNotAvailable(shellState.failure)) return <NotAvailablePage />;
    return (
      <Page title="Loading" record={null}>
        <p role="status">We couldn't load this workspace. Check your connection and try again.</p>
      </Page>
    );
  }
  if (!shellState.context) return <Page title="Loading">{null}</Page>;
  if (!def || !canSee(def, shellState.access)) return <NotAvailablePage />;
  return ROUTE_COMPONENTS[def.id]!(params);
}

export function Routes() {
  const { path } = useRouter();
  const hit = matchRoute(path);
  const wsMatch = /^\/workspaces\/([A-Za-z0-9_]{1,64})(?:\/|$)/.exec(path);
  if (hit?.def.shell === 'workspace' || (!hit && wsMatch && wsMatch[1] !== 'new')) {
    const ws = hit?.params.ws ?? wsMatch![1]!;
    return (
      <RequireSession>
        <WorkspaceShellProvider key={ws} ws={ws}>
          <AppShell kind="workspace">
            <WorkspaceGate def={hit?.def ?? null} params={hit?.params ?? { ws }} />
          </AppShell>
        </WorkspaceShellProvider>
      </RequireSession>
    );
  }
  if (hit?.def.shell === 'personal')
    return (
      <RequireSession>
        <AppShell kind="personal">{ROUTE_COMPONENTS[hit.def.id]!(hit.params)}</AppShell>
      </RequireSession>
    );
  if (hit) return ROUTE_COMPONENTS[hit.def.id]!(hit.params);
  return <Unmatched />;
}

/** Unknown addresses: the not-available state inside the personal shell when signed in. */
function Unmatched() {
  const { me } = useAuth();
  if (me === undefined) return <Page title="Loading">{null}</Page>;
  if (me)
    return (
      <AppShell kind="personal">
        <NotAvailablePage />
      </AppShell>
    );
  return <NotAvailablePage />;
}

export const REGISTERED_ROUTE_IDS = ROUTES.map((r) => r.id);
