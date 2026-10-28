import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from './lib/queries';
import { setUnauthenticatedHandler } from './lib/api';
import { applyMyAccent, applyScheme } from './lib/theme';
import { Layout } from './components/Layout';
import { Spinner, Toasts } from './components/ui';
import { AuthPage } from './pages/Auth';
import { HomePage } from './pages/Home';

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

export function App() {
  const qc = useQueryClient();
  const { data: me, isLoading, error, refetch } = useMe();

  useEffect(() => {
    setUnauthenticatedHandler(() => qc.setQueryData<any>(['me'], null));
  }, [qc]);

  // The profile's theme follows the person everywhere, across pages and reloads.
  useEffect(() => {
    if (!me) return;
    applyScheme(me.colorScheme);
    applyMyAccent(me.accent);
  }, [me?.colorScheme, me?.accent]);

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
    <BrowserRouter>
      <Toasts />
      {!me ? (
        <Routes>
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="*" element={<AuthPage mode="signin" />} />
        </Routes>
      ) : (
        <Layout me={me}>
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
