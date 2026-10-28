// Development seed: two friends with a shared room, a sprint plan each, sessions and calendar tasks.
// Usage: npm run seed  (refuses to run in production or on a database that already has users)
import { openDatabase, get, run, newId } from './db.ts';
import { hashPassword } from './auth.ts';
import { addDays, localDate } from '../shared/dates.ts';
import { createRoom, completeTopic } from './services/rooms.ts';
import { sendFriendRequest, respondToRequest, encourage } from './services/social.ts';
import { addTask, createPlan, pullSprint } from './services/plans.ts';
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

// One shared room. Each person pulls the current sprint of their own plan into it.
const room = createRoom(db, asha, { friendId: mira, name: 'Our 90-Day Growth Plan', description: 'DSA for Asha, medicine for Mira.', startDate: today, endDate: addDays(today, 90), color: 'sage' });

// Asha's plan: 11 sprints of 12 days, started 5 days ago, so today is Day 6.
const gtfo = createPlan(db, asha, { title: 'GTFO 2026', startDate: addDays(today, -5), sprintDays: 12, sprintCount: 11 });
const ashaDays: [string, number][][] = [
  [['Set Matrix Zeroes', 30], ['Pascal’s Triangle', 20], ['Next Permutation (first try)', 30]],
  [['Kadane’s Algorithm', 25], ['Sort 0s, 1s and 2s', 20]],
  [['Stock Buy and Sell', 20], ['Rotate Matrix', 25]],
  [['Merge Overlapping Intervals', 30]],
  [['Merge Sorted Arrays', 25], ['Find the Duplicate', 20]],
  [['Next Permutation', 26], ['Majority Element II', 25], ['Find the repeating and missing number', 41], ['Count Inversions', 23], ['Reverse Pairs', 31], ['Maximum Product Subarray', 18]],
  [['Two Sum', 15], ['4 Sum', 30], ['Longest Consecutive Sequence', 25]],
  [['Largest Subarray with 0 Sum', 25], ['Subarrays with XOR K', 30]],
];
ashaDays.forEach((tasks, day) => tasks.forEach(([title, est]) => addTask(db, asha, gtfo, { day, title, estMinutes: est })));

// Mira's plan: 6 sprints of 14 days, started 2 days ago.
const med = createPlan(db, mira, { title: 'Medical syllabus 2026', startDate: addDays(today, -2), sprintDays: 14, sprintCount: 6 });
const miraDays: [string, number][][] = [
  [['Enzyme kinetics', 90], ['Michaelis–Menten questions', 40]],
  [['Glycolysis', 80], ['TCA cycle', 60]],
  [['Carbohydrate metabolism revision', 70], ['Lipid metabolism', 90], ['Pharmacology flashcards', 30]],
  [['Amino acid metabolism', 90]],
  [['Cardiovascular physiology', 120]],
];
miraDays.forEach((tasks, day) => tasks.forEach(([title, est]) => addTask(db, mira, med, { day, title, estMinutes: est })));

pullSprint(db, asha, gtfo, 1, room);
pullSprint(db, mira, med, 1, room);

const topicOf = (planId: string, title: string) =>
  get<{ topic_id: string }>(db, 'SELECT topic_id FROM plan_tasks WHERE plan_id = ? AND title = ?', planId, title)!.topic_id;

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
// Day 1 and Day 5 partly done, days 2–4 missed, today not started.
pastSession(asha, room, topicOf(gtfo, 'Set Matrix Zeroes'), 5 * 24 * 60, 35);
pastSession(asha, room, topicOf(gtfo, 'Pascal’s Triangle'), 5 * 24 * 60 - 60, 22);
pastSession(asha, room, topicOf(gtfo, 'Merge Sorted Arrays'), 26 * 60, 28);
completeTopic(db, asha, topicOf(gtfo, 'Set Matrix Zeroes'));
completeTopic(db, asha, topicOf(gtfo, 'Pascal’s Triangle'));
completeTopic(db, asha, topicOf(gtfo, 'Merge Sorted Arrays'));
run(db, 'UPDATE plan_tasks SET starred = 1 WHERE plan_id = ? AND title IN (?, ?)', gtfo, 'Count Inversions', 'Reverse Pairs');

pastSession(mira, room, topicOf(med, 'Enzyme kinetics'), 2 * 24 * 60, 85);
pastSession(mira, room, topicOf(med, 'Glycolysis'), 24 * 60, 70);
completeTopic(db, mira, topicOf(med, 'Enzyme kinetics'));
completeTopic(db, mira, topicOf(med, 'Michaelis–Menten questions'));
completeTopic(db, mira, topicOf(med, 'Glycolysis'));

createTask(db, asha, { title: 'Mock interview prep', date: addDays(today, 2), startTime: '19:00', durationMinutes: 60, shared: true });
createTask(db, mira, { title: 'Ward rounds — light study day', date: addDays(today, 1), shared: true });

encourage(db, mira, { recipientId: asha, reaction: 'proud' });

console.log(`Seeded two friends. Sign in as "asha" or "mira" with password "${PASSWORD}" (development only).`);
db.close();
