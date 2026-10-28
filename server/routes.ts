import { Router, type Request } from 'express';
import { get, newId, run, transaction, type DB } from './db.ts';
import { badRequest, conflict, parse } from './http.ts';
import { checkCredentials, endAuthSession, hashPassword, rateLimit, requireAuth, startAuthSession } from './auth.ts';
import type { RealtimeHub, Channel } from './realtime.ts';
import * as v from '../shared/validation.ts';
import { DEFAULT_ACCENT } from '../shared/theme.ts';
import { addMonths, isValidTimeZone, localDate } from '../shared/dates.ts';
import { REACTIONS } from '../shared/theme.ts';
import { circleOf, getUser, listActivity, liveStatus, myRoomIds, requireTopicAccess, roomMemberIds, toMe, toPublicUser, activeSessionRow } from './services/core.ts';
import * as rooms from './services/rooms.ts';
import * as sessions from './services/sessions.ts';
import * as plans from './services/plans.ts';
import * as tasks from './services/tasks.ts';
import * as social from './services/social.ts';

const EVERYTHING: Channel[] = ['me', 'friends', 'rooms', 'room', 'plans', 'calendar', 'activity', 'session', 'progress'];

export function apiRouter(db: DB, hub: RealtimeHub, opts: { secureCookies: boolean }) {
  const r = Router();
  const auth = requireAuth(db);
  const limiter = rateLimit(20, 60_000);

  // ── realtime fan-out helpers ──
  const notify = (userIds: Iterable<string>, keys: Channel[], extra: { roomId?: string; notice?: any } = {}) => hub.send(userIds, { keys, ...extra });
  /** Someone's work changed: they, their friends and their room partners refresh progress views. */
  const notifyWork = async (userId: string, roomId?: string) => {
    const audience = new Set(await circleOf(db, userId));
    if (roomId) for (const m of await roomMemberIds(db, roomId)) audience.add(m);
    notify(audience, ['session', 'friends', 'rooms', 'room', 'plans', 'progress', 'activity', 'calendar'], { roomId });
  };
  const notifyRoom = async (roomId: string, keys: Channel[] = ['rooms', 'room', 'activity']) => notify(await roomMemberIds(db, roomId), keys, { roomId });

  // ───────────── Auth ─────────────

  r.post('/auth/signup', limiter, async (req, res) => {
    const input = parse(v.signUpSchema, req.body);
    if (await get(db, 'SELECT 1 FROM users WHERE username = ?', input.username)) throw conflict('That username is taken. Try another one.', 'USERNAME_TAKEN');
    const id = newId();
    const tz = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
    await transaction(db, async () => {
      await run(
        db,
        'INSERT INTO users (id, username, display_name, profile_type, accent, bio, avatar, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        input.username,
        input.displayName,
        input.profileType,
        input.accent ?? DEFAULT_ACCENT[input.profileType],
        input.bio ?? '',
        JSON.stringify(input.avatar ?? { accessory: input.profileType === 'doctor' ? 'stethoscope' : input.profileType === 'engineer' ? 'glasses' : 'leaf' }),
        tz,
        Date.now(),
      );
      await run(db, 'INSERT INTO auth_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)', id, hashPassword(input.password), Date.now());
    });
    await startAuthSession(db, res, id, opts.secureCookies);
    res.status(201).json({ me: toMe(await getUser(db, id)) });
  });

  r.post('/auth/signin', limiter, async (req, res) => {
    const input = parse(v.signInSchema, req.body);
    const user = await get<{ id: string }>(db, 'SELECT id FROM users WHERE username = ?', input.username);
    if (!await checkCredentials(db, user?.id, input.password)) throw badRequest('That username and password do not match.', 'BAD_CREDENTIALS');
    await startAuthSession(db, res, user!.id, opts.secureCookies);
    res.json({ me: toMe(await getUser(db, user!.id)) });
  });

  r.post('/auth/signout', async (req, res) => {
    await endAuthSession(db, req, res);
    res.json({ ok: true });
  });

  // Everything below requires a signed-in user.
  r.use(auth);

  r.get('/events', (req, res) => hub.connect(req.userId, res));

  r.get('/me', async (req, res) => res.json({ me: toMe(await getUser(db, req.userId)) }));

  r.patch('/me', async (req, res) => {
    const input = parse(v.profileUpdateSchema, req.body);
    const u = await getUser(db, req.userId);
    if (input.timezone && !isValidTimeZone(input.timezone)) throw badRequest('Unknown time zone.');
    const typeChanged = input.profileType && input.profileType !== u.profile_type;
    await run(
      db,
      'UPDATE users SET display_name = ?, profile_type = ?, accent = ?, bio = ?, avatar = ?, color_scheme = ?, timezone = ?, share_status = ? WHERE id = ?',
      input.displayName ?? u.display_name,
      input.profileType ?? u.profile_type,
      input.accent ?? (typeChanged ? DEFAULT_ACCENT[input.profileType!] : u.accent),
      input.bio ?? u.bio,
      input.avatar ? JSON.stringify(input.avatar) : u.avatar,
      input.colorScheme ?? u.color_scheme,
      input.timezone ?? u.timezone,
      input.shareStatus === undefined ? u.share_status : input.shareStatus ? 1 : 0,
      req.userId,
    );
    notify(await circleOf(db, req.userId), EVERYTHING);
    res.json({ me: toMe(await getUser(db, req.userId)) });
  });

  r.get('/home', async (req, res) => res.json(await social.homeData(db, req.userId)));

  // ───────────── Friends ─────────────

  r.get('/users/search', async (req, res) => res.json({ results: await social.searchUsers(db, req.userId, String(req.query.q ?? '')) }));

  r.get('/friends', async (req, res) => res.json({ friends: await social.listFriends(db, req.userId), requests: await social.listRequests(db, req.userId) }));

  r.post('/friends/requests', async (req, res) => {
    const userId = String(req.body?.userId ?? '');
    if (!userId) throw badRequest('Choose someone to add.');
    const result = await social.sendFriendRequest(db, req.userId, userId);
    const me = await getUser(db, req.userId);
    notify([req.userId, userId], ['friends', 'activity', 'rooms'], {
      notice: { kind: 'friend', text: result.status === 'accepted' ? `${me.display_name} accepted your friend request` : `${me.display_name} sent you a friend request` },
    });
    res.status(201).json(result);
  });

  r.post('/friends/requests/:id/:action', async (req, res) => {
    const id = String(req.params.id);
    const action = req.params.action;
    let f;
    if (action === 'accept' || action === 'reject') f = await social.respondToRequest(db, req.userId, id, action === 'accept');
    else if (action === 'cancel') f = await social.cancelRequest(db, req.userId, id);
    else throw badRequest('Unknown action.');
    const me = await getUser(db, req.userId);
    notify([f.requester_id, f.recipient_id], ['friends', 'activity', 'rooms', 'calendar', 'plans'], {
      notice: action === 'accept' ? { kind: 'friend', text: `${me.display_name} accepted your friend request 🌱` } : undefined,
    });
    res.json({ ok: true });
  });

  r.get('/friends/:userId', async (req, res) => {
    const friendId = String(req.params.userId);
    await social.requireFriend(db, req.userId, friendId);
    const theirRooms = new Set(await myRoomIds(db, friendId));
    const shared = (await myRoomIds(db, req.userId)).filter((id) => theirRooms.has(id));
    res.json({
      user: toPublicUser(await getUser(db, friendId)),
      status: await liveStatus(db, req.userId, friendId),
      recentCompletions: await social.recentCompletions(db, req.userId, friendId, 10),
      rooms: (await rooms.listRooms(db, req.userId)).filter((room) => shared.includes(room.id)),
      activity: await listActivity(db, req.userId, { withUserId: friendId, limit: 20 }),
      stats: await social.progressStats(db, req.userId, friendId),
    });
  });

  r.post('/encourage', async (req, res) => {
    const input = parse(v.encourageSchema, req.body);
    const id = await social.encourage(db, req.userId, input);
    const me = await getUser(db, req.userId);
    const text = input.reaction ? `${REACTIONS[input.reaction].emoji} ${me.display_name}: ${REACTIONS[input.reaction].label}` : `💌 ${me.display_name}: ${input.message}`;
    notify([req.userId], ['activity']);
    notify([input.recipientId], ['activity', 'friends'], { notice: { kind: 'encouragement', text } });
    if (input.roomId) await notifyRoom(input.roomId, ['room', 'activity']);
    res.status(201).json({ id });
  });

  r.get('/activity', async (req, res) => res.json({ activity: await listActivity(db, req.userId, { limit: 40 }), unread: await social.unreadCount(db, req.userId) }));
  r.post('/activity/read', async (req, res) => {
    await social.markActivityRead(db, req.userId);
    notify([req.userId], ['activity']);
    res.json({ ok: true });
  });

  // ───────────── Rooms & topics ─────────────

  r.get('/rooms', async (req, res) => res.json({ rooms: await rooms.listRooms(db, req.userId) }));

  r.post('/rooms', async (req, res) => {
    const input = parse(v.roomCreateSchema, req.body);
    const id = await rooms.createRoom(db, req.userId, input);
    await notifyRoom(id, ['rooms', 'room', 'activity', 'plans', 'friends']);
    res.status(201).json({ id });
  });

  r.get('/rooms/:id', async (req, res) => res.json(await rooms.roomDetail(db, req.userId, String(req.params.id))));

  r.patch('/rooms/:id', async (req, res) => {
    const id = String(req.params.id);
    await rooms.updateRoom(db, req.userId, id, parse(v.roomUpdateSchema, req.body));
    await notifyRoom(id, ['rooms', 'room', 'calendar']);
    res.json({ ok: true });
  });

  r.post('/rooms/:id/topics', async (req, res) => {
    const roomId = String(req.params.id);
    const id = await rooms.createTopic(db, req.userId, roomId, parse(v.topicCreateSchema, req.body));
    await notifyRoom(roomId, ['rooms', 'room']);
    res.status(201).json({ id });
  });

  r.put('/rooms/:id/topics/order', async (req, res) => {
    const roomId = String(req.params.id);
    await rooms.reorderTopics(db, req.userId, roomId, parse(v.reorderSchema, req.body).topicIds);
    await notifyRoom(roomId, ['rooms', 'room']);
    res.json({ ok: true });
  });

  r.patch('/topics/:id', async (req, res) => {
    const id = String(req.params.id);
    await rooms.updateTopic(db, req.userId, id, parse(v.topicUpdateSchema, req.body));
    const { room } = await requireTopicAccess(db, id, req.userId);
    await notifyRoom(room.id, ['rooms', 'room', 'plans', 'calendar']);
    res.json({ ok: true });
  });

  r.delete('/topics/:id', async (req, res) => {
    const id = String(req.params.id);
    await rooms.archiveTopic(db, req.userId, id);
    const { room } = await requireTopicAccess(db, id, req.userId);
    await notifyRoom(room.id, ['rooms', 'room', 'plans', 'calendar']);
    res.json({ ok: true });
  });

  /** Complete a topic. If a session is running on it, that session is ended and saved first. */
  r.post('/topics/:id/complete', async (req, res) => {
    const id = String(req.params.id);
    const { room } = await requireTopicAccess(db, id, req.userId);
    const active = await activeSessionRow(db, req.userId);
    let result;
    if (active && active.topic_id === id) {
      const input = parse(v.sessionFinishSchema, req.body);
      result = await sessions.finishSession(db, req.userId, active.id, { ...input, completeTopic: true });
    } else {
      await rooms.completeTopic(db, req.userId, id);
      result = { session: null, completedTopic: true, nextTopic: await rooms.nextIncompleteTopic(db, req.userId, room.id, id), roomId: room.id };
    }
    await notifyWork(req.userId, room.id);
    const me = await getUser(db, req.userId);
    const topic = (await get<{ title: string }>(db, 'SELECT title FROM topics WHERE id = ?', id))!;
    notify(
      (await roomMemberIds(db, room.id)).filter((m) => m !== req.userId),
      ['room'],
      { roomId: room.id, notice: { kind: 'completion', text: `🌼 ${me.display_name} completed “${topic.title}”` } },
    );
    res.json(result);
  });

  r.post('/topics/:id/reopen', async (req, res) => {
    const id = String(req.params.id);
    const mode = req.body?.mode === 'undo' ? 'undo' : 'revise';
    await rooms.reopenTopic(db, req.userId, id, mode);
    const { room } = await requireTopicAccess(db, id, req.userId);
    await notifyWork(req.userId, room.id);
    res.json({ ok: true });
  });

  r.get('/topics/:id', async (req, res) => {
    const { topic, room } = await requireTopicAccess(db, String(req.params.id), req.userId);
    res.json({ topicId: topic.id, roomId: room.id, roomName: room.name });
  });

  r.get('/topics/:id/history', async (req, res) => res.json(await rooms.topicHistory(db, req.userId, String(req.params.id))));

  // ───────────── Study sessions (timer) ─────────────

  r.get('/sessions/active', async (req, res) => res.json({ session: await sessions.getActiveSession(db, req.userId) }));

  r.get('/sessions', async (req, res) => res.json({ sessions: await sessions.listSessions(db, req.userId) }));

  r.post('/sessions', async (req, res) => {
    const session = await sessions.startSession(db, req.userId, parse(v.sessionStartSchema, req.body));
    await notifyWork(req.userId, session.roomId);
    res.status(201).json({ session });
  });

  r.post('/sessions/:id/:action', async (req, res) => {
    const id = String(req.params.id);
    const action = req.params.action;
    if (action === 'pause' || action === 'resume') {
      const session = action === 'pause' ? await sessions.pauseSession(db, req.userId, id) : await sessions.resumeSession(db, req.userId, id);
      await notifyWork(req.userId, session.roomId);
      return res.json({ session });
    }
    if (action === 'finish') {
      const result = await sessions.finishSession(db, req.userId, id, parse(v.sessionFinishSchema, req.body));
      await notifyWork(req.userId, result.roomId);
      return res.json(result);
    }
    if (action === 'discard') {
      await sessions.discardSession(db, req.userId, id);
      await notifyWork(req.userId);
      return res.json({ ok: true });
    }
    if (action === 'correct') {
      const input = parse(v.sessionCorrectSchema, req.body);
      const session = await sessions.correctSession(db, req.userId, id, input.minutes, input.reason);
      await notifyWork(req.userId, session.roomId);
      return res.json({ session });
    }
    throw badRequest('Unknown action.');
  });

  r.patch('/sessions/:id', async (req, res) => {
    await sessions.updateSessionSettings(db, req.userId, String(req.params.id), parse(v.sessionUpdateSchema, req.body));
    notify([req.userId], ['session']);
    res.json({ ok: true });
  });

  // ───────────── Goals (plans → sprints → days → tasks) ─────────────

  // A plan change can show up in a room (pulled sprints), so friends refetch too. Events carry no data.
  const notifyPlan = async (req: Request) => notify(await circleOf(db, req.userId), ['plans', 'room', 'rooms', 'session', 'progress', 'calendar']);
  const sprintNumber = (req: Request) => Number.parseInt(String(req.params.n), 10);

  r.get('/plans', async (req, res) => res.json({ plans: await plans.listPlans(db, req.userId) }));
  r.get('/plans/:id', async (req, res) => res.json({ plan: await plans.getPlan(db, req.userId, String(req.params.id)) }));

  r.post('/plans', async (req, res) => {
    const id = await plans.createPlan(db, req.userId, parse(v.planCreateSchema, req.body));
    await notifyPlan(req);
    res.status(201).json({ id });
  });

  r.patch('/plans/:id', async (req, res) => {
    await plans.updatePlan(db, req.userId, String(req.params.id), parse(v.planUpdateSchema, req.body));
    await notifyPlan(req);
    res.json({ ok: true });
  });

  r.post('/plans/:id/sprints', async (req, res) => {
    const number = await plans.addSprint(db, req.userId, String(req.params.id), parse(v.sprintCreateSchema, req.body).days);
    await notifyPlan(req);
    res.status(201).json({ number });
  });

  r.patch('/plans/:id/sprints/:n', async (req, res) => {
    await plans.resizeSprint(db, req.userId, String(req.params.id), sprintNumber(req), parse(v.sprintUpdateSchema, req.body).days);
    await notifyPlan(req);
    res.json({ ok: true });
  });

  r.delete('/plans/:id/sprints/:n', async (req, res) => {
    await plans.removeSprint(db, req.userId, String(req.params.id), sprintNumber(req));
    await notifyPlan(req);
    res.json({ ok: true });
  });

  r.post('/plans/:id/sprints/:n/unpull', async (req, res) => {
    const roomId = await plans.unpullSprint(db, req.userId, String(req.params.id), sprintNumber(req));
    await notifyPlan(req);
    if (roomId) await notifyRoom(roomId, ['rooms', 'room', 'plans']);
    res.json({ ok: true });
  });

  r.post('/plans/:id/sprints/:n/pull', async (req, res) => {
    const roomId = await plans.pullSprint(db, req.userId, String(req.params.id), sprintNumber(req), parse(v.pullSprintSchema, req.body).roomId);
    await notifyPlan(req);
    await notifyRoom(roomId, ['rooms', 'room', 'plans']);
    res.json({ roomId });
  });

  r.post('/plans/:id/sprints/:n/:action', async (req, res) => {
    const action = req.params.action;
    if (action !== 'complete' && action !== 'reopen') throw badRequest('Unknown action.');
    await plans.setSprintCompleted(db, req.userId, String(req.params.id), sprintNumber(req), action === 'complete');
    await notifyPlan(req);
    res.json({ ok: true });
  });

  r.post('/plans/:id/tasks', async (req, res) => {
    const id = await plans.addTask(db, req.userId, String(req.params.id), parse(v.planTaskCreateSchema, req.body));
    await notifyPlan(req);
    res.status(201).json({ id });
  });

  r.patch('/plan-tasks/:id', async (req, res) => {
    await plans.updateTask(db, req.userId, String(req.params.id), parse(v.planTaskUpdateSchema, req.body));
    await notifyPlan(req);
    res.json({ ok: true });
  });

  r.delete('/plan-tasks/:id', async (req, res) => {
    await plans.removeTask(db, req.userId, String(req.params.id));
    await notifyPlan(req);
    res.json({ ok: true });
  });

  // ───────────── Tasks / calendar ─────────────

  // Friends refetch too (a task may be shared with them). Events carry no task data.
  const notifyTask = async (req: Request) => notify(await circleOf(db, req.userId), ['calendar', 'session', 'progress']);

  r.get('/tasks', async (req, res) => {
    const today = localDate(Date.now(), (await getUser(db, req.userId)).timezone);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : addMonths(today, -1);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? String(req.query.to) : addMonths(today, 2);
    const planned = await plans.calendarPlanItems(db, req.userId, from, to, { friends: true });
    res.json({ tasks: await tasks.listTasks(db, req.userId, from, to), planItems: planned.items, sprints: planned.sprints });
  });

  r.post('/tasks', async (req, res) => {
    const id = await tasks.createTask(db, req.userId, parse(v.taskCreateSchema, req.body));
    await notifyTask(req);
    res.status(201).json({ task: await tasks.getTask(db, req.userId, id) });
  });

  r.patch('/tasks/:id', async (req, res) => {
    const id = String(req.params.id);
    await tasks.updateTask(db, req.userId, id, parse(v.taskUpdateSchema, req.body));
    await notifyTask(req);
    res.json({ task: await tasks.getTask(db, req.userId, id) });
  });

  r.delete('/tasks/:id', async (req, res) => {
    const id = String(req.params.id);
    await tasks.archiveTask(db, req.userId, id);
    await notifyTask(req);
    res.json({ ok: true });
  });

  // ───────────── Progress ─────────────

  r.get('/progress', async (req, res) => {
    const userId = req.query.userId ? String(req.query.userId) : req.userId;
    res.json({ stats: await social.progressStats(db, req.userId, userId) });
  });

  return r;
}
