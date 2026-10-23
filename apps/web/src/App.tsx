/**
 * App — router shell. react-router v6 owns page navigation; the store keeps
 * only pure UI state. Boots by restoring the session (GET /auth/me).
 *
 * Route table (old store `view` in parentheses):
 * - `/login`                → AuthPage (login; authed users bounce to their
 *                             original target or the workbench)
 * - `/`                     → WorkbenchPage (workbench; W5 post-login landing)
 * - `/environments`         → EnvironmentsHomePage (home)
 * - `/environments/:envId`  → WorldViewPage (world; anonymously readable for
 *                             public environments — this is also where legacy
 *                             `?env=<id>` share links redirect)
 * - `/environments/:envId/flows` → FlowsPage (业务流 canvas editor; login
 *                             required — editing needs builder/owner)
 * - `/notifications`        → NotificationsPage (notifications)
 * - `/admin`                → AdminPage (platform admin: invite codes +
 *                             registered users; non-admins get a 403 state)
 * - `/scenarios`            → ScenarioListPage (legacy-list)
 * - `/scenarios/:scenarioId`→ ScenarioDetailPage (legacy-detail)
 * - `/simulations/:simId`   → SimulationConsolePage (console deep link
 *                             restore shim, R15-D1; the console itself is
 *                             the store-driven overlay below)
 * - `/share/:shareId`       → ShareViewPage (public replay share, R15-B1)
 * - `*`                     → NotFoundPage
 *
 * The simulation console (old `simulation` view) is deliberately NOT a
 * full page: it attaches to a running simulation's runtime objects (REST poll
 * + WS stream + replay ring buffer), none of which survive a page reload —
 * the /simulations/:simId shim REBUILDS that attachment from the id. App
 * renders the console as an overlay replacing the routed page whenever the
 * store holds a `simulationId`.
 *
 * Global chrome above every route: header nav, Toasts and the P3b E-stop
 * banner. The route tree sits inside a top-level ErrorBoundary; the world
 * view and the simulation console get their own local boundaries.
 */

import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';

import { ErrorBoundary } from './components/ErrorBoundary';
import { DemoModeBanner } from './components/DemoModeBanner';
import { EstopBanner } from './components/EstopBanner';
import { NotificationBell } from './components/NotificationBell';
import { Toasts } from './components/Toasts';
import { ConfirmHost } from './components/ui/ConfirmDialog';
import { LangSwitcher } from './components/ui/LangSwitcher';
import { Loading } from './components/ui/Loading';
import { setNavigate } from './lib/navigation';
import { NotFoundPage } from './pages/NotFoundPage';
import { useAppStore } from './store/useAppStore';

// Route-level code splitting (production bundle optimization): every page is
// a lazy chunk, so the initial download is the app shell + vendor only —
// heavy consumers (reactflow flows canvas, leaflet/three world maps, echarts
// series panels) ride their own routes' chunks and load on first visit.
// Pages export named components, hence the `.then(m => ({ default: m.X }))`
// shape. NotFoundPage stays eager: the `*` fallback must render with zero
// extra round-trips.
const AuthPage = lazy(() => import('./pages/AuthPage').then(m => ({ default: m.AuthPage })));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage').then(m => ({ default: m.WorkbenchPage })));
const EnvironmentsHomePage = lazy(() =>
  import('./pages/EnvironmentsHomePage').then(m => ({ default: m.EnvironmentsHomePage })),
);
const WorldViewPage = lazy(() => import('./pages/WorldViewPage').then(m => ({ default: m.WorldViewPage })));
const InteriorWalkPage = lazy(() => import('./pages/InteriorWalkPage').then(m => ({ default: m.InteriorWalkPage })));
const FlowsPage = lazy(() => import('./pages/FlowsPage').then(m => ({ default: m.FlowsPage })));
const NotificationsPage = lazy(() =>
  import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })),
);
const ScenarioListPage = lazy(() =>
  import('./pages/ScenarioListPage').then(m => ({ default: m.ScenarioListPage })),
);
const ScenarioDetailPage = lazy(() =>
  import('./pages/ScenarioDetailPage').then(m => ({ default: m.ScenarioDetailPage })),
);
const SimulationConsolePage = lazy(() =>
  import('./pages/SimulationConsolePage').then(m => ({ default: m.SimulationConsolePage })),
);
const ShareViewPage = lazy(() => import('./pages/ShareViewPage').then(m => ({ default: m.ShareViewPage })));
// /admin: the platform admin panel (invites + users) — admin-only by store.
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));
// The simulation console OVERLAY only mounts when the store holds a
// simulationId — its chunk (echarts live panels + leaflet/reactflow maps)
// must not weigh down the shell.
const SimulationView = lazy(() => import('./pages/SimulationView').then(m => ({ default: m.SimulationView })));

/** Anonymous visitors must log in first; the original target rides along in
 *  location state so the login page can send them back afterwards. */
function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAppStore(s => s.user);
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

/** The login page is pointless once authenticated — bounce to the original
 *  target (from a RequireAuth redirect) or the workbench. */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const user = useAppStore(s => s.user);
  const location = useLocation();
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }
  return children;
}

const NAV_TAB_CLASS = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'app-nav__tab app-nav__tab--active' : 'app-nav__tab';

export default function App() {
  const user = useAppStore(s => s.user);
  const authChecked = useAppStore(s => s.authChecked);
  const bootstrapAuth = useAppStore(s => s.bootstrapAuth);
  const logout = useAppStore(s => s.logout);
  const simulationId = useAppStore(s => s.simulationId);
  const theme = useAppStore(s => s.theme);
  const toggleTheme = useAppStore(s => s.toggleTheme);
  const { t } = useTranslation('common');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Publish navigate for non-component code (store actions, ErrorBoundary).
  useEffect(() => {
    setNavigate(navigate);
  }, [navigate]);

  // 主题同步到 <html data-theme>，styles.css 的 token 块据此切换。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  // R80: the console is IN-PLACE state (openSimulationConsole swaps the store
  // without navigating — /simulations/:simId deep links REBUILD it, they
  // don't own it). Leaving the console route therefore has to CLEAR the
  // console, or the URL stops meaning anything: every page renders the
  // console until logout (the R80 probe fog — personas navigated to the env
  // page and the sidebar was "gone"). Clearing here restores route = truth.
  const location = useLocation();
  const clearSimulation = useAppStore(s => s.clearSimulation);
  const isConsoleRoute = location.pathname.startsWith('/simulations/');
  useEffect(() => {
    if (!isConsoleRoute && useAppStore.getState().simulationId !== null) {
      clearSimulation();
    }
  }, [isConsoleRoute, clearSimulation]);

  // Legacy share links (`/?env=<id>`): the world view owns the env id in its
  // path now — redirect before anything else renders.
  const legacyEnvId = searchParams.get('env');
  if (legacyEnvId) {
    return <Navigate to={`/environments/${legacyEnvId}`} replace />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <img className="app-header__logo" src="/logo.svg" alt="" />
          <h1>{t('brand')}</h1>
        </div>
        {user && (
          <nav className="app-nav" aria-label={t('nav.mainNav')}>
            <NavLink to="/" end className={NAV_TAB_CLASS}>
              {t('nav.workbench')}
            </NavLink>
            <NavLink to="/environments" className={NAV_TAB_CLASS}>
              {t('nav.environments')}
            </NavLink>
          </nav>
        )}
        <div className="app-header__user">
          <button
            type="button"
            className="icon-button"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
            aria-label={t('theme.toggle')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <LangSwitcher />
          {user ? (
            <>
              <NotificationBell />
              <span className="app-header__name">{user.displayName}</span>
              <button className="link-button" onClick={() => void logout()}>
                {t('auth.logout')}
              </button>
            </>
          ) : (
            authChecked && (
              <Link className="link-button" to="/login">
                {t('auth.login')}
              </Link>
            )
          )}
        </div>
      </header>
      <main className="app-main">
        {!authChecked && <p className="page-note">{t('loading')}</p>}
        {authChecked &&
          (simulationId ? (
            <ErrorBoundary title={t('errorBoundary.simConsole')}>
              <Suspense fallback={<Loading />}>
                <SimulationView />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <ErrorBoundary>
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route
                    path="/login"
                    element={
                      <RedirectIfAuthed>
                        <AuthPage />
                      </RedirectIfAuthed>
                    }
                  />
                  <Route
                    path="/"
                    element={
                      <RequireAuth>
                        <WorkbenchPage />
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/environments"
                    element={
                      <RequireAuth>
                        <EnvironmentsHomePage />
                      </RequireAuth>
                    }
                  />
                  {/* Public: anonymous visitors may read public environments. */}
                  <Route
                    path="/environments/:envId"
                    element={
                      <ErrorBoundary title={t('errorBoundary.worldView')}>
                        <WorldViewPage />
                      </ErrorBoundary>
                    }
                  />
                  <Route
                    path="/environments/:envId/walk"
                    element={
                      <ErrorBoundary title="interior walk">
                        <InteriorWalkPage />
                      </ErrorBoundary>
                    }
                  />
                  <Route
                    path="/environments/:envId/flows"
                    element={
                      <RequireAuth>
                        <ErrorBoundary title={t('errorBoundary.flowEditor')}>
                          <FlowsPage />
                        </ErrorBoundary>
                      </RequireAuth>
                    }
                  />
                  <Route
                    path="/notifications"
                    element={
                      <RequireAuth>
                        <NotificationsPage />
                      </RequireAuth>
                    }
                  />
                  {/* Admin panel: the page itself renders the 403 state for
                      non-admins (RequireAuth only guarantees a login). */}
                  <Route
                    path="/admin"
                    element={
                      <RequireAuth>
                        <AdminPage />
                      </RequireAuth>
                    }
                  />
                  {/* Public: the legacy scenario browser's API is open. */}
                  <Route path="/scenarios" element={<ScenarioListPage />} />
                  <Route path="/scenarios/:scenarioId" element={<ScenarioDetailPage />} />
                  {/* R15-D1: console deep links — the restore shim reopens the
                      console from the sim id (overlay state itself is rebuilt). */}
                  <Route path="/simulations/:simId" element={<SimulationConsolePage />} />
                  {/* Public (R15-B1): anonymous read-only replay share links —
                      demo-day viewers have no account. */}
                  <Route
                    path="/share/:shareId"
                    element={
                      <ErrorBoundary title={t('errorBoundary.shareView')}>
                        <ShareViewPage />
                      </ErrorBoundary>
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
          ))}
        {/* plan-r81 B2 / demo-on-world-page: the demo narration strip is
            page-scoped — it renders over whichever surface is up (the world
            page's 3D campus included), not just the console overlay. */}
        <DemoModeBanner />
      </main>
      <footer className="app-footer">
        {/* UX-W5: 旧版场景浏览器降级——scenario vs environment 概念易混淆，
            入口收进「高级 / Legacy」折叠，不在主导航出现。 */}
        <details className="app-footer__legacy">
          <summary>{t('legacyToggle')}</summary>
          <Link className="link-button" to="/scenarios">
            {t('legacyScenarios')}
          </Link>
        </details>
      </footer>
      <Toasts />
      <ConfirmHost />
      <EstopBanner />
    </div>
  );
}
