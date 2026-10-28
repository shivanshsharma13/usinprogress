// Friend search, requests, friend list/profile, encouragement, progress stats and the home summary.
import { all, get, newId, placeholders, run, transaction, type DB } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../http.ts';
import { addDays, startOfWeek } from '../../shared/dates.ts';
import type { CompletionSummary, Friend, FriendRequest, HomeData, ProgressStats, UserSearchResult } from '../../shared/types.ts';
import type { ReactionKey } from '../../shared/theme.ts';
import {
  areFriends,
  focusedToday,
  friendIds,
  getUser,
  getUsers,
  liveStatus,
  myRoomIds,
  recordActivity,
  toMe,
  toPublicUser,
  todayFor,
  type UserRow,
} from './core.ts';
import { listRooms } from './rooms.ts';
import { calendarPlanItems, listPlans } from './plans.ts';
import { completedTasksOn, listTasks } from './tasks.ts';
import { getActiveSession } from './sessions.ts';

// ───────────── Friend requests ─────────────

interface FriendshipRow {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  created_at: number;
  responded_at: number | null;
}

async function livePair(db: DB, a: string, b: string): Promise<FriendshipRow | undefined> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return await get<FriendshipRow>(db, "SELECT * FROM friendships WHERE user_low = ? AND user_high = ? AND status IN ('pending', 'accepted')", lo, hi);
}

export async function searchUsers(db: DB, viewerId: string, q: string): Promise<UserSearchResult[]> {
  const term = q.trim().toLowerCase().replace(/^@/, '');
  if (term.length < 2) return [];
  const escaped = term.replace(/[\\%_]/g, (c) => '\\' + c);
  const rows = await all<UserRow>(
    db,
    `SELECT * FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY (username = ?) DESC, username LIMIT 10`,
    escaped + '%',
    term,
  );
  return Promise.all(rows.map(async (u) => {
    if (u.id === viewerId) return { user: toPublicUser(u), relation: 'self' as const };
    const pair = await livePair(db, viewerId, u.id);
    let relation: UserSearchResult['relation'] = 'none';
    if (pair?.status === 'accepted') relation = 'friend';
    else if (pair?.status === 'pending') relation = pair.requester_id === viewerId ? 'pending_outgoing' : 'pending_incoming';
    return { user: toPublicUser(u), relation };
  }));
}

/** Sends a request. If they already asked me, this accepts theirs instead of creating a duplicate. */
export async function sendFriendRequest(db: DB, viewerId: string, recipientId: string): Promise<{ id: string; status: 'pending' | 'accepted' }> {
  if (recipientId === viewerId) throw badRequest("That's you! Search for your friend's username.");
  await getUser(db, recipientId);
  return await transaction(db, async () => {
    const existing = await livePair(db, viewerId, recipientId);
    if (existing?.status === 'accepted') throw conflict('You are already friends.', 'ALREADY_FRIENDS');
    if (existing?.status === 'pending') {
      if (existing.requester_id === viewerId) throw conflict('Your request is already waiting for them.', 'ALREADY_REQUESTED');
      await respondToRequest(db, viewerId, existing.id, true);
      return { id: existing.id, status: 'accepted' as const };
    }
    const id = newId();
    const [lo, hi] = viewerId < recipientId ? [viewerId, recipientId] : [recipientId, viewerId];
    await run(
      db,
      "INSERT INTO friendships (id, requester_id, recipient_id, user_low, user_high, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      id,
      viewerId,
      recipientId,
      lo,
      hi,
      Date.now(),
    );
    return { id, status: 'pending' as const };
  });
}

export async function respondToRequest(db: DB, viewerId: string, friendshipId: string, accept: boolean): Promise<FriendshipRow> {
  const f = await get<FriendshipRow>(db, 'SELECT * FROM friendships WHERE id = ?', friendshipId);
  if (!f || (f.recipient_id !== viewerId && f.requester_id !== viewerId)) throw notFound('That request could not be found.');
  if (f.recipient_id !== viewerId) throw forbidden('Only the person who received this request can answer it.');
  if (f.status !== 'pending') throw conflict('This request was already answered.', 'ALREADY_ANSWERED');
  const now = Date.now();
  await run(db, 'UPDATE friendships SET status = ?, responded_at = ? WHERE id = ?', accept ? 'accepted' : 'rejected', now, f.id);
  if (accept) await recordActivity(db, { actorId: viewerId, type: 'friend_accepted', recipientId: f.requester_id });
  return { ...f, status: accept ? 'accepted' : 'rejected', responded_at: now };
}

export async function cancelRequest(db: DB, viewerId: string, friendshipId: string): Promise<FriendshipRow> {
  const f = await get<FriendshipRow>(db, 'SELECT * FROM friendships WHERE id = ?', friendshipId);
  if (!f || f.requester_id !== viewerId) throw notFound('That request could not be found.');
  if (f.status !== 'pending') throw conflict('This request was already answered.', 'ALREADY_ANSWERED');
  await run(db, "UPDATE friendships SET status = 'cancelled', responded_at = ? WHERE id = ?", Date.now(), f.id);
  return f;
}

export async function listRequests(db: DB, viewerId: string): Promise<FriendRequest[]> {
  const rows = await all<FriendshipRow>(
    db,
    "SELECT * FROM friendships WHERE status = 'pending' AND (requester_id = ? OR recipient_id = ?) ORDER BY created_at DESC",
    viewerId,
    viewerId,
  );
  const users = await getUsers(db, rows.map((r) => (r.requester_id === viewerId ? r.recipient_id : r.requester_id)));
  return rows.map((r) => {
    const other = r.requester_id === viewerId ? r.recipient_id : r.requester_id;
    return { id: r.id, direction: r.requester_id === viewerId ? 'outgoing' : 'incoming', user: toPublicUser(users.get(other)!), createdAt: r.created_at };
  });
}

// ───────────── Friends ─────────────

/** Recent first completions by `userId` in rooms that the viewer also belongs to. */
export async function recentCompletions(db: DB, viewerId: string, userId: string, limit = 5): Promise<CompletionSummary[]> {
  const rooms = await myRoomIds(db, viewerId);
  if (!rooms.length) return [];
  return (await all<{ topic_id: string; title: string; room_id: string; room: string; completed_at: number }>(
    db,
    `SELECT c.topic_id, t.title, r.id AS room_id, r.name AS room, c.completed_at FROM topic_completions c
       JOIN topics t ON t.id = c.topic_id JOIN rooms r ON r.id = t.room_id
      WHERE c.user_id = ? AND c.kind = 'first' AND c.revoked_at IS NULL AND r.id IN (${placeholders(rooms.length)})
      ORDER BY c.completed_at DESC LIMIT ?`,
    userId,
    ...rooms,
    limit,
  )).map((r) => ({ topicId: r.topic_id, topicTitle: r.title, roomId: r.room_id, roomName: r.room, completedAt: r.completed_at }));
}

export async function listFriends(db: DB, viewerId: string): Promise<Friend[]> {
  const rows = await all<FriendshipRow & { other: string }>(
    db,
    `SELECT *, CASE WHEN requester_id = ? THEN recipient_id ELSE requester_id END AS other
       FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR recipient_id = ?) ORDER BY responded_at`,
    viewerId,
    viewerId,
    viewerId,
  );
  const users = await getUsers(db, rows.map((r) => r.other));
  return Promise.all(rows.map(async (r) => ({
    friendshipId: r.id,
    since: r.responded_at ?? r.created_at,
    user: toPublicUser(users.get(r.other)!),
    status: await liveStatus(db, viewerId, r.other),
    recentCompletions: await recentCompletions(db, viewerId, r.other),
  })));
}

export async function requireFriend(db: DB, viewerId: string, userId: string) {
  if (!await areFriends(db, viewerId, userId)) throw notFound('That person is not in your friends list.');
}

export async function encourage(db: DB, viewerId: string, input: { recipientId: string; reaction?: ReactionKey; message?: string; roomId?: string | null }) {
  if (!input.reaction && !input.message) throw badRequest('Pick a reaction or write a short message.');
  await requireFriend(db, viewerId, input.recipientId);
  if (input.roomId) {
    const rooms = await myRoomIds(db, viewerId);
    if (!rooms.includes(input.roomId) || !(await myRoomIds(db, input.recipientId)).includes(input.roomId)) throw badRequest('That room is not shared with them.');
  }
  return recordActivity(db, {
    actorId: viewerId,
    type: input.reaction ? 'reaction' : 'message',
    recipientId: input.recipientId,
    roomId: input.roomId ?? null,
    reaction: input.reaction ?? null,
    message: input.message || null,
  });
}

export async function markActivityRead(db: DB, viewerId: string) {
  await run(db, 'UPDATE activities SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL', Date.now(), viewerId);
}

export async function unreadCount(db: DB, viewerId: string): Promise<number> {
  return (await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM activities WHERE recipient_id = ? AND read_at IS NULL', viewerId))!.n;
}

// ───────────── Progress ─────────────

/** Aggregate stats. For a friend, only totals are returned — never their session list or notes. */
export async function progressStats(db: DB, viewerId: string, userId: string): Promise<ProgressStats> {
  if (viewerId !== userId) await requireFriend(db, viewerId, userId);
  const today = await todayFor(db, userId);
  const weekStart = startOfWeek(today);
  const from7 = addDays(today, -6);
  const byDay = await all<{ local_date: string; ms: number }>(
    db,
    "SELECT local_date, SUM(focused_ms) AS ms FROM study_sessions WHERE user_id = ? AND state = 'finished' AND local_date >= ? GROUP BY local_date",
    userId,
    from7 < weekStart ? from7 : weekStart,
  );
  const dayMap = new Map(byDay.map((d) => [d.local_date, d.ms]));
  const todayMs = await focusedToday(db, userId);
  dayMap.set(today, todayMs);
  const weekMs = [...dayMap.entries()].filter(([d]) => d >= weekStart && d <= today).reduce((s, [, ms]) => s + ms, 0);
  const counts = (await get<{ topics: number; tasks: number; sessions: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM topic_completions WHERE user_id = ? AND kind = 'first' AND revoked_at IS NULL) AS topics,
       (SELECT COUNT(*) FROM tasks WHERE owner_id = ? AND completed_at IS NOT NULL AND status = 'active') AS tasks,
       (SELECT COUNT(*) FROM study_sessions WHERE user_id = ? AND state = 'finished') AS sessions`,
    userId,
    userId,
    userId,
  ))!;
  return {
    userId,
    todayMs,
    weekMs,
    completedTopics: counts.topics,
    completedTasks: counts.tasks,
    sessions: counts.sessions,
    daily: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i - 6);
      return { date, ms: dayMap.get(date) ?? 0 };
    }),
  };
}

// ───────────── Home ─────────────

export async function homeData(db: DB, userId: string): Promise<HomeData> {
  const me = toMe(await getUser(db, userId));
  const today = me.today;
  const rooms = (await listRooms(db, userId)).filter((r) => r.status === 'active');
  const tasks = await listTasks(db, userId, addDays(today, -1), addDays(today, 14), { includeFriends: false });
  // Tasks from a date range always have a date.
  const todaysOpen = tasks.filter((t) => t.date! <= today && !t.completed && (t.date === today || t.topicId));
  const plans = (await listPlans(db, userId)).filter((p) => p.status === 'active');

  let primary: HomeData['primary'] = null;
  const scheduled = todaysOpen.find((t) => t.date === today);
  if (scheduled) primary = { kind: 'task', task: scheduled };
  else {
    const room = rooms.find((r) => r.nextTopic);
    if (room?.nextTopic) primary = { kind: 'topic', roomId: room.id, roomName: room.name, topicId: room.nextTopic.id, topicTitle: room.nextTopic.title };
  }

  const completedToday = (await all<{ topic_id: string; title: string; room_id: string; room: string; completed_at: number }>(
    db,
    `SELECT c.topic_id, t.title, r.id AS room_id, r.name AS room, c.completed_at FROM topic_completions c
       JOIN topics t ON t.id = c.topic_id JOIN rooms r ON r.id = t.room_id
      WHERE c.user_id = ? AND c.local_date = ? AND c.revoked_at IS NULL ORDER BY c.completed_at DESC`,
    userId,
    today,
  )).map((r) => ({ topicId: r.topic_id, topicTitle: r.title, roomId: r.room_id, roomName: r.room, completedAt: r.completed_at }));

  return {
    me,
    activeSession: await getActiveSession(db, userId),
    primary,
    friends: await listFriends(db, userId),
    today: { focusedMs: await focusedToday(db, userId), completedTopics: completedToday, completedTasks: await completedTasksOn(db, userId, today) },
    plans: plans.slice(0, 4),
    rooms,
    upcoming: tasks.filter((t) => t.date! >= today && !t.completed).slice(0, 5),
    plannedTasks: (await calendarPlanItems(db, userId, today, addDays(today, 14), { friends: false })).items.filter((t) => !t.done).slice(0, 8),
    unread: await unreadCount(db, userId),
  };
}

export { friendIds };
