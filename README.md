# Us in Progress

A private, shared study garden for two friends. Create a topic, press **Start studying**, press
**Complete topic** — the app does the bookkeeping: it saves the session, ticks the topic off for you
(only you), picks your next topic, updates your weekly → monthly → yearly goals, and shows your friend
in real time.

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
    goals.ts          goals + progress calculation and the anti-double-counting rule
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
- **goals** + **goal_links** — period, dates, measure (`count`/`time`/`completion`), optional target/unit,
  optional parent; links to whole rooms or individual topics.
- **tasks** + **task_events** — calendar items (date, optional time/duration, optional goal/room/topic,
  quantity, shared flag, private note). Moves are logged; removal archives.
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

**Goal progress (no double counting).** Progress is never stored; it is computed from completions, completed
tasks and finished sessions:

- A goal counts the **distinct** work items covered by its own links and its descendants' links, owned by
  the goal's owner, dated inside that goal's start–deadline window. A completed topic therefore counts
  once for the weekly goal, once for its monthly parent, once for the yearly grandparent — never three times
  in any one of them, even if the yearly goal is also linked to the same room.
- Count goals: each completed topic = 1; each completed task assigned to the goal = its quantity (it also
  counts for that goal's ancestors, once).
- Time goals: minutes of finished sessions on covered topics/rooms.
- Completion goals: done/not done, set explicitly by the owner.
- **Allocation rule:** a room or topic can only be linked to two of your goals with overlapping dates if one
  is an ancestor of the other. Otherwise the server rejects the link (`DOUBLE_COUNT`) and suggests linking the
  parent or child instead.
- Unlinked goals receive nothing automatically. Your friend's work never counts toward your goals.

**Topic ownership.** A room is a shared space with two personal lists — an engineer's DSA topics next to a
doctor's biochemistry topics. `requireOwnTopic` in `services/core.ts` rejects any change, completion or study
session on someone else's topic with 403, and tasks and goals can only reference your own topics. Room
progress is shown per person ("6 of 10 done") and never combined.

**Privacy.** Every route requires a session; every service checks ownership or membership on the server.
Non-members get 404 for rooms and topics (existence isn't revealed). Friends see: live status (unless you
turn it off), today/week totals, completions in shared rooms, goals you mark *Shared*, and calendar items
you mark *Show on my friend's calendar*. They never see your session list, session notes, task notes or
private goals. Cross-site state-changing requests are rejected; sign-in/up are rate-limited.

**Realtime.** After each write, the server sends `invalidate` events (e.g. `rooms`, `goals`, `session`) to
the affected people (the actor, their friends, the room's members). Clients refetch those queries. On
reconnect the client refetches everything, and a small indicator shows "Reconnecting…" while offline.

## What was verified

- `npm run typecheck` and `npm run build` succeed.
- `npm test` — 23 tests pass, covering every acceptance criterion in the spec that can be checked through the
  API: two accounts and sign-in, search/request/accept with duplicate and wrong-recipient guards, rooms only
  between friends and only two members, independent topic progress, live partner status over SSE, pause
  excluding paused time, refresh recovery, complete → next topic not started, finish without completion,
  idempotent retries, long-session confirmation with audited corrections, weekly → monthly → yearly
  propagation counted once, unlinked goals untouched, the allocation rule, time/completion goals, shared vs
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
