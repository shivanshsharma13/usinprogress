import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from './lib/queries';
import { setUnauthenticatedHandler } from './lib/api';
import { configured, supabase, takeRecoveryArrival } from './lib/supabase';
import { applyMyAccent, applyScheme } from './lib/theme';
import { forgetSavedScreens } from './lib/cache';
import { Layout } from './components/Layout';
import { Spinner, Toasts } from './components/ui';
import { AuthPage } from './pages/Auth';
import { HomePage } from './pages/Home';
import { ForgotPasswordPage, ResetLinkProblemPage, ResetPasswordPage } from './pages/Recovery';

const RoomsPage = lazy(() => import('./pages/Rooms').then((m) => ({ default: m.RoomsPage })));
const RoomPage = lazy(() => import('./pages/Room').then((m) => ({ default: m.RoomPage })));
const StudyPage = lazy(() => import('./pages/Study').then((m) => ({ default: m.StudyPage })));
const GoalsPage = lazy(() => import('./pages/Goals').then((m) => ({ default: m.GoalsPage })));
const PlanPage = lazy(() => import('./pages/Plan').then((m) => ({ default: m.PlanPage })));
const CalendarPage = lazy(() => import('./pages/Calendar').then((m) => ({ default: m.CalendarPage })));
const FriendsPage = lazy(() => import('./pages/Friends').then((m) => ({ default: m.FriendsPage })));
const FriendPage = lazy(() => import('./pages/Friend').then((m) => ({ default: m.FriendPage })));
const ProgressPage = lazy(() => import('./pages/Progress').then((m) => ({ default: m.ProgressPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));

/** Arrived from a reset link on some other page: go and choose the new password first. */
function RecoveryRedirect() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (takeRecoveryArrival() && pathname !== '/reset') navigate('/reset', { replace: true });
  }, []);
  return null;
}

export function App() {
  const qc = useQueryClient();
  const { data: me, isLoading, error, refetch } = useMe();

  useEffect(() => {
    setUnauthenticatedHandler(() => qc.setQueryData<any>(['me'], null));
    // Signed out elsewhere, or the session expired: show the sign-in screen.
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
        qc.setQueryData<any>(['me'], null);
        forgetSavedScreens();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  // The profile's theme follows the person everywhere, across pages and reloads.
  useEffect(() => {
    if (!me) return;
    applyScheme(me.colorScheme);
    applyMyAccent(me.accent);
  }, [me?.colorScheme, me?.accent]);

  if (!configured)
    return (
      <div className="auth-wrap">
        <div className="card stack">
          <h2>Almost there</h2>
          <p className="small">This build doesn't know which Supabase project to use. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README) and build again.</p>
        </div>
      </div>
    );
  if (isLoading) return <Spinner />;
  if (error)
    return (
      <div className="auth-wrap">
        <div className="card stack center">
          <p>We couldn't reach the garden. Check your connection.</p>
          <button className="btn primary" onClick={() => refetch()}>
            Try again
          </button>
        </div>
      </div>
    );

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Toasts />
      {!me ? (
        <Routes>
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/forgot" element={<ForgotPasswordPage />} />
          <Route path="/reset" element={<ResetLinkProblemPage />} />
          <Route path="*" element={<AuthPage mode="signin" />} />
        </Routes>
      ) : (
        <Layout me={me}>
          <RecoveryRedirect />
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/rooms/:id" element={<RoomPage />} />
              <Route path="/study" element={<StudyPage />} />
              <Route path="/goals" element={<GoalsPage />} />
              <Route path="/goals/:id" element={<PlanPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/friends" element={<FriendsPage />} />
              <Route path="/friends/:id" element={<FriendPage />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/reset" element={<ResetPasswordPage />} />
              <Route path="/forgot" element={<Navigate to="/settings" replace />} />
              <Route path="/signin" element={<Navigate to="/" replace />} />
              <Route path="/signup" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </Layout>
      )}
    </BrowserRouter>
  );
}
