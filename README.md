# Us in Progress

A private, shared study garden for two friends. Everything hangs off one simple shape:

**Goal → sprints → days → tasks**, then **pull a sprint into a shared room** to study it there.

A goal (say "GTFO 2026") is your own plan: a start date, a sprint length (e.g. 12 days) and a number of
sprints. The app lays out the days; you put tasks with estimated times on each day. When a sprint starts,
pull it into the room you share with your friend: its tasks appear in your column there, you study them
with the timer, and each finished task ticks off on its day. Past days show **Completed**, **Partially
completed** or **Missed**; the goal page shows what to start next, today's progress and a ☆ revision list.

---

## Quick start

Requirements: **Node.js 22.13+** (built and tested on Node 24). No database server, no Docker.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev
```

Open the URL Vite prints (normally http://localhost:5173 — it picks the next free port if that one is
busy). The seed creates two demo friends, **asha** (engineer, blue) and **mira** (doctor, pink), both with
the password `garden-demo-1`. These are development-only accounts; delete `./data` to start fresh.

To try both sides at once, sign in as `asha` in one browser and `mira` in a private window.

### Production build

```bash
npm run build
```

```bash
npm start
```

`npm start` serves the API and the built frontend from one process on `PORT` (default 3000). Copy
`.env.example` to `.env` to configure it. Behind HTTPS set `COOKIE_SECURE=true`; behind a reverse proxy set
`TRUST_PROXY=true`.

### Tests

```bash
npm test
```

Runs the acceptance suite (`tests/acceptance.test.ts`) against a real HTTP server with an in-memory
database, plus unit tests for the timer math.

---

## Stack, and why

| Layer | Choice | Reason |
| --- | --- | --- |
| Server | Node 24 + Express 5, TypeScript run directly by Node (type stripping) | One small process; no build step for the server |
| Database | SQLite via Node's built-in `node:sqlite` | Durable, transactional, zero setup, no native dependencies. Perfect for a two-person app |
| Auth | Username + password, **scrypt** hashes, random session tokens in HttpOnly SameSite cookies (only SHA-256 of the token is stored) | Real accounts without fake email addresses or third-party services |
| Realtime | Server-Sent Events | One-way "something changed" pushes; clients refetch from the database, so the server stays the only source of truth and reconnects can't duplicate anything |
| Frontend | React 18 + Vite + TanStack Query + React Router | Simple data fetching with cache invalidation driven by realtime events |
| Validation | Zod schemas in `shared/`, used by both server (enforced) and client (friendly early errors) | |

No microservices, no external infrastructure.

## Project layout

```
server/
  index.ts            process entry (env, listen, shutdown)
  app.ts              Express app factory (used by tests too)
  db.ts               SQLite connection, migrations, transaction helper
  migrations/         SQL schema (001_init.sql)
  auth.ts             password hashing, sessions, same-origin + rate-limit guards
  realtime.ts         SSE hub
  routes.ts           thin HTTP layer → services, plus realtime fan-out
  services/
    core.ts           users, friendship/room access checks, live status, activity feed
    rooms.ts          rooms, topics, independent per-member progress, completion/reopen
    sessions.ts       the timer service (start/pause/resume/finish/discard/correct)
    plans.ts          goals as plans: sprints, days, tasks; pulling a sprint into a room
    tasks.ts          calendar tasks
    social.ts         friend requests, friends, encouragement, progress stats, home summary
  seed.ts             development data
shared/
  timer.ts            focused-time math (used by server and client)
  dates.ts            calendar-date helpers (time-zone aware)
  theme.ts            identity colours, reactions
  validation.ts       request schemas
  types.ts            API response types
web/                  React app (pages/, components/, lib/)
tests/                acceptance + unit tests
```

## Data model

All timestamps are integer milliseconds (server clock). Calendar dates are `YYYY-MM-DD` in the owner's
time zone.

- **users** — profile, identity accent, theme, time zone, share-status preference. *No password column.*
- **auth_credentials** / **auth_sessions** — scrypt hash; hashed session tokens. Only `auth.ts` touches these.
- **friendships** — requester, recipient, `pending/accepted/rejected/cancelled`. A partial unique index
  allows one live relationship per pair in either direction. Only the recipient can accept/reject.
- **rooms** + **room_members** — a trigger enforces at most two members; rooms are only created with an
  accepted friend, inserting both members in one transaction.
- **topics** — each topic belongs to the person who added it (`created_by`). In a shared room both people
  see both lists, but only the owner can edit, reorder, archive, complete or study a topic. Estimate and
  session target are stored separately; topics are archived, never deleted.
- **topic_progress** — the owner's status for the topic: `not_started / in_progress / completed / revising`.
- **topic_completions** — the single source of truth for completed topic work. A partial unique index
  allows only one non-revoked *first* completion per topic and member. Mistakes are *revoked*, not deleted;
  revisions are recorded as separate `revision` rows.
- **topic_events** — audit trail (created, edited, completed, reopened, archived…).
- **study_sessions** + **session_pauses** — start/end timestamps and every pause interval. A partial unique
  index allows only one running/paused session per user. `measured_ms` (what the clock said) is kept
  alongside `focused_ms` (what counts).
- **session_corrections** — every change to a recorded duration, with old and new values.
- **plans** — a goal: owner, title, start date, days per sprint, number of sprints. Days aren't stored;
  day N is the start date + N.
- **plan_sprints** — only for sprints pulled into a room (`room_id`) or reviewed (`completed_at`).
- **plan_tasks** — tasks on a day of a plan, with estimate, ☆ star and, once its sprint is in a room, the
  `topic_id` it's studied as. Removing a task archives its topic, so study history stays.
- `goals` / `topics.goal_id` from an earlier version are no longer used.
- **tasks** + **task_events** — calendar items: date, optional time/duration, optional room/topic, shared
  flag, private note. Moves are logged; removal archives.
- **activities** — reactions, messages, completions, room/friend events, with read state.

## How the important rules are implemented

**Timer.** Start writes a session row with a server timestamp; pause/resume write pause intervals; finish
writes the end. Displayed time is always `focusedMs(session, now)` from `shared/timer.ts` (wall time minus
pauses) — never a running JavaScript counter — and the client corrects for clock skew using the
`X-Server-Now` header. Refresh, closing the tab or a dropped connection just re-reads the session.
Pause/resume/finish are idempotent; a retried start returns the same session; a second concurrent start is
refused by the unique index. Sessions longer than 4 hours must be confirmed or corrected before they count.
Accidental sessions can be discarded (kept for audit, counts zero).

**Completing a topic.** One transaction: end the session (if running) and save its focused time, insert the
completion, mark *your* progress complete, then return the next incomplete topic in room order (wrapping
around). The next topic is selected but its timer is **not** started. Completing twice is a no-op.

**Goals and sprints.** A plan task becomes a room topic when its sprint is pulled into a room, so the timer,
completions, live status and the friend's view need nothing new. Progress is never stored: a task is done
when its topic has a (non-revoked) completion, and its time is the topic's finished sessions. A day is
*Completed* when all its tasks are done, *Partially completed* when some are, *Missed* when none are (past
days only). Editing a task on the plan keeps its room topic in step; a task can't move into a sprint that's
in a different room. "Review & complete" closes a sprint (it leaves the room view; history stays). In the
room, "Study next" is today's first open task, then overdue ones; finishing a task moves on to the next one
that day, then the following days.

**Topic ownership.** A room is a shared space with two personal lists — an engineer's DSA topics next to a
doctor's biochemistry topics. `requireOwnTopic` in `services/core.ts` rejects any change, completion or study
session on someone else's topic with 403. Goals are private to you; your friend only sees the sprints you
pull into your shared room, read-only. Room
progress is shown per person ("6 of 10 done") and never combined.

**Privacy.** Every route requires a session; every service checks ownership or membership on the server.
Non-members get 404 for rooms and topics (existence isn't revealed). Friends see: live status (unless you
turn it off), today/week totals, your topics and pulled sprints in rooms you share, and calendar items you mark
*Show on my friend's calendar*. They never see your session list, session notes or task notes. Cross-site state-changing requests are rejected; sign-in/up are rate-limited.

**Realtime.** After each write, the server sends `invalidate` events (e.g. `rooms`, `plans`, `session`) to
the affected people (the actor, their friends, the room's members). Clients refetch those queries. On
reconnect the client refetches everything, and a small indicator shows "Reconnecting…" while offline.

## What was verified

- `npm run typecheck` and `npm run build` succeed.
- `npm test` — 22 tests pass, covering every acceptance criterion in the spec that can be checked through the
  API: two accounts and sign-in, search/request/accept with duplicate and wrong-recipient guards, rooms only
  between friends and only two members, independent topic progress, live partner status over SSE, pause
  excluding paused time, refresh recovery, complete → next topic not started, finish without completion,
  idempotent retries, long-session confirmation with audited corrections, goal plans with day statuses,
  pulling a sprint into a room (studyable there, partner read-only, next task in day order, edits kept in
  step, removing a task keeps history, completing a sprint), shared vs
  private calendar items and notes, moving tasks keeping sessions, archiving keeping history, encouragement in
  real time, hidden status, owner-only profile edits, and accurate failure responses.
- Manually in a browser: sign-in, home, starting/pausing/resuming the timer, reload recovery, completing a
  topic with the next topic shown, a realtime toast and live status from the other account, mobile layout
  (bottom navigation, compact calendar) and dark mode.

## Known limitations

- Single server process: SQLite and the in-memory SSE hub assume one instance (fine for this app; to scale
  out you'd move to Postgres and a pub/sub channel).
- The one-hour reminder works while the app is open in a tab (in-app toast, plus a browser notification if
  you allow it). There are no closed-browser push notifications.
- Avatars are built-in study-buddy characters with accessories; image upload isn't implemented.
- There is no password reset flow (there's no email). If someone forgets their password, an admin has to reset
  it in the database.
- `npm start` sets `NODE_ENV` inline, which works in macOS/Linux shells; on Windows set it separately.
