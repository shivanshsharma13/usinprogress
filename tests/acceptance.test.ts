// End-to-end acceptance tests against the real HTTP API (spec section 17).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, closeClients, emailFor, signUp, sleep, startServer, type TestServer } from './helpers.ts';
import { addDays, startOfWeek } from '../shared/dates.ts';

let srv: TestServer;
let A: Client; // engineer
let B: Client; // doctor
let C: Client; // a stranger
let a: any, b: any, c: any;
let roomId: string;
let room2Id: string;
const topics: string[] = []; // A's topics
const bTopics: string[] = []; // B's topics

const today = new Date().toISOString().slice(0, 10); // users are in UTC

before(async () => {
  srv = await startServer();
});
after(async () => {
  await closeClients();
  await srv.close();
});

// ───────────── Account and friendship ─────────────

test('two users can create accounts and sign in', async () => {
  ({ client: A, me: a } = await signUp(srv.base, 'asha', 'engineer'));
  ({ client: B, me: b } = await signUp(srv.base, 'mira', 'doctor'));
  ({ client: C, me: c } = await signUp(srv.base, 'stranger', 'custom'));
  assert.equal(a.accent, 'blue');
  assert.equal(b.accent, 'pink');

  const fresh = new Client(srv.base);
  assert.equal((await fresh.get('/me')).status, 401);
  assert.equal((await fresh.post('/auth/signin', { email: emailFor('asha'), password: 'wrong password' })).status, 400);
  const ok = await fresh.post('/auth/signin', { email: emailFor('ASHA'), password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.equal((await fresh.get('/me')).body.me.id, a.id);

  // Duplicate usernames (case-insensitively) and duplicate emails are rejected.
  const dup = await new Client(srv.base).post('/auth/signup', { email: 'someone@example.com', username: 'Asha', password: 'whatever123', displayName: 'X', profileType: 'custom' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'USERNAME_TAKEN');
  const dupEmail = await new Client(srv.base).post('/auth/signup', { email: emailFor('asha'), username: 'asha2', password: 'whatever123', displayName: 'X', profileType: 'custom' });
  assert.notEqual(dupEmail.status, 201);

  // Passwords and emails live only in Supabase Auth (bcrypt-hashed), never in the app's tables.
  const cols = (await srv.db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles' AND table_schema = 'public'")).map((r: any) => r.column_name);
  assert.ok(!cols.some((n: string) => n.includes('pass') || n.includes('email')));
  const cred = (await srv.db.query('SELECT encrypted_password FROM auth.users WHERE id = ?', [a.id]))[0] as any;
  assert.match(cred.encrypted_password, /^\$2[aby]\$/);
  assert.ok(!cred.encrypted_password.includes('correct horse'));

  // Signing out invalidates the session server-side.
  await fresh.post('/auth/signout');
  assert.equal((await fresh.get('/me')).status, 401);
});

test('users find each other, send, guard and accept a friend request', async () => {
  const search = await A.get('/users/search?q=mi');
  assert.equal(search.body.results[0].user.username, 'mira');
  assert.equal(search.body.results[0].relation, 'none');

  const sent = await A.post('/friends/requests', { userId: b.id });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.status, 'pending');
  // Duplicate requests are prevented.
  assert.equal((await A.post('/friends/requests', { userId: b.id })).status, 409);
  // Only the recipient can accept.
  assert.equal((await A.post(`/friends/requests/${sent.body.id}/accept`)).status, 403);
  assert.equal((await C.post(`/friends/requests/${sent.body.id}/accept`)).status, 404);

  const incoming = await B.get('/friends');
  assert.equal(incoming.body.requests[0].direction, 'incoming');
  assert.equal((await B.post(`/friends/requests/${sent.body.id}/accept`)).status, 200);
  // Answering twice is an invalid transition.
  assert.equal((await B.post(`/friends/requests/${sent.body.id}/reject`)).status, 409);
  // A new request between friends is a duplicate friendship.
  assert.equal((await B.post('/friends/requests', { userId: a.id })).status, 409);

  assert.equal((await A.get('/friends')).body.friends[0].user.id, b.id);
  assert.equal((await B.get('/friends')).body.friends[0].user.id, a.id);

  // Reject path works too, and a rejected pair can try again later.
  const r = await C.post('/friends/requests', { userId: a.id });
  assert.equal((await A.post(`/friends/requests/${r.body.id}/reject`)).status, 200);
  assert.equal((await A.get('/friends')).body.friends.length, 1);
});

// ───────────── Rooms and topics ─────────────

test('only accepted friends can create private rooms; rooms have exactly two members', async () => {
  const bad = await C.post('/rooms', { friendId: a.id, name: 'Sneaky', startDate: today, endDate: addDays(today, 90) });
  assert.equal(bad.status, 403);

  const r1 = await A.post('/rooms', { friendId: b.id, name: 'Our 90-Day Growth Plan', startDate: today, endDate: addDays(today, 90) });
  assert.equal(r1.status, 201);
  roomId = r1.body.id;
  const r2 = await B.post('/rooms', { friendId: a.id, name: 'Biochemistry Revision', startDate: today, endDate: addDays(today, 120) });
  room2Id = r2.body.id;

  assert.equal((await A.get('/rooms')).body.rooms.length, 2);
  assert.equal((await B.get('/rooms')).body.rooms.length, 2);
  assert.equal((await C.get(`/rooms/${roomId}`)).status, 404);
  assert.equal((await C.post(`/rooms/${roomId}/topics`, { title: 'x' })).status, 404);

  // The database itself refuses a third member.
  await assert.rejects(srv.db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, c.id, Date.now()]), /ROOM_FULL/);
});

test('each member adds, edits and reorders their own topics; the partner can only see them', async () => {
  for (const [title, est] of [
    ['Arrays', 120],
    ['Binary Search', 180],
    ['Linked Lists', 120],
    ['Trees', 300],
  ] as const) {
    const res = await A.post(`/rooms/${roomId}/topics`, { title, estimatedMinutes: est, sessionTargetMinutes: 45 });
    assert.equal(res.status, 201);
    topics.push(res.body.id);
  }
  for (const title of ['Enzyme kinetics', 'Carbohydrate metabolism']) bTopics.push((await B.post(`/rooms/${roomId}/topics`, { title })).body.id);

  assert.equal((await A.patch(`/topics/${topics[0]}`, { title: 'Arrays & Strings' })).status, 200);
  assert.equal((await A.put(`/rooms/${roomId}/topics/order`, { topicIds: [topics[0], topics[1], topics[3], topics[2]] })).status, 200);
  const room = (await B.get(`/rooms/${roomId}`)).body;
  const aTitles = room.topics.filter((t: any) => t.createdBy === a.id).map((t: any) => t.title);
  assert.deepEqual(aTitles, ['Arrays & Strings', 'Binary Search', 'Trees', 'Linked Lists']);
  assert.equal(room.topics.find((t: any) => t.id === topics[0]).estimatedMinutes, 120);
  await A.put(`/rooms/${roomId}/topics/order`, { topicIds: topics });

  // The partner can see A's topics but cannot edit, reorder, archive, complete or study them.
  assert.equal((await B.patch(`/topics/${topics[0]}`, { title: 'Hijacked' })).status, 403);
  assert.equal((await B.put(`/rooms/${roomId}/topics/order`, { topicIds: topics })).status, 400);
  assert.equal((await B.del(`/topics/${topics[0]}`)).status, 403);
  assert.equal((await B.post(`/topics/${topics[0]}/complete`)).status, 403);
  assert.equal((await B.post(`/topics/${topics[0]}/reopen`, { mode: 'revise' })).status, 403);
  assert.equal((await B.post('/sessions', { topicId: topics[0] })).status, 403);
  assert.equal((await A.post('/sessions', { topicId: bTopics[0] })).status, 403);
  assert.equal((await B.post('/tasks', { title: 'x', date: today, topicId: topics[0] })).status, 400);
  assert.equal((await A.get(`/rooms/${roomId}`)).body.topics.find((t: any) => t.id === topics[0]).title, 'Arrays & Strings');
});

// ───────────── Timer ─────────────

test('starting a topic creates a persistent session the partner sees live', async () => {
  const stream = await B.listen();
  const start = await A.post('/sessions', { topicId: topics[0] });
  assert.equal(start.status, 201);
  assert.equal(start.body.session.state, 'running');
  await stream.waitFor((e) => e.table === 'presence' && e.row.user_id === a.id);
  stream.stop();

  const friend = (await B.get('/friends')).body.friends[0];
  assert.equal(friend.status.state, 'studying');
  assert.equal(friend.status.topicTitle, 'Arrays & Strings');

  // A retried start (e.g. after a dropped response) does not create a duplicate.
  const again = await A.post('/sessions', { topicId: topics[0] });
  assert.equal(again.body.session.id, start.body.session.id);
  // A different topic while one is running is refused.
  const other = await A.post('/sessions', { topicId: topics[1] });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'SESSION_ACTIVE');
  const count = (await srv.db.query("SELECT COUNT(*) AS n FROM study_sessions WHERE user_id = ? AND state IN ('running','paused')", [a.id]))[0] as any;
  assert.equal(count.n, 1);
});

test('pausing stops focused time; resuming continues the same session; refresh recovers it', async () => {
  const { session } = (await A.get('/sessions/active')).body;
  await sleep(150);
  const paused = (await A.post(`/sessions/${session.id}/pause`)).body.session;
  assert.equal(paused.state, 'paused');
  // Pausing twice is harmless.
  assert.equal((await A.post(`/sessions/${session.id}/pause`)).status, 200);
  assert.equal((await B.get('/friends')).body.friends[0].status.state, 'paused');

  await sleep(400); // paused time must not count

  const resumed = (await A.post(`/sessions/${session.id}/resume`)).body.session;
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.state, 'running');

  // "Refresh": a brand-new client for the same account recovers the session from the server.
  const refreshed = (await A.get('/sessions/active')).body.session;
  assert.equal(refreshed.id, session.id);
  assert.equal(refreshed.pauses.length, 1);
  assert.ok(refreshed.pauses[0].resumedAt >= refreshed.pauses[0].pausedAt + 350);
});

test('completing a topic saves the session, marks it complete and selects the next topic without starting it', async () => {
  const { session } = (await A.get('/sessions/active')).body;
  const done = await A.post(`/topics/${topics[0]}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.body.completedTopic, true);
  assert.equal(done.body.session.id, session.id);
  assert.equal(done.body.session.state, 'finished');
  // Focused time is exactly the wall time minus the pause (which lasted at least 400ms), whatever the latency.
  const { startedAt, endedAt, focusedMs } = done.body.session;
  const pause = (await srv.db.query('SELECT paused_at, resumed_at FROM session_pauses WHERE session_id = ?', [session.id]))[0];
  assert.ok(pause.resumed_at - pause.paused_at >= 400);
  assert.equal(focusedMs, endedAt - startedAt - (pause.resumed_at - pause.paused_at), `focused ${focusedMs}`);
  assert.ok(focusedMs >= 100, `focused ${focusedMs}`);
  assert.equal(done.body.nextTopic.id, topics[1]);
  assert.equal((await A.get('/sessions/active')).body.session, null);

  // The partner sees A's progress; each member's totals count only their own topics.
  const room = (await B.get(`/rooms/${roomId}`)).body;
  const t0 = room.topics.find((t: any) => t.id === topics[0]);
  assert.equal(t0.progress[a.id].status, 'completed');
  assert.equal(t0.progress[b.id], undefined);
  assert.equal(t0.progress[a.id].sessions, 1);
  const [mine, partner] = room.members;
  assert.equal(mine.user.id, b.id);
  assert.equal(mine.completed, 0);
  assert.equal(mine.total, 2);
  assert.equal(partner.completed, 1);
  assert.equal(partner.total, 4);

  // Retrying the completion does not double count.
  await A.post(`/topics/${topics[0]}/complete`);
  const n = (await srv.db.query("SELECT COUNT(*) AS n FROM topic_completions WHERE user_id = ? AND topic_id = ? AND revoked_at IS NULL", [a.id, topics[0]]))[0] as any;
  assert.equal(n.n, 1);
});

test('finishing a session without completing keeps the topic incomplete, and retries do not add time', async () => {
  const s = (await A.post('/sessions', { topicId: topics[1] })).body.session;
  await sleep(60);
  const fin = await A.post(`/sessions/${s.id}/finish`, {});
  assert.equal(fin.status, 200);
  assert.equal(fin.body.completedTopic, false);
  const ms = fin.body.session.focusedMs;
  await sleep(60);
  const retry = await A.post(`/sessions/${s.id}/finish`, {});
  assert.equal(retry.body.session.focusedMs, ms);
  const t1 = (await A.get(`/rooms/${roomId}`)).body.topics.find((t: any) => t.id === topics[1]);
  assert.equal(t1.progress[a.id].status, 'in_progress');
  assert.equal(t1.progress[a.id].focusedMs, ms);
});

test('one member cannot complete or change the other member’s records', async () => {
  // Completion endpoints only ever act on the caller. C (non-member) is refused entirely.
  assert.equal((await C.post(`/topics/${topics[1]}/complete`)).status, 404);
  const s = (await A.post('/sessions', { topicId: topics[1] })).body.session;
  assert.equal((await B.post(`/sessions/${s.id}/finish`, { completeTopic: true })).status, 404);
  assert.equal((await B.post(`/sessions/${s.id}/pause`)).status, 404);
  await A.post(`/sessions/${s.id}/discard`);
  assert.equal((await A.get('/sessions/active')).body.session, null);
  // Discarded sessions are kept for audit but add no time.
  const row = (await srv.db.query('SELECT state, focused_ms FROM study_sessions WHERE id = ?', [s.id]))[0] as any;
  assert.deepEqual({ ...row }, { state: 'discarded', focused_ms: 0 });
  // B can't read A's session history.
  const bs = (await B.get('/sessions')).body.sessions;
  assert.ok(bs.every((x: any) => x.id !== s.id));
});

test('very long sessions must be confirmed or corrected, with an audit trail', async () => {
  const s = (await A.post('/sessions', { topicId: topics[2] })).body.session;
  await srv.db.query('UPDATE study_sessions SET started_at = started_at - ? WHERE id = ?', [5 * 3600_000, s.id]);
  const first = await A.post(`/sessions/${s.id}/finish`, {});
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'LONG_SESSION');
  assert.ok(first.body.error.data.measuredMs > 5 * 3600_000 - 1000);
  // The session is still active after the refusal.
  assert.equal((await A.get('/sessions/active')).body.session.id, s.id);
  const fixed = await A.post(`/sessions/${s.id}/finish`, { correctedMinutes: 50 });
  assert.equal(fixed.body.session.focusedMs, 50 * 60_000);
  assert.equal(fixed.body.session.corrections.length, 1);
  assert.ok(fixed.body.session.measuredMs > 5 * 3600_000 - 1000);
  // Later correction is also audited.
  const again = await A.post(`/sessions/${s.id}/correct`, { minutes: 40, reason: 'Took a long break' });
  assert.equal(again.body.session.focusedMs, 40 * 60_000);
  assert.equal(again.body.session.corrections.length, 2);
});

test('a long session can be saved as a list of tasks, each with its own minutes', async () => {
  const own = (await A.post(`/rooms/${roomId}/topics`, { title: 'Split: graphs' })).body.id;
  const other = (await A.post(`/rooms/${roomId}/topics`, { title: 'Split: trees' })).body.id;
  const s = (await A.post('/sessions', { topicId: own })).body.session;
  await srv.db.query('UPDATE study_sessions SET started_at = started_at - ? WHERE id = ?', [5 * 3600_000, s.id]);

  // More than the timer measured is refused, and the session keeps running.
  const tooMuch = await A.post(`/sessions/${s.id}/split`, { parts: [{ topicId: own, minutes: 200 }, { topicId: other, minutes: 200 }] });
  assert.equal(tooMuch.status, 400);
  assert.equal((await A.get('/sessions/active')).body.session.id, s.id);
  // Someone else's topic can't be listed.
  const theirs = await A.post(`/sessions/${s.id}/split`, { parts: [{ topicId: bTopics[0], minutes: 10 }] });
  assert.ok(theirs.status >= 400);

  const r = await A.post(`/sessions/${s.id}/split`, {
    completeTopic: true,
    parts: [{ topicId: own, minutes: 90 }, { topicId: other, minutes: 45 }, { title: 'Read the DP chapter', minutes: 30 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.session.focusedMs, 90 * 60_000);
  assert.equal(r.body.completedTopic, true);
  assert.equal(r.body.session.corrections.length, 1);
  const rows = await srv.db.query(
    'SELECT t.title, s.focused_ms, s.state FROM study_sessions s JOIN topics t ON t.id = s.topic_id WHERE s.room_id = ? AND t.title IN (?, ?, ?) ORDER BY t.title',
    [roomId, 'Split: graphs', 'Split: trees', 'Read the DP chapter'],
  );
  assert.deepEqual(
    rows.map((x: any) => [x.title, x.focused_ms, x.state]),
    [
      ['Read the DP chapter', 30 * 60_000, 'finished'],
      ['Split: graphs', 90 * 60_000, 'finished'],
      ['Split: trees', 45 * 60_000, 'finished'],
    ],
  );
  // The new task is a topic of yours in the room, now in progress.
  const room = (await A.get(`/rooms/${roomId}`)).body;
  const added = room.topics.find((t: any) => t.title === 'Read the DP chapter');
  assert.equal(added.createdBy, room.topics.find((t: any) => t.id === own).createdBy);
  assert.equal(added.progress[added.createdBy].status, 'in_progress');
  // Retrying adds nothing.
  await A.post(`/sessions/${s.id}/split`, { parts: [{ topicId: other, minutes: 45 }] });
  assert.equal((await srv.db.query('SELECT count(*) AS n FROM study_sessions WHERE topic_id = ?', [other]))[0].n, 1);
});

test('reconnecting replays nothing: realtime events only invalidate, state comes from the server', async () => {
  const s = (await B.post('/sessions', { topicId: bTopics[0] })).body.session;
  // Simulate several reconnects that each re-read state.
  for (let i = 0; i < 3; i++) assert.equal((await B.get('/sessions/active')).body.session.id, s.id);
  await B.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  await B.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  const n = (await srv.db.query('SELECT COUNT(*) AS n FROM study_sessions WHERE user_id = ?', [b.id]))[0] as any;
  assert.equal(n.n, 1);
  const done = (await srv.db.query("SELECT COUNT(*) AS n FROM topic_completions WHERE user_id = ?", [b.id]))[0] as any;
  assert.equal(done.n, 1);
});

// ───────────── Goals ─────────────

test('a goal starts with one sprint; sprints are added, resized and removed as needed', async () => {
  // Started 3 days ago with 4-day sprints: day 0..2 are past, day 3 (end of sprint 1) is today.
  const res = await A.post('/plans', { title: 'GTFO 2026', startDate: addDays(today, -3), sprintDays: 4 });
  assert.equal(res.status, 201);
  const planId = res.body.id;
  const get = async () => (await A.get(`/plans/${planId}`)).body.plan;
  let plan = await get();
  assert.equal(plan.sprintCount, 1);
  assert.equal(plan.endDate, today);

  const add = async (day: number | null, title: string, estMinutes = 20) => A.post(`/plans/${planId}/tasks`, { day, title, estMinutes });
  for (const [day, title] of [[0, 'Set Matrix Zeroes'], [0, 'Pascal’s Triangle'], [1, 'Kadane'], [3, 'Next Permutation'], [3, 'Majority Element II']] as const) {
    assert.equal((await add(day, title)).status, 201);
  }
  assert.equal((await add(5, 'Two Sum')).status, 400); // no sprint 2 yet

  // Add a sprint of a different length when you need it.
  assert.equal((await A.post(`/plans/${planId}/sprints`, { days: 3 })).body.number, 2);
  assert.equal((await add(5, 'Two Sum')).status, 201);
  plan = await get();
  assert.deepEqual(plan.sprints.map((s: any) => s.length), [4, 3]);
  assert.equal(plan.endDate, addDays(today, 3));
  assert.deepEqual(plan.sprints[0].days.map((d: any) => d.status), ['missed', 'missed', 'rest', 'today']);
  // Unfinished tasks on past days are the backlog.
  assert.equal(plan.backlog, 3);
  assert.deepEqual(plan.backlogTasks.map((t: any) => t.title), ['Set Matrix Zeroes', 'Pascal’s Triangle', 'Kadane']);

  // Lengthening sprint 1 pushes sprint 2 (and its tasks) back; shortening brings them forward.
  await A.patch(`/plans/${planId}/sprints/1`, { days: 5 });
  plan = await get();
  assert.equal(plan.sprints[1].startDate, addDays(today, 2));
  assert.equal(plan.sprints[1].days[1].tasks[0].title, 'Two Sum');
  await A.patch(`/plans/${planId}/sprints/1`, { days: 4 });
  assert.equal((await get()).sprints[1].days[1].tasks[0].title, 'Two Sum');
  assert.equal((await A.patch(`/plans/${planId}/sprints/1`, { days: 2 })).status, 400); // would cut days with tasks

  // Only the last, empty sprint can be removed.
  assert.equal((await A.del(`/plans/${planId}/sprints/1`)).status, 400);
  assert.equal((await A.del(`/plans/${planId}/sprints/2`)).status, 400);
  await A.post(`/plans/${planId}/sprints`, {});
  assert.equal((await get()).sprints[2].length, 4);
  assert.equal((await A.del(`/plans/${planId}/sprints/3`)).status, 200);
  assert.equal((await get()).sprintCount, 2);
});

test('pulled sprints: study in the room, backlog stays out until you schedule it, and sprints can leave the room', async () => {
  const planId = (await A.get('/plans')).body.plans.find((p: any) => p.title === 'GTFO 2026').id;
  const get = async () => (await A.get(`/plans/${planId}`)).body.plan;
  assert.equal((await B.get(`/plans/${planId}`)).status, 404);
  assert.equal((await B.post(`/plans/${planId}/sprints/1/pull`, { roomId })).status, 404);

  assert.equal((await A.post(`/plans/${planId}/sprints/1/pull`, { roomId })).status, 200);
  let plan = await get();
  const [s1] = plan.sprints;
  const todays = s1.days[3].tasks;
  const backlogTask = plan.backlogTasks[0];
  assert.ok(todays.every((t: any) => t.topicId));

  // The partner sees the sprint in the room, read-only.
  let room = (await B.get(`/rooms/${roomId}`)).body;
  assert.equal(room.sprints.find((sp: any) => sp.planId === planId).ownerId, a.id);
  assert.equal((await B.post(`/topics/${todays[0].topicId}/complete`)).status, 403);

  // "Study next" is today's first task — never a backlog task.
  room = (await A.get(`/rooms/${roomId}`)).body;
  assert.equal(room.nextTopic.id, todays[0].topicId);
  assert.ok(room.topics.find((t: any) => t.id === todays[0].topicId).planTaskId);
  const s = (await A.post('/sessions', { topicId: todays[0].topicId })).body.session;
  assert.equal((await A.post(`/sessions/${s.id}/finish`, { completeTopic: true })).body.nextTopic.id, todays[1].topicId);

  // You decide when a backlog task comes back: schedule it for today. Its old day keeps its history.
  await A.patch(`/plan-tasks/${backlogTask.id}`, { day: 3 });
  plan = await get();
  assert.equal(plan.backlog, 2);
  assert.ok(plan.sprints[0].days[3].tasks.some((t: any) => t.id === backlogTask.id));
  assert.equal(plan.sprints[0].days[0].status, 'missed');
  const moved = plan.sprints[0].days[3].tasks.find((t: any) => t.id === backlogTask.id);
  assert.equal(moved.plannedDay, 0);
  await A.post(`/topics/${moved.topicId}/complete`);
  assert.equal((await get()).sprints[0].days[0].status, 'missed'); // done, but not on its day

  // A task done on its own day counts for that day.
  const other = plan.backlogTasks.find((t: any) => t.title === 'Pascal’s Triangle');
  await A.patch(`/plan-tasks/${other.id}`, { day: 3 });
  const otherTopic = (await get()).sprints[0].days[3].tasks.find((t: any) => t.id === other.id).topicId;
  await A.post(`/topics/${otherTopic}/complete`);
  await srv.db.query('UPDATE topic_completions SET local_date = ? WHERE topic_id = ?', [addDays(today, -3), otherTopic]);
  assert.equal((await get()).sprints[0].days[0].status, 'partial');

  // Parking today's task in the backlog takes it out of the room.
  await A.patch(`/plan-tasks/${todays[1].id}`, { day: null });
  room = (await A.get(`/rooms/${roomId}`)).body;
  const roomToday = room.sprints.find((sp: any) => sp.planId === planId).days[3].tasks.map((t: any) => t.id);
  assert.ok(!roomToday.includes(todays[1].id));
  assert.notEqual(room.nextTopic?.id, todays[1].topicId);

  // Take the sprint out of the room: its topics are archived; pull it back and they return, still done.
  const doneBefore = (await get()).done;
  await A.post(`/plans/${planId}/sprints/1/unpull`);
  room = (await A.get(`/rooms/${roomId}`)).body;
  assert.ok(!room.sprints.some((sp: any) => sp.planId === planId));
  assert.ok(room.archivedTopics.some((t: any) => t.id === todays[0].topicId));
  assert.equal((await get()).sprints[0].roomId, null);
  await A.post(`/plans/${planId}/sprints/1/pull`, { roomId });
  room = (await A.get(`/rooms/${roomId}`)).body;
  assert.ok(room.topics.some((t: any) => t.id === todays[0].topicId));
  assert.equal((await get()).done, doneBefore);

  // Sprints can live in different rooms; moving a task between them moves its topic.
  await A.post(`/plans/${planId}/sprints/2/pull`, { roomId: room2Id });
  await A.patch(`/plan-tasks/${todays[0].id}`, { day: 5 });
  assert.ok((await A.get(`/rooms/${room2Id}`)).body.topics.some((t: any) => t.id === todays[0].topicId));

  // Editing on the plan keeps the room topic in step; removing a task keeps its history.
  const extra = (await A.post(`/plans/${planId}/tasks`, { day: 3, title: 'Count Inversions', estMinutes: 23 })).body.id;
  await A.patch(`/plan-tasks/${extra}`, { title: 'Count Inversions (merge sort)', starred: true });
  const task = (await get()).sprints[0].days[3].tasks.find((t: any) => t.id === extra);
  assert.equal(task.starred, true);
  assert.equal((await A.get(`/rooms/${roomId}`)).body.topics.find((t: any) => t.id === task.topicId).title, 'Count Inversions (merge sort)');
  await A.del(`/plan-tasks/${extra}`);
  assert.ok((await A.get(`/rooms/${roomId}`)).body.archivedTopics.some((t: any) => t.id === task.topicId));

  // Review & complete takes the sprint out of the room view.
  await A.post(`/plans/${planId}/sprints/1/complete`);
  assert.ok(!(await A.get(`/rooms/${roomId}`)).body.sprints.some((sp: any) => sp.planId === planId));
  assert.equal((await A.get('/plans')).body.plans.find((p: any) => p.id === planId).sprintsCompleted, 1);
});

// ───────────── Calendar ─────────────

test('the calendar and home show goal tasks; a friend sees only sprints pulled into a shared room', async () => {
  const planId = (await A.post('/plans', { title: 'Calendar plan', startDate: today, sprintDays: 3 })).body.id;
  await A.post(`/plans/${planId}/tasks`, { day: 0, title: 'Heaps today', estMinutes: 30 });
  await A.post(`/plans/${planId}/tasks`, { day: 2, title: 'Tries later', estMinutes: 40 });
  await A.post(`/plans/${planId}/tasks`, { day: null, title: 'Parked idea' });
  const range = `from=${today}&to=${addDays(today, 7)}`;

  let mine = (await A.get(`/tasks?${range}`)).body;
  const titles = mine.planItems.filter((i: any) => i.planId === planId).map((i: any) => [i.title, i.date]);
  assert.deepEqual(titles, [['Heaps today', today], ['Tries later', addDays(today, 2)]]); // backlog isn't on the calendar
  assert.ok(mine.sprints.some((s: any) => s.planId === planId && s.number === 1 && s.startDate === today));
  const home = (await A.get('/home')).body;
  assert.ok(home.plannedTasks.some((t: any) => t.title === 'Heaps today'));

  // Not pulled into a room yet: the friend sees nothing.
  let theirs = (await B.get(`/tasks?${range}`)).body;
  assert.ok(!theirs.planItems.some((i: any) => i.planId === planId));
  await A.post(`/plans/${planId}/sprints/1/pull`, { roomId });
  theirs = (await B.get(`/tasks?${range}`)).body;
  const seen = theirs.planItems.filter((i: any) => i.planId === planId);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].ownerId, a.id);
  assert.equal(seen[0].topicId, null); // nothing to act on
  assert.equal(seen[0].roomId, roomId);
  assert.equal((await C.get(`/tasks?${range}`)).body.planItems.length, 0);

  // Finishing it updates the calendar and drops it from "Coming up".
  mine = (await A.get(`/tasks?${range}`)).body;
  const heaps = mine.planItems.find((i: any) => i.title === 'Heaps today');
  const s = (await A.post('/sessions', { topicId: heaps.topicId })).body.session;
  // The session length can change mid-session.
  assert.equal((await A.patch(`/sessions/${s.id}`, { targetMinutes: 25 })).status, 200);
  assert.equal((await A.get('/sessions/active')).body.session.targetMinutes, 25);
  await A.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  assert.equal((await A.get(`/tasks?${range}`)).body.planItems.find((i: any) => i.id === heaps.id).done, true);
  assert.ok(!(await A.get('/home')).body.plannedTasks.some((t: any) => t.id === heaps.id));
});

test('calendar: shared items are visible to the partner, private ones and notes are not; moving keeps sessions', async () => {
  const shared = (await A.post('/tasks', { title: 'Graphs practice', date: addDays(today, 1), roomId, topicId: topics[3], shared: true, note: 'my private note' })).body.task;
  const privateTask = (await A.post('/tasks', { title: 'Dentist', date: addDays(today, 1) })).body.task;

  const bView = (await B.get(`/tasks?from=${today}&to=${addDays(today, 7)}`)).body.tasks;
  const seen = bView.find((t: any) => t.id === shared.id);
  assert.ok(seen);
  assert.equal(seen.note, '');
  assert.equal(seen.ownerId, a.id);
  assert.ok(!bView.some((t: any) => t.id === privateTask.id));
  assert.equal((await C.get(`/tasks?from=${today}&to=${addDays(today, 7)}`)).body.tasks.length, 0);

  // B can't edit or complete A's task.
  assert.equal((await B.patch(`/tasks/${shared.id}`, { completed: true })).status, 404);

  // Start studying from the scheduled topic, then move the task: the session survives.
  const s = (await A.post('/sessions', { topicId: topics[3], taskId: shared.id })).body.session;
  await A.post(`/sessions/${s.id}/finish`, {});
  const moved = await A.patch(`/tasks/${shared.id}`, { date: addDays(today, 3) });
  assert.equal(moved.body.task.date, addDays(today, 3));
  const sessions = (await A.get('/sessions')).body.sessions;
  assert.ok(sessions.some((x: any) => x.id === s.id && x.state === 'finished'));
});

// ───────────── Privacy, history, encouragement ─────────────

test('archiving a topic keeps its history and sessions', async () => {
  const before = (await A.get('/sessions')).body.sessions.filter((s: any) => s.topicId === topics[3]).length;
  assert.equal((await B.del(`/topics/${topics[3]}`)).status, 403);
  assert.equal((await A.del(`/topics/${topics[3]}`)).status, 200);
  const room = (await A.get(`/rooms/${roomId}`)).body;
  assert.ok(!room.topics.some((t: any) => t.id === topics[3]));
  assert.ok(room.archivedTopics.some((t: any) => t.id === topics[3]));
  const after = (await A.get('/sessions')).body.sessions.filter((s: any) => s.topicId === topics[3]).length;
  assert.equal(after, before);
  const history = (await A.get(`/topics/${topics[3]}/history`)).body;
  assert.ok(history.events.some((e: any) => e.type === 'archived'));
  assert.ok(history.events.some((e: any) => e.type === 'created'));
});

test('encouragement reaches the friend in real time; strangers cannot send it', async () => {
  const stream = await B.listen();
  const r = await A.post('/encourage', { recipientId: b.id, reaction: 'keep_going' });
  assert.equal(r.status, 201);
  // Earlier tests' activity (completions) can still be in flight, so wait for this reaction specifically.
  const e = await stream.waitFor((ev) => ev.table === 'activities' && ev.eventType === 'INSERT' && ev.row.type === 'reaction');
  assert.equal(e.row.reaction, 'keep_going');
  assert.equal(e.row.recipient_id, b.id);
  stream.stop();
  const feed = (await B.get('/activity')).body;
  assert.equal(feed.unread, 1);
  assert.equal(feed.activity[0].reaction, 'keep_going');
  await B.post('/activity/read');
  assert.equal((await B.get('/activity')).body.unread, 0);
  assert.equal((await C.post('/encourage', { recipientId: b.id, reaction: 'proud' })).status, 404);
});

test('privacy: hidden status, friend profile access, and profile edits are owner-only', async () => {
  await B.patch('/me', { shareStatus: false });
  const s = (await B.post('/sessions', { topicId: bTopics[1] })).body.session;
  const status = (await A.get('/friends')).body.friends[0].status;
  assert.equal(status.state, 'hidden');
  assert.equal(status.topicTitle, undefined);
  await B.post(`/sessions/${s.id}/discard`);
  await B.patch('/me', { shareStatus: true });

  assert.equal((await C.get(`/friends/${a.id}`)).status, 404);
  const profile = (await B.get(`/friends/${a.id}`)).body;
  assert.equal(profile.user.accent, 'blue');
  assert.ok(profile.stats.todayMs > 0);
  assert.equal(profile.sessions, undefined);

  // Changing my theme changes only my colour, never study records.
  const before = (await A.get('/sessions')).body.sessions.length;
  const me = (await A.patch('/me', { profileType: 'doctor' })).body.me;
  assert.equal(me.accent, 'pink');
  assert.equal((await A.get('/sessions')).body.sessions.length, before);
  await A.patch('/me', { profileType: 'engineer' });
  assert.equal((await B.get('/friends')).body.friends[0].user.accent, 'blue');
});

test('failed writes are reported accurately', async () => {
  const bad = await A.post(`/rooms/${roomId}/topics`, { title: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION');
  const before = (await A.get(`/rooms/${roomId}`)).body.topics.length;
  assert.equal((await A.put(`/rooms/${roomId}/topics/order`, { topicIds: [topics[0], crypto.randomUUID()] })).status, 400);
  assert.equal((await A.get(`/rooms/${roomId}`)).body.topics.length, before);
  // Writing to tables directly (bypassing the checked functions) is refused by the database.
  const direct = await A.sb.from('topic_completions').insert({ topic_id: topics[1], user_id: a.id, kind: 'first', completed_at: 0, local_date: today });
  assert.ok(direct.error, 'direct insert should fail');
  const forge = await A.sb.from('study_sessions').update({ focused_ms: 999_999_999 }).eq('user_id', a.id).select('id');
  assert.ok(forge.error || !forge.data?.length, 'direct update should change nothing');
  const peek = await A.sb.from('study_sessions').select('id').eq('user_id', b.id);
  assert.deepEqual(peek.data, []); // the partner's session history (and notes) stay private
  const spoof = await A.sb.from('profiles').update({ display_name: 'Hacked' }).eq('id', b.id).select('id');
  assert.deepEqual(spoof.data, []); // can't edit someone else's profile
});

test('home summarises the next action', async () => {
  const home = (await B.get('/home')).body;
  assert.equal(home.me.id, b.id);
  assert.ok(home.primary);
  assert.equal(home.friends[0].user.id, a.id);
  assert.ok(home.rooms.length >= 2);
});

test('a forgotten password is reset through the emailed link', async () => {
  const { me: r } = await signUp(srv.base, 'rhea', 'custom');
  const visitor = new Client(srv.base);
  const redirectTo = 'http://127.0.0.1:5173/reset';
  // Same answer whether or not the email has an account.
  assert.equal((await visitor.post('/auth/forgot', { email: 'nobody@example.com', redirectTo })).status, 200);
  assert.equal((await visitor.post('/auth/forgot', { email: 'not-an-email', redirectTo })).status, 400);
  assert.equal((await visitor.post('/auth/forgot', { email: emailFor('rhea'), redirectTo })).status, 200);

  // Read the email from the local mail catcher and follow its link like a browser would.
  const mail = 'http://127.0.0.1:54324/api/v1';
  let text = '';
  for (let i = 0; i < 20 && !text; i++) {
    const found = (await (await fetch(`${mail}/search?query=${encodeURIComponent(`to:${emailFor('rhea')}`)}`)).json()) as any;
    if (found.messages?.length) text = ((await (await fetch(`${mail}/message/${found.messages[0].ID}`)).json()) as any).Text;
    else await sleep(250);
  }
  const link = text.match(/https?:\/\/\S+verify\S+/)?.[0];
  assert.ok(link, 'reset email has a link');
  const landing = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;
  assert.ok(landing.startsWith(redirectTo), 'the link lands on the reset page');
  const hash = new URLSearchParams(landing.split('#')[1]);
  assert.equal(hash.get('type'), 'recovery');
  await visitor.sb.auth.setSession({ access_token: hash.get('access_token')!, refresh_token: hash.get('refresh_token')! });
  assert.equal((await visitor.get('/me')).body.me.id, r.id);

  const mismatch = await visitor.put('/auth/password', { password: 'a brand new secret', confirm: 'something else' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.data.field, 'confirm');
  assert.equal((await visitor.put('/auth/password', { password: 'a brand new secret', confirm: 'a brand new secret' })).status, 200);

  const fresh = new Client(srv.base);
  assert.equal((await fresh.post('/auth/signin', { email: emailFor('rhea'), password: 'correct horse battery' })).status, 400);
  assert.equal((await fresh.post('/auth/signin', { email: emailFor('rhea'), password: 'a brand new secret' })).status, 200);
  // Changing the password needs a signed-in person.
  assert.equal((await new Client(srv.base).put('/auth/password', { password: 'whatever123', confirm: 'whatever123' })).status, 401);
});

test('the room forest grows a tree for each day everything planned was finished', async () => {
  const planId = (await A.post('/plans', { title: 'Forest check', startDate: today, sprintDays: 3 })).body.id;
  for (const title of ['Tree one', 'Tree two']) await A.post(`/plans/${planId}/tasks`, { day: 0, title });
  assert.equal((await A.post(`/plans/${planId}/sprints/1/pull`, { roomId })).status, 200);
  const forest = async (who: Client) => (await who.get(`/rooms/${roomId}`)).body.forest?.[a.id] ?? 0;
  const before = await forest(A);

  const todays = (await A.get(`/plans/${planId}`)).body.plan.sprints[0].days[0].tasks;
  await A.post(`/topics/${todays[0].topicId}/complete`);
  assert.equal(await forest(A), before, 'half of today is not a full day yet');
  await A.post(`/topics/${todays[1].topicId}/complete`);
  assert.equal(await forest(A), before + 1, 'finishing today plants a tree');
  assert.equal(await forest(B), before + 1, 'the room partner sees the same count');

  // Only room members can count it.
  const { data, error } = await C.sb.rpc('room_forest', { p_room: roomId });
  assert.ok(error || !data.length);
});

test('the hours report gives daily and per-topic totals to you and your friend only', async () => {
  const from = addDays(today, -6);
  const mine = await A.get(`/progress/hours?userId=${a.id}&from=${from}&to=${today}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.report.daily.length, 7);
  assert.ok(mine.body.report.topics.every((t: any) => t.title && t.roomName && t.ms >= 0));
  const total = mine.body.report.daily.reduce((n: number, d: any) => n + d.ms, 0);
  assert.equal(total, mine.body.report.topics.reduce((n: number, t: any) => n + t.ms, 0) + mine.body.report.otherMs);

  assert.equal((await A.get(`/progress/hours?userId=${b.id}&from=${from}&to=${today}`)).status, 200); // a friend
  assert.equal((await C.get(`/progress/hours?userId=${a.id}&from=${from}&to=${today}`)).status, 404); // a stranger
  assert.equal((await A.get(`/progress/hours?userId=${a.id}&from=2020-01-01&to=${today}`)).status, 400); // over a year
});

test('removing a room takes it off your list only; it waits while you study there', async () => {
  const req = await C.post('/friends/requests', { userId: a.id });
  assert.equal((await A.post(`/friends/requests/${req.body.id}/accept`)).status, 200);
  const shared = (await A.post('/rooms', { friendId: c.id, name: 'Short-lived', startDate: today, endDate: addDays(today, 30) })).body.id;
  const mine = (await A.post(`/rooms/${shared}/topics`, { title: 'Leaving soon' })).body.id;
  await C.post(`/rooms/${shared}/topics`, { title: 'Staying' });

  const active = (await A.get('/sessions/active')).body.session;
  if (active) await A.post(`/sessions/${active.id}/discard`);
  const session = (await A.post('/sessions', { topicId: mine })).body.session;
  assert.equal((await A.post(`/rooms/${shared}/leave`)).status, 409, 'not while studying there');
  await A.post(`/sessions/${session.id}/discard`);

  assert.equal((await C.post(`/rooms/${shared}/leave`, {})).status, 200);
  assert.ok(!(await C.get('/rooms')).body.rooms.some((r: any) => r.id === shared));
  assert.equal((await C.get(`/rooms/${shared}`)).status, 404);
  const left = (await A.get(`/rooms/${shared}`)).body;
  assert.equal(left.status, 'active', 'the friend keeps the room');
  assert.deepEqual(left.members.map((m: any) => m.user.id), [a.id]);
  assert.equal((await C.post(`/rooms/${shared}/leave`)).status, 404, 'already gone');
});

test('unfriending ends the friendship quietly, archives shared rooms and can be undone by a new request', async () => {
  const shared = (await A.post('/rooms', { friendId: c.id, name: 'Before goodbye', startDate: today, endDate: addDays(today, 30) })).body.id;
  assert.equal((await B.post(`/friends/${c.id}/remove`)).status, 404, 'only friends can be removed');

  const res = await C.post(`/friends/${a.id}/remove`, { leaveRooms: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.rooms, 1);
  assert.ok(!(await A.get('/friends')).body.friends.some((f: any) => f.user.id === c.id));
  assert.ok(!(await C.get('/friends')).body.friends.some((f: any) => f.user.id === a.id));
  assert.equal((await C.get(`/friends/${a.id}`)).status, 404);
  assert.equal((await C.post('/encourage', { recipientId: a.id, reaction: 'proud' })).status, 404);
  assert.equal((await A.get(`/rooms/${shared}`)).body.status, 'archived', 'kept, but archived for both');
  assert.equal((await C.get(`/rooms/${shared}`)).body.status, 'archived');
  assert.equal((await A.get('/friends')).body.friends.some((f: any) => f.user.id === b.id), true, 'other friendships are untouched');

  const again = await A.post('/friends/requests', { userId: c.id });
  assert.equal(again.body.status, 'pending');
  await C.post(`/friends/requests/${again.body.id}/accept`);
  const gone = await A.post(`/friends/${c.id}/remove`, { leaveRooms: true });
  assert.equal(gone.status, 200);
  assert.ok(!(await A.get('/rooms')).body.rooms.some((r: any) => r.id === shared), 'and can take the rooms off your list too');
  assert.equal((await C.get(`/rooms/${shared}`)).status, 200);
});

test('feature switches are saved to your account, merged, and only by you', async () => {
  const on = await A.patch('/me', { prefs: { revisions: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.me.prefs.revisions, true);
  const both = await A.patch('/me', { prefs: { streaks: true } });
  assert.deepEqual({ revisions: both.body.me.prefs.revisions, streaks: both.body.me.prefs.streaks }, { revisions: true, streaks: true }, 'earlier switches are kept');
  assert.equal((await A.patch('/me', { prefs: { 'bad key!': true } })).status, 400);
  await C.sb.from('profiles').update({ prefs: { revisions: false } }).eq('id', a.id);
  assert.equal((await A.get('/me')).body.me.prefs.revisions, true, 'nobody else can change them');
  await A.patch('/me', { prefs: { revisions: false, streaks: false } });
});

test('revision reminders come back 1, 3, 7 and 21 days after finishing a topic', async () => {
  const topicId = (await A.post(`/rooms/${roomId}/topics`, { title: 'Spaced repetition' })).body.id;
  await A.post(`/topics/${topicId}/complete`);
  const due = async (ahead = 0) => (await A.get(`/revisions?ahead=${ahead}`)).body.revisions.filter((r: any) => r.topicId === topicId);
  assert.equal((await due()).length, 0, 'nothing due on the day you finish');
  assert.deepEqual((await due(7)).map((r: any) => [r.step, r.dueDate]), [[1, addDays(today, 1)]]);

  const backdate = (days: number) =>
    srv.db.query(`UPDATE topic_completions SET local_date = ? WHERE topic_id = ? AND kind = 'first'`, [addDays(today, -days), topicId]);
  await backdate(1);
  assert.equal((await due())[0].step, 1, 'due the next day');

  await A.post(`/topics/${topicId}/reopen`, { mode: 'revise' });
  await A.post(`/topics/${topicId}/complete`);
  assert.equal((await due()).length, 0, 'reviewed today');
  assert.deepEqual((await due(7)).map((r: any) => [r.step, r.dueDate]), [[2, addDays(today, 2)]], 'step 2 is 3 days after the first finish');

  await backdate(30);
  assert.equal((await due())[0].step, 2, 'a missed step waits for you');
  assert.equal((await B.get('/revisions?ahead=30')).body.revisions.some((r: any) => r.topicId === topicId), false, 'only your own');
});

test('streaks count days in a row with 5+ minutes; the recap covers you and your friends only', async () => {
  const studied = (daysAgo: number, minutes: number) =>
    srv.db.query(
      `INSERT INTO study_sessions (user_id, room_id, topic_id, state, started_at, ended_at, focused_ms, measured_ms, local_date, created_at)
       VALUES (?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`,
      [b.id, room2Id, bTopics[0], Date.now(), Date.now(), minutes * 60000, minutes * 60000, addDays(today, -daysAgo), Date.now()],
    );
  await studied(1, 10);
  await studied(2, 10);
  await studied(3, 4); // too short to count
  await studied(4, 10);
  await studied(5, 10);
  const from = addDays(today, -6);
  const recap = await B.get(`/recap?from=${from}&to=${today}`);
  assert.equal(recap.status, 200);
  const mine = recap.body.people[0];
  assert.equal(mine.userId, b.id, 'you come first');
  assert.ok(mine.streak.current >= 2 && mine.streak.current <= 3, `streak ${mine.streak.current}: yesterday and the day before, plus today if studied`);
  assert.ok(mine.streak.best >= 2);
  assert.ok(mine.totalMs >= 44 * 60000);
  assert.ok(recap.body.people.some((p: any) => p.userId === a.id), 'your friend is included');
  assert.equal((await C.get(`/recap?from=${from}&to=${today}`)).body.people.some((p: any) => p.userId === b.id), false, 'strangers are not');
  assert.equal((await B.get(`/recap?from=2020-01-01&to=${today}`)).status, 400);
});

test('a weekly challenge is won when both reach the target, and plants a sunflower in shared rooms', async () => {
  const week = startOfWeek(today);
  assert.equal((await C.post('/challenge', { friendId: a.id, week, kind: 'hours', target: 2 })).status, 404, 'friends only');
  assert.equal((await A.post('/challenge', { friendId: b.id, week: addDays(week, 21), kind: 'hours', target: 2 })).status, 400, 'this week or next');
  assert.equal((await A.post('/challenge', { friendId: b.id, week, kind: 'days', target: 9 })).status, 400);

  const set = await A.post('/challenge', { friendId: b.id, week, kind: 'hours', target: 3 });
  assert.equal(set.status, 200);
  const changed = await B.post('/challenge', { friendId: a.id, week, kind: 'hours', target: 2 });
  const status = (who: Client, friend: string) => who.get(`/challenge?friendId=${friend}&week=${week}`);
  const seen = (await status(A, b.id)).body;
  assert.equal(seen.challenge.id, changed.body.id, 'changing replaces the old one');
  assert.equal(seen.challenge.target, 2);
  assert.equal(seen.challenge.wonAt, null);

  for (const [user, room, topic] of [[a.id, roomId, topics[0]], [b.id, room2Id, bTopics[0]]])
    await srv.db.query(
      `INSERT INTO study_sessions (user_id, room_id, topic_id, state, started_at, ended_at, focused_ms, measured_ms, local_date, created_at)
       VALUES (?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`,
      [user, room, topic, Date.now(), Date.now(), 2.5 * 3600000, 2.5 * 3600000, today, Date.now()],
    );
  const won = (await status(B, a.id)).body;
  assert.ok(won.challenge.wonAt, 'both reached two hours');
  assert.equal(won.wins, 1);
  assert.equal((await A.get(`/rooms/${roomId}`)).body.blooms, 1, 'a sunflower in the shared room');
  assert.ok((await A.get('/activity')).body.activity.some((x: any) => x.type === 'challenge_won'));
  assert.equal((await A.post('/challenge', { friendId: b.id, week, kind: 'hours', target: 5 })).status, 409, 'a won week stays won');
  assert.equal((await A.post(`/challenge/${won.challenge.id}/cancel`)).status, 409);
  assert.equal((await C.get(`/challenge?friendId=${a.id}&week=${week}`)).status, 404);
});

test('studying together: join a friend, share breaks, and part ways when one finishes', async () => {
  for (const who of [A, B]) {
    const s = (await who.get('/sessions/active')).body.session;
    if (s) await who.post(`/sessions/${s.id}/discard`);
  }
  assert.equal((await A.post('/together/join', { friendId: b.id, topicId: topics[1] })).status, 409, 'nobody to join yet');
  const host = (await B.post('/sessions', { topicId: bTopics[1] })).body.session;
  assert.equal((await C.post('/together/join', { friendId: b.id, topicId: topics[1] })).status, 404, 'friends only');

  const joined = await A.post('/together/join', { friendId: b.id, topicId: topics[1] });
  assert.equal(joined.status, 200);
  const togetherId = joined.body.session.togetherId;
  assert.ok(togetherId);
  assert.equal((await B.get('/sessions/active')).body.session.togetherId, togetherId, 'both sessions are linked');
  const view = (await B.get(`/together/${togetherId}`)).body.together;
  assert.equal(view.live, true);
  assert.equal(view.people[a.id].topicTitle, 'Binary Search', 'they share a room, so the topic shows');
  assert.equal((await C.get(`/together/${togetherId}`)).status, 404);
  assert.ok((await B.get('/activity')).body.activity.some((x: any) => x.type === 'together_joined'));

  const state = async (who: Client) => (await who.get('/sessions/active')).body.session.state;
  await B.post(`/together/${togetherId}/break`, { on: true });
  assert.deepEqual([await state(A), await state(B)], ['paused', 'paused'], 'a break pauses both');
  await A.post(`/together/${togetherId}/break`, { on: false });
  assert.deepEqual([await state(A), await state(B)], ['running', 'running'], 'either can end it');

  await A.post(`/sessions/${joined.body.session.id}/pause`);
  await B.post(`/together/${togetherId}/break`, { on: true });
  await B.post(`/together/${togetherId}/break`, { on: false });
  assert.deepEqual([await state(A), await state(B)], ['paused', 'running'], 'your own pause from before the break stays');

  await B.post(`/sessions/${host.id}/finish`, {});
  assert.equal((await A.get(`/together/${togetherId}`)).body.together.live, false);
  assert.equal((await A.post(`/together/${togetherId}/break`, { on: true })).status, 409);
  await A.post(`/sessions/${joined.body.session.id}/discard`);
});

test('phone notifications: the right people, only if they opted in, and never blocking the action', async () => {
  const endpoint = (who: string) => `https://push.example.com/${who}-${Date.now()}`;
  const save = (who: Client, id: string) => who.sb.rpc('save_push_subscription', { p_endpoint: endpoint(id), p_p256dh: 'BKey', p_auth: 'auth' });
  assert.equal((await save(A, 'a')).error, null);
  await save(B, 'b');
  assert.equal(((await C.sb.from('push_subscriptions').select('*')).data ?? []).length, 0, 'subscriptions are private');
  const recipients = async (pref: string, users: string[]) => (await srv.db.query(`SELECT push_recipients(?, ?::uuid[]) AS r`, [pref, users]))[0].r;

  assert.deepEqual(await recipients('pushEncourage', [a.id]), [], 'off until switched on');
  await A.patch('/me', { prefs: { pushEncourage: true, pushStudying: true } });
  assert.deepEqual(await recipients('pushEncourage', [a.id]), [a.id]);
  for (const who of [A, B]) {
    const s = (await who.get('/sessions/active')).body.session;
    if (s) await who.post(`/sessions/${s.id}/discard`);
  }
  assert.deepEqual(await recipients('pushStudying', [a.id]), [a.id]);
  const s = (await A.post('/sessions', { topicId: topics[1] })).body.session;
  assert.deepEqual(await recipients('pushStudying', [a.id]), [], 'not while you are studying yourself');
  await A.post(`/sessions/${s.id}/discard`);

  // The database hands the message to the push function. Stand in for it with a local server.
  const { createServer } = await import('node:http');
  const received: { headers: any; body: any }[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => (received.push({ headers: req.headers, body: JSON.parse(data) }), res.end('{}')));
  });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  const port = (server.address() as any).port;
  const [{ host }] = await srv.db.query(`SELECT host(inet_client_addr()) AS host`); // this machine, as the database container sees it
  await srv.db.query(`INSERT INTO push_config (url, secret) VALUES (?, 'test-secret')`, [`http://${host}:${port}/push`]);
  try {
    assert.equal((await B.post('/encourage', { recipientId: a.id, reaction: 'proud' })).status, 201);
    for (let i = 0; i < 40 && !received.length; i++) await sleep(250);
    assert.equal(received.length, 1, 'one call to the push function');
    assert.equal(received[0].headers['x-push-secret'], 'test-secret');
    assert.equal(received[0].body.notification.title, 'Mira sent you some encouragement');
    assert.deepEqual(received[0].body.subscriptions.map((x: any) => x.endpoint.split('/').pop().split('-')[0]), ['a'], 'only to the recipient');

    await srv.db.query(`UPDATE push_config SET url = 'http://256.0.0.1/broken'`);
    assert.equal((await B.post('/encourage', { recipientId: a.id, reaction: 'keep_going' })).status, 201, 'a broken push setup never blocks the action');
  } finally {
    await srv.db.query(`DELETE FROM push_config`);
    server.close();
  }
});
