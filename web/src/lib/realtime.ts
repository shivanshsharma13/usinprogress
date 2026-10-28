// Subscribes to the server's event stream and refetches whatever changed.
// On reconnect we refetch everything, so a dropped connection can never leave stale state.
import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { noteServerTime } from './api';
import { toast } from './toast';

const KEYMAP: Record<string, string[][]> = {
  me: [['me'], ['home']],
  friends: [['friends'], ['friend'], ['home']],
  rooms: [['rooms'], ['home']],
  room: [['room'], ['topicHistory']],
  goals: [['goals'], ['sharedGoals'], ['friend'], ['home']],
  calendar: [['tasks'], ['home']],
  activity: [['activity'], ['friend'], ['home']],
  session: [['session'], ['sessions'], ['home']],
  progress: [['progress'], ['home']],
};

export type ConnectionState = 'connecting' | 'online' | 'offline';

export function useRealtime(qc: QueryClient, enabled: boolean): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let wasOffline = false;
    let closed = false;

    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('hello', (e) => {
        const sentAt = Date.now();
        noteServerTime(JSON.parse((e as MessageEvent).data).serverNow, sentAt, sentAt);
        attempts = 0;
        setState('online');
        if (wasOffline) qc.invalidateQueries(); // catch up on anything we missed
        wasOffline = false;
      });
      es.addEventListener('invalidate', (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as { keys: string[]; notice?: { text: string } };
        const seen = new Set<string>();
        for (const k of ev.keys) {
          for (const qk of KEYMAP[k] ?? []) {
            const id = qk.join('/');
            if (seen.has(id)) continue;
            seen.add(id);
            qc.invalidateQueries({ queryKey: qk });
          }
        }
        if (ev.notice) toast(ev.notice.text, 'notice');
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        wasOffline = true;
        setState('offline');
        attempts++;
        retry = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4)));
      };
    };
    connect();

    const onOnline = () => {
      clearTimeout(retry);
      es?.close();
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') qc.invalidateQueries({ queryKey: ['session'] });
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [qc, enabled]);

  return state;
}
