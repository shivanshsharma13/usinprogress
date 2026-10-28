// End-to-end acceptance tests against the real HTTP API (spec section 17).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, signUp, sleep, startServer, type TestServer } from './helpers.ts';
import { addDays, startOfMonth, endOfMonth, startOfWeek } from '../shared/dates.ts';

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
  assert.equal((await fresh.post('/auth/signin', { username: 'asha', password: 'wrong password' })).status, 400);
  const ok = await fresh.post('/auth/signin', { username: 'ASHA', password: 'correct horse battery' });
  assert.equal(ok.status, 200);
  assert.equal((await fresh.get('/me')).body.me.id, a.id);

  // Duplicate usernames are rejected (case-insensitively).
  const dup = await new Client(srv.base).post('/auth/signup', { username: 'Asha', password: 'whatever123', displayName: 'X', profileType: 'custom' });
  assert.equal(dup.status, 409);

  // Passwords are hashed and live outside the application tables.
  const cols = srv.db.prepare('PRAGMA table_info(users)').all().map((r: any) => r.name);
  assert.ok(!cols.some((n: string) => n.includes('pass')));
  const cred = srv.db.prepare('SELECT password_hash FROM auth_credentials WHERE user_id = ?').get(a.id) as any;
  assert.ok(cred.password_hash.startsWith('scrypt$'));
  assert.ok(!cred.password_hash.includes('correct horse'));

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
  assert.throws(() => srv.db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(roomId, c.id, Date.now()), /ROOM_FULL/);
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
  await stream.waitFor((e) => e.keys.includes('friends'));
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
  const count = srv.db.prepare("SELECT COUNT(*) AS n FROM study_sessions WHERE user_id = ? AND state IN ('running','paused')").get(a.id) as any;
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
  // ~150ms of running time; the 400ms pause is excluded.
  assert.ok(done.body.session.focusedMs >= 100 && done.body.session.focusedMs < 450, `focused ${done.body.session.focusedMs}`);
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
  const n = srv.db.prepare("SELECT COUNT(*) AS n FROM topic_completions WHERE user_id = ? AND topic_id = ? AND revoked_at IS NULL").get(a.id, topics[0]) as any;
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
  const row = srv.db.prepare('SELECT state, focused_ms FROM study_sessions WHERE id = ?').get(s.id) as any;
  assert.deepEqual({ ...row }, { state: 'discarded', focused_ms: 0 });
  // B can't read A's session history.
  const bs = (await B.get('/sessions')).body.sessions;
  assert.ok(bs.every((x: any) => x.id !== s.id));
});

test('very long sessions must be confirmed or corrected, with an audit trail', async () => {
  const s = (await A.post('/sessions', { topicId: topics[2] })).body.session;
  srv.db.prepare('UPDATE study_sessions SET started_at = started_at - ? WHERE id = ?').run(5 * 3600_000, s.id);
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

test('reconnecting replays nothing: realtime events only invalidate, state comes from the server', async () => {
  const s = (await B.post('/sessions', { topicId: bTopics[0] })).body.session;
  // Simulate several reconnects that each re-read state.
  for (let i = 0; i < 3; i++) assert.equal((await B.get('/sessions/active')).body.session.id, s.id);
  await B.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  await B.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  const n = srv.db.prepare('SELECT COUNT(*) AS n FROM study_sessions WHERE user_id = ?').get(b.id) as any;
  assert.equal(n.n, 1);
  const done = srv.db.prepare("SELECT COUNT(*) AS n FROM topic_completions WHERE user_id = ?").get(b.id) as any;
  assert.equal(done.n, 1);
});

// ───────────── Goals ─────────────

test('completed work propagates weekly → monthly → yearly exactly once; unlinked goals stay at zero', async () => {
  const year = today.slice(0, 4);
  const yearly = (await A.post('/goals', { title: 'DSA proficiency', period: 'yearly', startDate: `${year}-01-01`, deadline: `${year}-12-31`, measure: 'count', target: 1000, unit: 'questions' })).body.id;
  const monthly = (await A.post('/goals', { title: '100 questions', period: 'monthly', startDate: startOfMonth(today), deadline: endOfMonth(today), measure: 'count', target: 100, unit: 'questions', parentId: yearly })).body.id;
  const weekStart = startOfWeek(today);
  const weekly = await A.post('/goals', { title: '25 this week', period: 'weekly', startDate: weekStart, deadline: addDays(weekStart, 6), measure: 'count', target: 25, unit: 'questions', parentId: monthly, roomIds: [roomId] });
  assert.equal(weekly.status, 201);
  const unlinked = (await A.post('/goals', { title: 'Read a book', period: 'monthly', startDate: startOfMonth(today), deadline: endOfMonth(today), measure: 'count', target: 3, unit: 'books' })).body.id;

  const progress = async () => Object.fromEntries((await A.get('/goals')).body.goals.map((g: any) => [g.id, g.progress.value]));
  let p = await progress();
  // Topic 0 was completed earlier today in the linked room.
  assert.equal(p[weekly.body.id], 1);
  assert.equal(p[monthly], 1);
  assert.equal(p[yearly], 1);
  assert.equal(p[unlinked], 0);

  await A.post(`/topics/${topics[1]}/complete`);
  // Also link the yearly goal directly to the same room: still no double counting.
  await A.patch(`/goals/${yearly}`, { roomIds: [roomId] });
  p = await progress();
  assert.equal(p[weekly.body.id], 2);
  assert.equal(p[monthly], 2);
  assert.equal(p[yearly], 2);

  // A task assigned to the weekly goal adds its quantity once to each level.
  const task = (await A.post('/tasks', { title: 'Solve 5 binary search questions', date: today, goalId: weekly.body.id, quantity: 5 })).body.task;
  await A.patch(`/tasks/${task.id}`, { completed: true });
  await A.patch(`/tasks/${task.id}`, { completed: true }); // idempotent
  p = await progress();
  assert.equal(p[weekly.body.id], 7);
  assert.equal(p[monthly], 7);
  assert.equal(p[yearly], 7);
  const goals = (await A.get('/goals')).body.goals;
  assert.equal(goals.find((g: any) => g.id === weekly.body.id).progress.percent, 28);

  // Partner's completions never count toward my goals.
  await B.post(`/topics/${bTopics[1]}/complete`);
  assert.equal((await progress())[weekly.body.id], 7);

  // Undoing a mistaken completion removes it everywhere; revision keeps it.
  await A.post(`/topics/${topics[1]}/reopen`, { mode: 'undo' });
  assert.equal((await progress())[yearly], 6);
  await A.post(`/topics/${topics[1]}/complete`);
  await A.post(`/topics/${topics[1]}/reopen`, { mode: 'revise' });
  assert.equal((await progress())[yearly], 7);
  const s = (await A.post('/sessions', { topicId: topics[1] })).body.session;
  assert.equal(s.isRevision, true);
  await A.post(`/sessions/${s.id}/finish`, { completeTopic: true });
  assert.equal((await progress())[yearly], 7);
});

test('the allocation rule blocks unrelated overlapping goals from claiming the same work', async () => {
  const res = await A.post('/goals', { title: 'Another goal', period: 'monthly', startDate: startOfMonth(today), deadline: endOfMonth(today), measure: 'count', target: 10, topicIds: [topics[0]] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'DOUBLE_COUNT');
});

test('time and completion goals use their own units; private goals stay private', async () => {
  const time = (await A.post('/goals', { title: 'Study 20 hours', period: 'custom', startDate: addDays(today, -1), deadline: addDays(today, 30), measure: 'time', target: 1200, roomIds: [room2Id], visibility: 'friends' })).body.id;
  const t = (await A.post(`/rooms/${room2Id}/topics`, { title: 'Enzyme kinetics' })).body.id;
  const s = (await A.post('/sessions', { topicId: t })).body.session;
  srv.db.prepare('UPDATE study_sessions SET started_at = started_at - ? WHERE id = ?').run(30 * 60_000, s.id);
  await A.post(`/sessions/${s.id}/finish`, {});
  const goal = (await A.get('/goals')).body.goals.find((g: any) => g.id === time);
  assert.equal(goal.progress.value, 30);
  assert.equal(goal.progress.percent, 3);

  const qual = (await A.post('/goals', { title: 'Feel confident in interviews', period: 'yearly', startDate: `${today.slice(0, 4)}-01-01`, deadline: `${today.slice(0, 4)}-12-31`, measure: 'completion' })).body.id;
  assert.equal((await A.get('/goals')).body.goals.find((g: any) => g.id === qual).progress.value, 0);
  await A.patch(`/goals/${qual}`, { status: 'done' });
  assert.equal((await A.get('/goals')).body.goals.find((g: any) => g.id === qual).progress.percent, 100);

  // B sees only goals A shared.
  const shared = (await B.get(`/goals/shared/${a.id}`)).body.goals;
  assert.deepEqual(shared.map((g: any) => g.id), [time]);
  assert.equal((await C.get(`/goals/shared/${a.id}`)).status, 403);
});

test('goals hold a checklist of study tasks; ticking them drives progress, and unscheduled tasks stay off the calendar', async () => {
  const year = today.slice(0, 4);
  const goal = (await A.post('/goals', { title: 'Finish graph basics', period: 'custom', startDate: today, deadline: addDays(today, 30), measure: 'completion', visibility: 'friends' })).body.id;
  const parent = (await A.post('/goals', { title: 'Graphs this year', period: 'yearly', startDate: `${year}-01-01`, deadline: `${year}-12-31`, measure: 'completion' })).body.id;
  await A.patch(`/goals/${goal}`, { parentId: parent });
  const ids: string[] = [];
  for (const title of ['BFS', 'DFS', 'Topological sort']) {
    const res = await A.post('/tasks', { title, goalId: goal });
    assert.equal(res.status, 201);
    assert.equal(res.body.task.date, null);
    ids.push(res.body.task.id);
  }
  const scheduled = (await A.post('/tasks', { title: 'Dijkstra', goalId: goal, date: addDays(today, 2) })).body.task;

  const find = async (id: string) => (await A.get('/goals')).body.goals.find((g: any) => g.id === id);
  let g = await find(goal);
  assert.deepEqual(g.tasks.map((t: any) => t.title), ['BFS', 'DFS', 'Topological sort', 'Dijkstra']);
  assert.equal(g.progress.percent, 0);

  await A.patch(`/tasks/${ids[0]}`, { completed: true });
  await A.patch(`/tasks/${ids[1]}`, { completed: true });
  g = await find(goal);
  assert.deepEqual(g.progress.tasks, { done: 2, total: 4 });
  assert.equal(g.progress.percent, 50);
  // The parent goal sees its sub-goal's checklist too.
  assert.deepEqual((await find(parent)).progress.tasks, { done: 2, total: 4 });

  // Only the dated task shows on the calendar.
  const cal = (await A.get(`/tasks?from=${addDays(today, -40)}&to=${addDays(today, 40)}`)).body.tasks.map((t: any) => t.id);
  assert.ok(cal.includes(scheduled.id));
  assert.ok(!ids.some((id) => cal.includes(id)));

  // Removing a task drops it from the checklist; marking the goal done shows 100%.
  await A.del(`/tasks/${ids[2]}`);
  g = await find(goal);
  assert.equal(g.tasks.length, 3);
  assert.equal(g.progress.percent, 67);
  await A.patch(`/goals/${goal}`, { status: 'done' });
  assert.equal((await find(goal)).progress.percent, 100);

  // The friend sees the shared goal's checklist but can't tick it.
  const shared = (await B.get(`/goals/shared/${a.id}`)).body.goals.find((x: any) => x.id === goal);
  assert.equal(shared.tasks.length, 3);
  assert.equal((await B.patch(`/tasks/${ids[1]}`, { completed: false })).status, 404);
});

// ───────────── Calendar ─────────────

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
  const e = await stream.waitFor((ev) => ev.notice?.kind === 'encouragement');
  assert.match(e.notice.text, /Keep going/);
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
  assert.equal((await A.put(`/rooms/${roomId}/topics/order`, { topicIds: [topics[0]] })).status, 400);
  assert.equal((await A.get(`/rooms/${roomId}`)).body.topics.length, before);
  const cross = await fetch(srv.base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: A.cookie }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('home summarises the next action', async () => {
  const home = (await B.get('/home')).body;
  assert.equal(home.me.id, b.id);
  assert.ok(home.primary);
  assert.equal(home.friends[0].user.id, a.id);
  assert.ok(home.rooms.length >= 2);
});
