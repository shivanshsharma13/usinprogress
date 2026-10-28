// Users, access checks, live status and activity — the pieces every other service relies on.
// Every check here is a backend authorization boundary; the client never decides access.
import { all, get, newId, placeholders, run, type DB } from '../db.ts';
import { forbidden, notFound } from '../http.ts';
import { focusedMs } from '../../shared/timer.ts';
import { localDate } from '../../shared/dates.ts';
import type { Activity, LiveStatus, Me, PublicUser } from '../../shared/types.ts';
import type { ReactionKey } from '../../shared/theme.ts';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  profile_type: 'engineer' | 'doctor' | 'custom';
  accent: string;
  bio: string;
  avatar: string;
  color_scheme: 'light' | 'dark';
  timezone: string;
  share_status: number;
  created_at: number;
}

export interface RoomRow {
  id: string;
  name: string;
  description: string;
  start_date: string;
  end_date: string;
  color: string;
  creator_id: string;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
}

export function toPublicUser(u: UserRow): PublicUser {
  let avatar = {};
  try {
    avatar = JSON.parse(u.avatar);
  } catch {}
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    profileType: u.profile_type,
    accent: u.accent,
    bio: u.bio,
    avatar,
  };
}

export function toMe(u: UserRow): Me {
  return {
    ...toPublicUser(u),
    colorScheme: u.color_scheme,
    timezone: u.timezone,
    shareStatus: Boolean(u.share_status),
    createdAt: u.created_at,
    today: localDate(Date.now(), u.timezone),
  };
}

export async function getUser(db: DB, id: string): Promise<UserRow> {
  const u = await get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('That person could not be found.');
  return u;
}

export async function getUsers(db: DB, ids: string[]): Promise<Map<string, UserRow>> {
  if (!ids.length) return new Map();
  const rows = await all<UserRow>(db, `SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`, ...ids);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function todayFor(db: DB, userId: string): Promise<string> {
  return localDate(Date.now(), (await getUser(db, userId)).timezone);
}

// ───────────── Friendship ─────────────

export async function friendIds(db: DB, userId: string): Promise<string[]> {
  return (await all<{ id: string }>(
    db,
    `SELECT CASE WHEN requester_id = ? THEN recipient_id ELSE requester_id END AS id
       FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR recipient_id = ?)`,
    userId,
    userId,
    userId,
  )).map((r) => r.id);
}

export async function areFriends(db: DB, a: string, b: string): Promise<boolean> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return Boolean(await get(db, "SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ? AND status = 'accepted'", lo, hi));
}

/** Me plus my accepted friends — who should hear about changes to my profile/status. */
export async function circleOf(db: DB, userId: string): Promise<string[]> {
  return [userId, ...await friendIds(db, userId)];
}

// ───────────── Rooms ─────────────

/** Returns the room if the user is an active member; otherwise 404 (never reveals that it exists). */
export async function requireRoomMember(db: DB, roomId: string, userId: string): Promise<RoomRow> {
  const room = await get<RoomRow>(
    db,
    `SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE r.id = ? AND m.user_id = ? AND m.status = 'active'`,
    roomId,
    userId,
  );
  if (!room) throw notFound('That room could not be found.');
  return room;
}

export async function roomMemberIds(db: DB, roomId: string): Promise<string[]> {
  return (await all<{ user_id: string }>(db, "SELECT user_id FROM room_members WHERE room_id = ? AND status = 'active' ORDER BY joined_at, user_id", roomId)).map(
    (r) => r.user_id,
  );
}

export async function myRoomIds(db: DB, userId: string): Promise<string[]> {
  return (await all<{ room_id: string }>(db, "SELECT room_id FROM room_members WHERE user_id = ? AND status = 'active'", userId)).map((r) => r.room_id);
}

export interface TopicRow {
  id: string;
  room_id: string;
  title: string;
  description: string;
  category: string;
  estimated_minutes: number | null;
  session_target_minutes: number | null;
  deadline: string | null;
  position: number;
  created_by: string;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
}

/** Topic plus a membership check on its room. */
export async function requireTopicAccess(db: DB, topicId: string, userId: string): Promise<{ topic: TopicRow; room: RoomRow }> {
  const topic = await get<TopicRow>(db, 'SELECT * FROM topics WHERE id = ?', topicId);
  if (!topic) throw notFound('That topic could not be found.');
  const room = await requireRoomMember(db, topic.room_id, userId);
  return { topic, room };
}

/**
 * Topic access for changes: each topic belongs to the person who added it. Room partners can see
 * it and its progress, but only the owner can edit, complete, reorder or study it.
 */
export async function requireOwnTopic(db: DB, topicId: string, userId: string): Promise<{ topic: TopicRow; room: RoomRow }> {
  const access = await requireTopicAccess(db, topicId, userId);
  if (access.topic.created_by !== userId) {
    throw forbidden("This is your friend's topic. You can follow their progress, but only they can change or study it.");
  }
  return access;
}

// ───────────── Sessions & live status ─────────────

export interface SessionRow {
  id: string;
  user_id: string;
  room_id: string;
  topic_id: string;
  task_id: string | null;
  state: 'running' | 'paused' | 'finished' | 'discarded';
  started_at: number;
  ended_at: number | null;
  focused_ms: number | null;
  measured_ms: number | null;
  target_minutes: number | null;
  remind_after_hour: number;
  is_revision: number;
  note: string;
  local_date: string;
  created_at: number;
}

export async function pausesFor(db: DB, sessionId: string) {
  return (await all<{ paused_at: number; resumed_at: number | null }>(db, 'SELECT paused_at, resumed_at FROM session_pauses WHERE session_id = ? ORDER BY paused_at', sessionId)).map(
    (p) => ({ pausedAt: p.paused_at, resumedAt: p.resumed_at }),
  );
}

export async function activeSessionRow(db: DB, userId: string): Promise<SessionRow | undefined> {
  return await get<SessionRow>(db, "SELECT * FROM study_sessions WHERE user_id = ? AND state IN ('running', 'paused')", userId);
}

export async function focusedToday(db: DB, userId: string): Promise<number> {
  const today = await todayFor(db, userId);
  const done = await get<{ ms: number | null }>(db, "SELECT SUM(focused_ms) AS ms FROM study_sessions WHERE user_id = ? AND local_date = ? AND state = 'finished'", userId, today);
  let ms = done?.ms ?? 0;
  const active = await activeSessionRow(db, userId);
  if (active && active.local_date === today) {
    ms += focusedMs({ startedAt: active.started_at, endedAt: null, pauses: await pausesFor(db, active.id) }, Date.now());
  }
  return ms;
}

/** What `viewerId` may see of `userId`'s live activity. */
export async function liveStatus(db: DB, viewerId: string, userId: string): Promise<LiveStatus> {
  const user = await getUser(db, userId);
  const todayFocusedMs = await focusedToday(db, userId);
  if (viewerId !== userId && !user.share_status) return { state: 'hidden', todayFocusedMs };
  const active = await activeSessionRow(db, userId);
  if (!active) return { state: 'idle', todayFocusedMs };
  const status: LiveStatus = {
    state: active.state === 'running' ? 'studying' : 'paused',
    startedAt: active.started_at,
    pauses: await pausesFor(db, active.id),
    todayFocusedMs,
  };
  // Only reveal what they are studying if the viewer shares that room.
  const visible = await get<{ topic: string; room: string; room_id: string }>(
    db,
    `SELECT t.title AS topic, r.name AS room, r.id AS room_id FROM topics t JOIN rooms r ON r.id = t.room_id
       JOIN room_members m ON m.room_id = r.id AND m.user_id = ? AND m.status = 'active'
      WHERE t.id = ?`,
    viewerId,
    active.topic_id,
  );
  if (visible) {
    status.topicTitle = visible.topic;
    status.roomName = visible.room;
    status.roomId = visible.room_id;
  }
  return status;
}

// ───────────── Activity ─────────────

export async function recordActivity(
  db: DB,
  a: { actorId: string; type: Activity['type']; recipientId?: string | null; roomId?: string | null; refId?: string | null; reaction?: ReactionKey | null; message?: string | null },
) {
  const id = newId();
  await run(
    db,
    'INSERT INTO activities (id, actor_id, recipient_id, room_id, type, ref_id, reaction, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    a.actorId,
    a.recipientId ?? null,
    a.roomId ?? null,
    a.type,
    a.refId ?? null,
    a.reaction ?? null,
    a.message ?? null,
    Date.now(),
  );
  return id;
}

interface ActivityRow {
  id: string;
  actor_id: string;
  recipient_id: string | null;
  room_id: string | null;
  type: Activity['type'];
  ref_id: string | null;
  reaction: ReactionKey | null;
  message: string | null;
  created_at: number;
  read_at: number | null;
  room_name: string | null;
  ref_title: string | null;
}

/**
 * Activity visible to the viewer: things addressed to them, things they did, and events in rooms
 * they belong to. Optional filters narrow to one room or to activity between two people.
 */
export async function listActivity(db: DB, viewerId: string, opts: { roomId?: string; withUserId?: string; limit?: number } = {}): Promise<Activity[]> {
  const rooms = await myRoomIds(db, viewerId);
  const where = [`(a.recipient_id = ? OR a.actor_id = ? ${rooms.length ? `OR a.room_id IN (${placeholders(rooms.length)})` : ''})`];
  const params: (string | number)[] = [viewerId, viewerId, ...rooms];
  if (opts.roomId) {
    where.push('a.room_id = ?');
    params.push(opts.roomId);
  }
  if (opts.withUserId) {
    where.push('(a.actor_id = ? OR a.recipient_id = ?)');
    params.push(opts.withUserId, opts.withUserId);
  }
  const rows = await all<ActivityRow>(
    db,
    `SELECT a.*, r.name AS room_name,
            COALESCE(t.title, rr.name) AS ref_title
       FROM activities a
       LEFT JOIN rooms r ON r.id = a.room_id
       LEFT JOIN topics t ON t.id = a.ref_id
       LEFT JOIN rooms rr ON rr.id = a.ref_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC LIMIT ?`,
    ...params,
    opts.limit ?? 30,
  );
  const users = await getUsers(db, [...new Set(rows.map((r) => r.actor_id))]);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actor: toPublicUser(users.get(r.actor_id)!),
    recipientId: r.recipient_id,
    roomId: r.room_id,
    roomName: r.room_name,
    reaction: r.reaction,
    message: r.message,
    refTitle: r.ref_title,
    createdAt: r.created_at,
    readAt: r.recipient_id === viewerId ? r.read_at : null,
  }));
}
