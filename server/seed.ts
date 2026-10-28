// Development seed: two friends with rooms, topics, goals, sessions and calendar tasks.
// Usage: npm run seed  (refuses to run in production or on a database that already has users)
import { openDatabase, get, run, newId } from './db.ts';
import { hashPassword } from './auth.ts';
import { addDays, endOfMonth, localDate, startOfMonth, startOfWeek } from '../shared/dates.ts';
import { createRoom, createTopic, completeTopic } from './services/rooms.ts';
import { sendFriendRequest, respondToRequest, encourage } from './services/social.ts';
import { createGoal } from './services/goals.ts';
import { createTask } from './services/tasks.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const db = openDatabase(process.env.DATABASE_PATH ?? './data/us-in-progress.db');
if (get(db, 'SELECT 1 FROM users LIMIT 1')) {
  console.error('This database already has users. Delete ./data to start fresh, or set DATABASE_PATH.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD ?? 'garden-demo-1';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDate(Date.now(), tz);

function user(username: string, displayName: string, profileType: 'engineer' | 'doctor', bio: string, accessory: string) {
  const id = newId();
  run(
    db,
    'INSERT INTO users (id, username, display_name, profile_type, accent, bio, avatar, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    username,
    displayName,
    profileType,
    profileType === 'engineer' ? 'blue' : 'pink',
    bio,
    JSON.stringify({ accessory }),
    tz,
    Date.now(),
  );
  run(db, 'INSERT INTO auth_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)', id, hashPassword(PASSWORD), Date.now());
  return id;
}

const asha = user('asha', 'Asha', 'engineer', 'Getting interview-ready, one problem at a time.', 'glasses');
const mira = user('mira', 'Mira', 'doctor', 'Biochemistry, revision, and lots of tea.', 'stethoscope');

const req = sendFriendRequest(db, asha, mira);
respondToRequest(db, mira, req.id, true);

// One shared room; each person keeps their own list of topics inside it.
const room = createRoom(db, asha, { friendId: mira, name: 'Our 90-Day Growth Plan', description: 'DSA for Asha, biochemistry for Mira.', startDate: today, endDate: addDays(today, 90), color: 'sage' });

// Each person's plan in the room: yearly → monthly → weekly goals, with topics under them.
const year = today.slice(0, 4);
const weekStart = startOfWeek(today);
const thisYear = { startDate: `${year}-01-01`, deadline: `${year}-12-31` };
const thisMonth = { startDate: startOfMonth(today), deadline: endOfMonth(today) };
const thisWeek = { startDate: weekStart, deadline: addDays(weekStart, 6) };

const ashaYear = createGoal(db, asha, { roomId: room, title: 'Get interview-ready in DSA', period: 'yearly', ...thisYear });
const ashaMonth = createGoal(db, asha, { roomId: room, title: 'Core data structures', period: 'monthly', ...thisMonth, parentId: ashaYear });
const ashaWeek = createGoal(db, asha, { roomId: room, title: 'Searching and lists', period: 'weekly', ...thisWeek, parentId: ashaMonth });
const miraYear = createGoal(db, mira, { roomId: room, title: 'Finish the medical syllabus', period: 'yearly', ...thisYear });
const miraMonth = createGoal(db, mira, { roomId: room, title: 'Biochemistry units', period: 'monthly', ...thisMonth, parentId: miraYear });

const dsa = (title: string, est: number, goalId: string) =>
  createTopic(db, asha, room, { title, estimatedMinutes: est, sessionTargetMinutes: 45, category: 'DSA', goalId });
const dsaTopics = [dsa('Arrays', 120, ashaWeek), dsa('Binary Search', 180, ashaWeek), dsa('Linked Lists', 120, ashaWeek), dsa('Trees', 300, ashaMonth), dsa('Graphs', 360, ashaMonth)];
const bioTopics = ['Enzyme kinetics', 'Carbohydrate metabolism', 'Lipid metabolism', 'Amino acids'].map((title) =>
  createTopic(db, mira, room, { title, estimatedMinutes: 240, sessionTargetMinutes: 50, category: 'Biochemistry', goalId: miraMonth }),
);
for (const title of ['Physiology: cardiovascular system', 'Pharmacology flashcards']) createTopic(db, mira, room, { title, goalId: miraYear });

// A few finished sessions so progress screens have something to show.
function pastSession(userId: string, roomId: string, topicId: string, minutesAgo: number, minutes: number) {
  const start = Date.now() - minutesAgo * 60_000;
  run(
    db,
    `INSERT INTO study_sessions (id, user_id, room_id, topic_id, state, started_at, ended_at, focused_ms, measured_ms, local_date, created_at)
     VALUES (?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?)`,
    newId(),
    userId,
    roomId,
    topicId,
    start,
    start + minutes * 60_000,
    minutes * 60_000,
    minutes * 60_000,
    localDate(start, tz),
    start,
  );
  run(db, "UPDATE topic_progress SET status = 'in_progress', updated_at = ? WHERE topic_id = ? AND user_id = ? AND status = 'not_started'", Date.now(), topicId, userId);
}
pastSession(asha, room, dsaTopics[0], 26 * 60, 50);
pastSession(asha, room, dsaTopics[0], 90, 40);
pastSession(asha, room, dsaTopics[1], 45, 25);
pastSession(mira, room, bioTopics[0], 30 * 60, 55);
pastSession(mira, room, bioTopics[0], 120, 45);
pastSession(mira, room, bioTopics[1], 3 * 24 * 60, 30);
completeTopic(db, asha, dsaTopics[0]);
completeTopic(db, mira, bioTopics[0]);

createTask(db, asha, { title: 'Solve 5 binary search questions', date: today, roomId: room, topicId: dsaTopics[1], shared: true });
createTask(db, asha, { title: 'Mock interview prep', date: addDays(today, 2), startTime: '19:00', durationMinutes: 60, shared: true });
createTask(db, mira, { title: 'Carbohydrate metabolism — first pass', date: today, roomId: room, topicId: bioTopics[1], shared: true, startTime: '18:30' });
createTask(db, mira, { title: 'Revise enzyme kinetics', date: addDays(today, 1), roomId: room, topicId: bioTopics[0], shared: true });

encourage(db, mira, { recipientId: asha, reaction: 'proud' });

console.log(`Seeded two friends. Sign in as "asha" or "mira" with password "${PASSWORD}" (development only).`);
db.close();
