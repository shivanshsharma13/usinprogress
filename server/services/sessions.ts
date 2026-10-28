// Study-session (timer) service. The server's timestamps are the source of truth:
// start/pause/resume/finish each write a timestamp, and focused time is always derived from them.
import { all, get, newId, run, transaction, type DB } from '../db.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import { focusedMs, LONG_SESSION_MS } from '../../shared/timer.ts';
import { localDate } from '../../shared/dates.ts';
import type { ActiveSession, SessionRecord } from '../../shared/types.ts';
import { activeSessionRow, getUser, pausesFor, requireOwnTopic, type SessionRow } from './core.ts';
import { completeTopic, ensureProgress, nextIncompleteTopic } from './rooms.ts';

export async function toActiveSession(db: DB, s: SessionRow): Promise<ActiveSession> {
  const names = (await get<{ topic: string; room: string }>(db, 'SELECT t.title AS topic, r.name AS room FROM topics t JOIN rooms r ON r.id = t.room_id WHERE t.id = ?', s.topic_id))!;
  return {
    id: s.id,
    roomId: s.room_id,
    roomName: names.room,
    topicId: s.topic_id,
    topicTitle: names.topic,
    state: s.state as 'running' | 'paused',
    startedAt: s.started_at,
    pauses: await pausesFor(db, s.id),
    targetMinutes: s.target_minutes,
    remindAfterHour: Boolean(s.remind_after_hour),
    isRevision: Boolean(s.is_revision),
    taskId: s.task_id,
  };
}

export async function getActiveSession(db: DB, userId: string): Promise<ActiveSession | null> {
  const s = await activeSessionRow(db, userId);
  return s ? await toActiveSession(db, s) : null;
}

async function ownSession(db: DB, userId: string, sessionId: string): Promise<SessionRow> {
  const s = await get<SessionRow>(db, 'SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, userId);
  if (!s) throw notFound('That study session could not be found.');
  return s;
}

export async function startSession(
  db: DB,
  userId: string,
  input: { topicId: string; targetMinutes?: number | null; remindAfterHour?: boolean; taskId?: string | null },
): Promise<ActiveSession> {
  const { topic, room } = await requireOwnTopic(db, input.topicId, userId);
  if (topic.status !== 'active') throw badRequest('This topic is archived.');
  if (room.status !== 'active') throw badRequest('This room is archived.');
  if (input.taskId) {
    const task = await get(db, 'SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?', input.taskId, userId);
    if (!task) throw notFound('That task could not be found.');
  }
  return await transaction(db, async () => {
    const existing = await activeSessionRow(db, userId);
    if (existing) {
      // Retrying the same start (e.g. after a dropped response) just returns the running session.
      if (existing.topic_id === input.topicId) return toActiveSession(db, existing);
      throw conflict('You already have a session running. Finish it before starting another.', 'SESSION_ACTIVE', await toActiveSession(db, existing));
    }
    await ensureProgress(db, topic.id, userId);
    const progress = (await get<{ status: string }>(db, 'SELECT status FROM topic_progress WHERE topic_id = ? AND user_id = ?', topic.id, userId))!;
    const now = Date.now();
    let isRevision = progress.status === 'revising';
    if (progress.status === 'completed') {
      // Studying a finished topic again is revision; the original completion stays on record.
      isRevision = true;
      await run(db, "UPDATE topic_progress SET status = 'revising', updated_at = ? WHERE topic_id = ? AND user_id = ?", now, topic.id, userId);
      await run(db, "INSERT INTO topic_events (id, topic_id, user_id, type, detail, created_at) VALUES (?, ?, ?, 'reopened_for_revision', '{}', ?)", newId(), topic.id, userId, now);
    } else if (progress.status === 'not_started') {
      await run(db, "UPDATE topic_progress SET status = 'in_progress', updated_at = ? WHERE topic_id = ? AND user_id = ?", now, topic.id, userId);
    }
    const id = newId();
    await run(
      db,
      `INSERT INTO study_sessions (id, user_id, room_id, topic_id, task_id, state, started_at, target_minutes, remind_after_hour, is_revision, local_date, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      room.id,
      topic.id,
      input.taskId ?? null,
      now,
      input.targetMinutes ?? topic.session_target_minutes ?? null,
      input.remindAfterHour ? 1 : 0,
      isRevision ? 1 : 0,
      localDate(now, (await getUser(db, userId)).timezone),
      now,
    );
    return toActiveSession(db, await ownSession(db, userId, id));
  });
}

/** Pause and resume are idempotent so a repeated tap or retry never corrupts the timeline. */
export async function pauseSession(db: DB, userId: string, sessionId: string): Promise<ActiveSession> {
  return await transaction(db, async () => {
    const s = await ownSession(db, userId, sessionId);
    if (s.state === 'paused') return toActiveSession(db, s);
    if (s.state !== 'running') throw badRequest('This session has already ended.', 'SESSION_ENDED');
    const now = Date.now();
    await run(db, 'INSERT INTO session_pauses (session_id, paused_at) VALUES (?, ?)', s.id, now);
    await run(db, "UPDATE study_sessions SET state = 'paused' WHERE id = ?", s.id);
    return toActiveSession(db, { ...s, state: 'paused' });
  });
}

export async function resumeSession(db: DB, userId: string, sessionId: string): Promise<ActiveSession> {
  return await transaction(db, async () => {
    const s = await ownSession(db, userId, sessionId);
    if (s.state === 'running') return toActiveSession(db, s);
    if (s.state !== 'paused') throw badRequest('This session has already ended.', 'SESSION_ENDED');
    await run(db, 'UPDATE session_pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL', Date.now(), s.id);
    await run(db, "UPDATE study_sessions SET state = 'running' WHERE id = ?", s.id);
    return toActiveSession(db, { ...s, state: 'running' });
  });
}

export interface FinishResult {
  session: SessionRecord;
  completedTopic: boolean;
  nextTopic: { id: string; title: string } | null;
  roomId: string;
}

/**
 * Ends a session and saves its focused time. With completeTopic, also marks the topic complete
 * for this user and picks the next incomplete topic (without starting it).
 *
 * Retrying a finish on an already-finished session returns the saved result instead of adding
 * time again. Sessions over LONG_SESSION_MS need confirmLong or a corrected duration.
 */
export async function finishSession(
  db: DB,
  userId: string,
  sessionId: string,
  input: { completeTopic?: boolean; confirmLong?: boolean; correctedMinutes?: number; note?: string },
): Promise<FinishResult> {
  return await transaction(db, async () => {
    const s = await ownSession(db, userId, sessionId);
    if (s.state === 'running' || s.state === 'paused') {
      const now = Date.now();
      const pauses = await pausesFor(db, s.id);
      const measured = focusedMs({ startedAt: s.started_at, endedAt: now, pauses }, now);
      if (measured > LONG_SESSION_MS && !input.confirmLong && input.correctedMinutes === undefined) {
        throw conflict('This session ran for a long time. Please confirm or correct it.', 'LONG_SESSION', { measuredMs: measured });
      }
      const focused = input.correctedMinutes !== undefined ? input.correctedMinutes * 60_000 : measured;
      await run(db, 'UPDATE session_pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL', now, s.id);
      await run(
        db,
        "UPDATE study_sessions SET state = 'finished', ended_at = ?, focused_ms = ?, measured_ms = ?, note = ? WHERE id = ?",
        now,
        focused,
        measured,
        input.note ?? s.note,
        s.id,
      );
      if (focused !== measured) {
        await run(
          db,
          'INSERT INTO session_corrections (id, session_id, user_id, old_ms, new_ms, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(),
          s.id,
          userId,
          measured,
          focused,
          'Corrected when finishing',
          now,
        );
      }
    } else if (s.state === 'discarded') {
      throw badRequest('This session was discarded.', 'SESSION_ENDED');
    }
    let completed = false;
    if (input.completeTopic) {
      completed = !(await completeTopic(db, userId, s.topic_id)).alreadyCompleted;
    }
    const after = await get<{ status: string }>(db, 'SELECT status FROM topic_progress WHERE topic_id = ? AND user_id = ?', s.topic_id, userId);
    return {
      session: await sessionRecord(db, await ownSession(db, userId, s.id)),
      completedTopic: completed || after?.status === 'completed',
      nextTopic: input.completeTopic ? await nextIncompleteTopic(db, userId, s.room_id, s.topic_id) : null,
      roomId: s.room_id,
    };
  });
}

/** For an accidental session: keeps the row for audit, but it no longer counts. */
export async function discardSession(db: DB, userId: string, sessionId: string) {
  await transaction(db, async () => {
    const s = await ownSession(db, userId, sessionId);
    if (s.state === 'discarded') return;
    const now = Date.now();
    const measured = s.measured_ms ?? focusedMs({ startedAt: s.started_at, endedAt: s.ended_at ?? now, pauses: await pausesFor(db, s.id) }, now);
    await run(db, 'UPDATE session_pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL', now, s.id);
    await run(db, "UPDATE study_sessions SET state = 'discarded', ended_at = COALESCE(ended_at, ?), measured_ms = ?, focused_ms = 0 WHERE id = ?", now, measured, s.id);
    await run(
      db,
      'INSERT INTO session_corrections (id, session_id, user_id, old_ms, new_ms, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(),
      s.id,
      userId,
      s.focused_ms ?? measured,
      0,
      'Discarded',
      now,
    );
  });
}

export async function correctSession(db: DB, userId: string, sessionId: string, minutes: number, reason?: string): Promise<SessionRecord> {
  return await transaction(db, async () => {
    const s = await ownSession(db, userId, sessionId);
    if (s.state !== 'finished') throw badRequest('Only finished sessions can be corrected.');
    const newMs = minutes * 60_000;
    await run(
      db,
      'INSERT INTO session_corrections (id, session_id, user_id, old_ms, new_ms, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(),
      s.id,
      userId,
      s.focused_ms ?? 0,
      newMs,
      reason ?? '',
      Date.now(),
    );
    await run(db, 'UPDATE study_sessions SET focused_ms = ? WHERE id = ?', newMs, s.id);
    return sessionRecord(db, await ownSession(db, userId, s.id));
  });
}

/** Note, one-hour reminder, or session length (changeable mid-session; time already focused is untouched). */
export async function updateSessionSettings(db: DB, userId: string, sessionId: string, input: { note?: string; remindAfterHour?: boolean; targetMinutes?: number | null }) {
  const s = await ownSession(db, userId, sessionId);
  await run(
    db,
    'UPDATE study_sessions SET note = ?, remind_after_hour = ?, target_minutes = ? WHERE id = ?',
    input.note ?? s.note,
    input.remindAfterHour === undefined ? s.remind_after_hour : input.remindAfterHour ? 1 : 0,
    input.targetMinutes === undefined ? s.target_minutes : input.targetMinutes,
    sessionId,
  );
}

async function sessionRecord(db: DB, s: SessionRow): Promise<SessionRecord> {
  const names = (await get<{ topic: string; room: string }>(db, 'SELECT t.title AS topic, r.name AS room FROM topics t JOIN rooms r ON r.id = t.room_id WHERE t.id = ?', s.topic_id))!;
  const live = s.state === 'running' || s.state === 'paused';
  return {
    id: s.id,
    roomId: s.room_id,
    roomName: names.room,
    topicId: s.topic_id,
    topicTitle: names.topic,
    state: s.state,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    focusedMs: live ? focusedMs({ startedAt: s.started_at, endedAt: null, pauses: await pausesFor(db, s.id) }, Date.now()) : (s.focused_ms ?? 0),
    measuredMs: s.measured_ms,
    isRevision: Boolean(s.is_revision),
    note: s.note,
    corrections: (await all<{ old_ms: number; new_ms: number; reason: string; created_at: number }>(
      db,
      'SELECT old_ms, new_ms, reason, created_at FROM session_corrections WHERE session_id = ? ORDER BY created_at',
      s.id,
    )).map((c) => ({ oldMs: c.old_ms, newMs: c.new_ms, reason: c.reason, createdAt: c.created_at })),
  };
}

/** The user's own session history (never exposed to anyone else). */
export async function listSessions(db: DB, userId: string, limit = 50): Promise<SessionRecord[]> {
  const rows = await all<SessionRow>(db, 'SELECT * FROM study_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?', userId, limit);
  return Promise.all(rows.map((s) => sessionRecord(db, s)));
}
