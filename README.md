# Us in Progress

A private, shared study garden for two friends. Everything hangs off one simple shape:

**Goal → sprints → days → tasks**, then **pull a sprint into a shared room** to study it there.

A goal (say "GTFO 2026") is your own plan. It starts with one sprint (e.g. 12 days) and you **add sprints
as you go**, each with its own length. You put tasks with estimated times on each day. Pull a sprint into
the room you share with your friend: in your column there it shows as goal → sprints → days → topics, each
with time spent against the estimate, and you study with the timer. You can **take a sprint out of the
room** again (its topics are archived, history kept, and come back if you pull it in later).

A task you don't finish on its day goes to the **backlog**. It doesn't move forward on its own and stays
out of the room until you schedule it again ("Do today" or pick a day). Past days keep an honest record —
**Completed**, **Partially completed** or **Missed** — judged by what was done on that day.

---

## How it's built

There is **no app server**. The site is static files (React + Vite) hosted on **GitHub Pages**, and the browser
talks directly to **Supabase**:

| Piece | What it does |
| --- | --- |
| **Supabase Auth** | Email + password accounts. A trigger creates each person's `profiles` row (username, name, theme) from the sign-up form. |
| **Row-level security** | Decides what each signed-in person can *read*: their own data, their friends' public profile and live status, rooms they belong to, sprints pulled into those rooms. Anonymous visitors can read nothing. |
| **Database functions** | Every *write* (`start_session`, `complete_topic`, `pull_sprint`, `send_friend_request`, …) is a `SECURITY DEFINER` function that checks `auth.uid()` and runs in one transaction. Tables have no write policies, so these functions are the only way in. |
| **Realtime** | Pushes changes so both people see each other's progress live. |

The public URL and anon key are in the browser bundle by design; they grant nothing beyond what the rules
above allow. `web/src/data/backend.ts` maps the screens' calls (`/rooms/…`, `/sessions/…`) onto those
reads and functions, so the UI code doesn't know or care where the data lives.

```
supabase/migrations/   schema + RLS (…_schema.sql) and every write function (…_functions.sql)
shared/                timer math, dates, goal-plan views (planView.ts), validation, types
web/src/data/          the data layer (backend.ts) and error mapping
web/src/lib/           Supabase client, realtime, queries, theme
web/src/pages, components   the UI
tests/                 acceptance tests, run against a local Supabase
scripts/seed-local.ts  demo data for local development
```

## Run it locally

Requirements: Node.js 22.13+ and Docker (for a local copy of Supabase).

```bash
npm install
```

```bash
npm run db:start
```

Copy the `API_URL` and `ANON_KEY` it prints into `.env.local` as `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (see `.env.example`), then load demo data and start the site:

```bash
npm run seed
```

```bash
npm run dev
```

Demo accounts (local only): `asha@example.com` and `mira@example.com`, password `correct horse battery`.
`npm run db:reset` wipes the local database back to the schema.

## Put it online (Supabase + GitHub Pages)

1. **Database.** Apply `supabase/migrations/*.sql` to your Supabase project, in order (SQL editor, or
   `npx supabase link` + `npx supabase db push`).
2. **Auth settings** (Supabase dashboard → Authentication):
   - *Sign In / Providers → Email*: turn **off** "Confirm email" (or keep it on and set the Site URL below,
     so confirmation links open the site).
   - *URL Configuration → Site URL*: `https://<user>.github.io/<repo>/`.
3. **GitHub repository variables** (Settings → Secrets and variables → Actions → Variables):
   `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`, `VITE_SUPABASE_ANON_KEY` = the project's anon /
   publishable key (Project Settings → API).
4. **Pages**: Settings → Pages → Source: *GitHub Actions*. Every push to `main` runs
   `.github/workflows/pages.yml`, which builds and publishes the site.

### Tests

```bash
npm test
```

Resets the local Supabase and runs the acceptance suite (`tests/acceptance.test.ts`) plus timer unit tests.
Each simulated person is a separate Supabase client with its own session, driving the real data layer, so
the tests exercise sign-in, RLS, the database functions and Realtime exactly as the site does.
`npm run build` also type-checks and runs a promise-safety lint (no forgotten `await`s in the data layer).

## Data model

All timestamps are integer milliseconds (database clock). Calendar dates are `YYYY-MM-DD` in the owner's
time zone.

- **auth.users** (Supabase) — email and bcrypt password hash; never exposed to the app's tables.
- **profiles** — username (unique, lowercase), display name, profile type, accent, avatar, theme, time zone,
  share-status. Readable by signed-in people (it holds nothing private); editable only by its owner, and only
  those columns.
- **friendships** — one live pending/accepted relationship per pair; only the recipient can answer.
- **rooms** + **room_members** — exactly two members (trigger); created only between accepted friends.
- **topics** — owned by the person who added them (`created_by`); the partner can see but not change them.
- **topic_progress**, **topic_completions** (single source of truth for finished work, revoked not deleted),
  **topic_events** (audit trail).
- **study_sessions** (+ **session_pauses**, **session_corrections**) — owner-only; one active session per person
  (partial unique index); `measured_ms` kept beside `focused_ms`.
- **presence** — one row per person, touched on study/progress changes, so friends get Realtime updates.
- **plans**, **plan_sprints** (each with its own length), **plan_tasks** (`day` NULL = backlog, `planned_day`
  keeps history, `topic_id` once pulled into a room).
- **tasks** (calendar) + **task_notes** (owner-only) + **task_events**.
- **activities** — reactions, messages, completions, room/friend events, with read state.

## How the important rules are implemented

**Timer.** Start writes a session row with a server timestamp; pause/resume write pause intervals; finish
writes the end. Displayed time is always `focusedMs(session, now)` from `shared/timer.ts` (wall time minus
pauses) — never a running JavaScript counter — and the client corrects for clock skew against the
database clock (`server_now()`). Refresh, closing the tab or a dropped connection just re-reads the session.
Pause/resume/finish are idempotent; a retried start returns the same session; a second concurrent start is
refused by the unique index. Sessions longer than 4 hours must be confirmed or corrected before they count.
Accidental sessions can be discarded (kept for audit, counts zero).

**Completing a topic.** One database function (`complete_topic` / `finish_session`), one transaction: end the session (if running) and save its focused time, insert the
completion, mark *your* progress complete, then return the next incomplete topic in room order (wrapping
around). The next topic is selected but its timer is **not** started. Completing twice is a no-op.

**Goals and sprints.** A plan task becomes a room topic when its sprint is pulled into a room, so the timer,
completions, live status and the friend's view need nothing new. Progress is never stored: a task is done
when its topic has a (non-revoked) completion, and its time is the topic's finished sessions. A day is
judged on what was planned for it (`planned_day`) and done by that date: all → *Completed*, some → *Partially
completed*, none → *Missed*. Backlog = unfinished tasks whose day has passed, or parked ones; scheduling one
again keeps its `planned_day`, while re-planning a task that isn't overdue moves it. A room shows only tasks
scheduled for today or later in open sprints pulled into it, so the backlog never leaks in. Resizing a
sprint shifts the sprints after it (ended sprints can't change; days with tasks can't be cut). Only the
last, empty sprint can be removed. Taking a sprint out of a room archives its topics; pulling it in again
(to any room) restores them with their done state. Editing a task on the plan keeps its room topic in step.
"Review & complete" closes a sprint. In the room, "Study next" is today's first open task, then upcoming
ones; finishing a task moves on to the next one that day, then the following days.

**Topic ownership.** A room is a shared space with two personal lists — an engineer's DSA topics next to a
doctor's biochemistry topics. `require_own_topic()` in the database refuses any change, completion or study
session on someone else's topic. Goals are private to you; your friend only sees the sprints you
pull into your shared room, read-only. Room
progress is shown per person ("6 of 10 done") and never combined.

**Privacy.** Row-level security decides what each signed-in person can read; every write is a database
function that checks `auth.uid()`. Non-members simply don't see rooms and topics (existence isn't revealed). Friends see: live status (unless you
turn it off), today/week totals, your topics and pulled sprints in rooms you share, and calendar items you mark
*Show on my friend's calendar*. They never see your session list, session notes or task notes (notes live in owner-only tables).

**Calendar and Home.** The calendar shows your own calendar tasks and friends' shared ones, plus every
scheduled goal task (yours, and your friend's from sprints they pulled into a room you share) with a marker
where each sprint starts; the day view shows which sprint day it is. Goal tasks can be studied straight from
the calendar once their sprint is in a room. Home's "Coming up" mixes goal tasks and calendar tasks for the
next two weeks, soonest first. Backlog tasks are never shown as upcoming.

**Timer.** Tap the clock (or press Space) to pause/resume. The session length can be changed mid-session
(25 / 45 / 60 / open, and +5 once reached); it only changes the countdown, never the recorded time. While
focusing, a slow breathing halo, drifting leaves and a growing plant keep the screen calm; everything stops
when paused and is switched off for people who prefer reduced motion.

**Realtime.** The app subscribes to Supabase Realtime changes on the shared tables; Realtime applies RLS,
so each person only hears about rows they may read. A tiny `presence` row per person (touched by the timer
functions) tells friends to refresh live status without exposing session rows. A change only tells the app
which screens to refetch from the database. On reconnect it refetches everything; a small indicator shows
"Reconnecting…" while offline.

## What was verified

- `npm run typecheck`, `npm run lint` and `npm run build` succeed (including the GitHub Pages sub-path build).
- `npm test` — 23 tests pass against a local Supabase (Auth, PostgREST, Realtime, Postgres 17), covering every
  acceptance criterion that can be checked from the browser's side: accounts and sign-in (passwords only in
  Supabase Auth, bcrypt), friend requests with duplicate and wrong-recipient guards, two-member rooms only
  between friends, topic ownership, the timer (pause excluded, refresh recovery, retries, long sessions with
  audited corrections), complete → next topic not started, goal plans (dynamic sprints, day statuses, backlog,
  pulling and removing sprints), calendar and Home, privacy (hidden status, private notes and session history,
  owner-only edits), Realtime delivery to the partner, and **direct table writes being refused by the database**.
- In a browser against local Supabase: sign-in, Home, live status of the partner arriving via Realtime, start →
  complete topic with the next topic lined up, and the goal page.
- On the hosted project: schema installed (19 tables with RLS, functions, sign-up trigger, Realtime); anonymous
  access refused for every table and function except the username-availability check.

## Known limitations

- The one-hour reminder works while the app is open in a tab (in-app toast, plus a browser notification if
  you allow it). There are no closed-browser push notifications.
- Avatars are built-in study-buddy characters with accessories; image upload isn't implemented.
- Password reset isn't built into the UI yet; Supabase can send reset emails if you add a page for it.
- Accounts from the earlier server version don't carry over (they had no email); sign up again.
