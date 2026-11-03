// While a session is active, on any page: the optional timer notification with Pause / Resume.
// With it off in Settings, this does nothing.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ActiveSession } from '@shared/types';
import { api } from '../lib/api';
import { useAction, useActiveSession } from '../lib/queries';
import { useFocusSettings } from '../lib/focusSettings';
import { closeTimerNotification, shareSignIn, showTimerNotification } from '../lib/notifications';
import { supabase } from '../lib/supabase';

export function FocusCompanion() {
  const settings = useFocusSettings();
  const { data: session } = useActiveSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const toggle = useAction((s: ActiveSession) => api.post<{ session: ActiveSession }>(`/sessions/${s.id}/${s.state === 'paused' ? 'resume' : 'pause'}`), {
    invalidate: [['session']],
    onSuccess: (r) => qc.setQueryData<any>(['session'], r.session),
  });
  const latest = useRef({ session, toggle });
  latest.current = { session, toggle };
  const pauseOrResume = (want: 'pause' | 'resume') => {
    const { session: s, toggle: t } = latest.current;
    if (s && !t.isPending && (s.state === 'running') === (want === 'pause')) t.mutate(s);
  };

  // Timer notification: shown while you're away from the app, gone when you come back.
  const notifyOn = settings.notificationControls && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  useEffect(() => {
    if (!notifyOn) return void closeTimerNotification();
    const sync = () => {
      const s = latest.current.session;
      if (s && document.visibilityState === 'hidden') {
        void shareSignIn(true);
        void showTimerNotification(s);
      } else void closeTimerNotification();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [notifyOn, session?.id, session?.state, session?.pauses.length]);

  // Keep the worker's sign-in current; forget it when controls go off or you sign out.
  useEffect(() => {
    void shareSignIn(notifyOn);
    if (!notifyOn) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') void shareSignIn(true);
      if (event === 'SIGNED_OUT') {
        void shareSignIn(false);
        void closeTimerNotification();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [notifyOn]);

  // Messages from the worker: it paused/resumed for us, or a notification asked to open the app.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const m = e.data ?? {};
      if (m.type === 'session') qc.setQueryData<any>(['session'], m.session);
      if (m.type === 'session' || m.type === 'refresh') void qc.invalidateQueries({ queryKey: ['session'] });
      if (m.type === 'open') navigate(`/${m.path ?? ''}`);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [qc, navigate]);

  // Opened from a notification button after the sign-in expired: /study?timer=pause
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const want = params.get('timer');
    if (!session || (want !== 'pause' && want !== 'resume')) return;
    params.delete('timer');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    pauseOrResume(want);
  }, [session?.id, location.search]);

  return null;
}
