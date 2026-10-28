// Live updates via Supabase Realtime. The database is the source of truth: a change only tells us
// which screens to refetch. Realtime applies row-level security, so each person only hears about rows
// they may read. On reconnect we refetch everything, so a dropped connection never leaves stale data.
import { useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { REACTIONS, type ReactionKey } from '@shared/theme';
import { supabase } from './supabase';
import { syncClock } from './api';
import { toast } from './toast';

const ALL = ['home', 'friends', 'friend', 'rooms', 'room', 'topicHistory', 'plans', 'plan', 'tasks', 'activity', 'session', 'sessions', 'progress', 'me'];

// Which cached queries each table's changes can affect.
const TABLE_KEYS: Record<string, string[]> = {
  presence: ['friends', 'friend', 'room', 'rooms', 'home', 'session', 'sessions', 'progress'],
  friendships: ['friends', 'friend', 'home', 'rooms'],
  rooms: ['rooms', 'room', 'home'],
  room_members: ['rooms', 'room', 'home'],
  topics: ['room', 'rooms', 'home', 'plan', 'plans', 'tasks', 'topicHistory'],
  topic_progress: ['room', 'rooms', 'home', 'plan', 'plans', 'tasks'],
  topic_completions: ['room', 'rooms', 'home', 'plan', 'plans', 'tasks', 'friends', 'friend', 'progress'],
  plans: ['plans', 'plan', 'home', 'tasks', 'room'],
  plan_sprints: ['plans', 'plan', 'room', 'rooms', 'home', 'tasks'],
  plan_tasks: ['plans', 'plan', 'room', 'rooms', 'home', 'tasks'],
  tasks: ['tasks', 'home'],
  activities: ['activity', 'friend', 'home', 'room'],
};

export type ConnectionState = 'connecting' | 'online' | 'offline';

async function displayName(userId: string): Promise<string> {
  const { data } = await supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  return data?.display_name ?? 'Your friend';
}

/** Gentle notices for things addressed to you. */
async function notice(table: string, event: string, row: Record<string, any>, meId: string) {
  if (table === 'activities' && event === 'INSERT') {
    if (row.actor_id === meId) return;
    const who = await displayName(row.actor_id);
    if (row.recipient_id === meId && row.type === 'reaction') {
      const r = REACTIONS[row.reaction as ReactionKey];
      if (r) toast(`${r.emoji} ${who}: ${r.label}`, 'notice');
    } else if (row.recipient_id === meId && row.type === 'message') {
      toast(`💌 ${who}: ${row.message}`, 'notice');
    } else if (row.type === 'topic_completed' && row.ref_id) {
      const { data } = await supabase.from('topics').select('title').eq('id', row.ref_id).maybeSingle();
      if (data) toast(`🌼 ${who} completed “${data.title}”`, 'notice');
    }
  }
  if (table === 'friendships') {
    if (event === 'INSERT' && row.recipient_id === meId) toast(`${await displayName(row.requester_id)} sent you a friend request`, 'notice');
    if (event === 'UPDATE' && row.status === 'accepted' && row.requester_id === meId) toast(`${await displayName(row.recipient_id)} accepted your friend request 🌱`, 'notice');
  }
}

export function useRealtime(qc: QueryClient, meId: string | null): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!meId) return;
    let wasOffline = false;
    const channel = supabase.channel(`changes-${meId}`);
    for (const table of Object.keys(TABLE_KEYS)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        for (const key of TABLE_KEYS[table]) void qc.invalidateQueries({ queryKey: [key] });
        void notice(table, payload.eventType, (payload.new ?? {}) as Record<string, any>, meId);
      });
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setState('online');
        if (wasOffline) for (const key of ALL) void qc.invalidateQueries({ queryKey: [key] });
        wasOffline = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        wasOffline = true;
        setState('offline');
      }
    });

    void syncClock();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void syncClock();
      void qc.invalidateQueries({ queryKey: ['session'] });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [qc, meId]);

  return state;
}
