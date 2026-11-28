// The "Yay!" screen after you complete a topic (components/Celebration.tsx). Anything can ask for it;
// the host in Layout shows one at a time. Off with Settings → Focus → "Yay! screen".
import { useSyncExternalStore } from 'react';
import type { RoomDetail } from '@shared/types';
import { plannedItems } from '@shared/planView';
import { getFocusSettings } from './focusSettings';

export interface Cheer {
  topicTitle: string;
  roomName: string;
  /** The room plant before and after this topic: today's plan if the topic was on it, else the room. */
  before: number;
  after: number;
  caption: string;
  accent: string;
}

let current: Cheer | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function celebrate(cheer: Cheer) {
  if (!getFocusSettings().celebrate) return;
  current = cheer;
  changed();
}

export function endCelebration() {
  current = null;
  changed();
}

export function useCelebration(): Cheer | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/**
 * How much the room plant grows when you complete a topic. The room page's plant follows today's plan, so
 * a topic on today's plan counts towards that; anything else counts towards the whole room.
 */
export function plantGrowth(room: RoomDetail | undefined, meId: string, todayDate: string, topicId: string): Pick<Cheer, 'before' | 'after' | 'caption'> {
  if (!room) return { before: 60, after: 100, caption: 'Your plant just had a drink.' };
  // Today's plan: everything planned for today (subtopics count one each); completing the topic ticks all of its.
  const today = plannedItems(room.tasks.filter((t) => t.ownerId === meId)).filter((t) => t.date === todayDate);
  const ours = today.filter((t) => t.topicId === topicId);
  if (ours.length) {
    const done = today.filter((t) => t.done && t.topicId !== topicId).length;
    const n = today.length;
    return {
      before: (done / n) * 100,
      after: ((done + ours.length) / n) * 100,
      caption: done + ours.length >= n ? `All ${n} done today — a new tree for your forest 🌳` : `${done + ours.length} of ${n} done today in ${room.name}`,
    };
  }
  const mine = room.topics.filter((t) => t.createdBy === meId);
  const isDone = (id: string) => {
    const p = room.topics.find((t) => t.id === id)?.progress[meId];
    return Boolean(p && (p.status === 'completed' || p.firstCompletedAt));
  };
  const done = mine.filter((t) => t.id !== topicId && isDone(t.id)).length;
  const n = Math.max(1, mine.length);
  return { before: (done / n) * 100, after: ((done + 1) / n) * 100, caption: `${done + 1} of ${mine.length} topics done in ${room.name}` };
}
