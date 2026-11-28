// The app's data layer, running in the browser against Supabase.
//
// Screens call request('GET', '/rooms/…') exactly as they did with the old server. Each path is answered
// here: reads go through row-level security (people only ever receive rows they may see), and every
// write is a database function that checks the signed-in user and runs atomically. Nothing in this file
// is trusted for security — the database enforces it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';
import * as v from '../../../shared/validation.ts';
import { addDays, localDate } from '../../../shared/dates.ts';
import { focusedMs } from '../../../shared/timer.ts';
import { buildPlan, goalTasks, plannedItems, spansOf, summarizePlan, type PlanRow, type SprintRow, type SprintSpan } from '../../../shared/planView.ts';
import type {
  Activity,
  GoalRef,
  GoalTask,
  ActiveSession,
  CompletionSummary,
  Friend,
  FriendRequest,
  HomeData,
  LiveStatus,
  Me,
  PlanTask,
  ProgressStats,
  PublicUser,
  RoomDetail,
  RoomSummary,
  SessionRecord,
  SubtopicCount,
  Topic,
  TopicMemberProgress,
  UserSearchResult,
} from '../../../shared/types.ts';
import { ApiError, fromSupabase, notFound, unauthenticated } from './errors.ts';

type Row = Record<string, any>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export function createBackend(sb: SupabaseClient, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;

  // ───────────── plumbing ─────────────

  async function rows<T = Row>(query: PromiseLike<{ data: unknown; error: any }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw fromSupabase(error);
    return (data ?? []) as T[];
  }

  async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw fromSupabase(error);
    return data as T;
  }

  function parse<T>(schema: ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ApiError(400, 'VALIDATION', issue?.message ?? 'Invalid input', { field: issue?.path?.join('.') || undefined });
    }
    return result.data;
  }

  async function myId(): Promise<string> {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw unauthenticated();
    return data.session.user.id;
  }

  const ids = (list: (string | null | undefined)[]) => [...new Set(list.filter(Boolean))] as string[];

  /** Run reads side by side, but report the first failure only after all have settled. */
  async function together<T extends readonly Promise<unknown>[]>(work: T): Promise<{ values: { -readonly [K in keyof T]: Awaited<T[K]> | undefined }; error: unknown }> {
    const settled = await Promise.allSettled(work);
    const failed = settled.find((r) => r.status === 'rejected');
    return { values: settled.map((r) => (r.status === 'fulfilled' ? r.value : undefined)) as any, error: failed ? (failed as PromiseRejectedResult).reason : null };
  }

  // ───────────── people ─────────────

  const toPublicUser = (p: Row): PublicUser => ({
    id: p.id,
    username: p.username,
    displayName: p.display_name,
    profileType: p.profile_type,
    accent: p.accent,
    bio: p.bio,
    avatar: p.avatar ?? {},
  });

  const toMe = (p: Row): Me => ({
    ...toPublicUser(p),
    colorScheme: p.color_scheme,
    timezone: p.timezone,
    shareStatus: p.share_status,
    prefs: p.prefs ?? {},
    createdAt: p.created_at,
    today: localDate(now(), p.timezone),
  });

  async function profiles(list: string[]): Promise<Map<string, Row>> {
    if (!list.length) return new Map();
    const found = await rows(sb.from('profiles').select('*').in('id', list));
    return new Map(found.map((p) => [p.id, p]));
  }

  // Your own profile only changes through PATCH /me, so keep it for a minute instead of asking every time.
  let meCache: { row: Row; at: number } | null = null;
  async function me(): Promise<Me> {
    const id = await myId();
    if (meCache?.row.id === id && Date.now() - meCache.at < 60_000) return toMe(meCache.row);
    const p = (await profiles([id])).get(id);
    if (!p) throw unauthenticated();
    meCache = { row: p, at: Date.now() };
    return toMe(p);
  }

  async function liveStatuses(users: string[]): Promise<Record<string, LiveStatus>> {
    if (!users.length) return {};
    return rpc('live_statuses', { p_users: users });
  }

  async function friendIds(meId: string): Promise<string[]> {
    const list = await rows(sb.from('friendships').select('requester_id, recipient_id').eq('status', 'accepted'));
    return list.map((f) => (f.requester_id === meId ? f.recipient_id : f.requester_id));
  }

  // ───────────── rooms & topics ─────────────

  async function loadTopics(roomIds: string[], includeArchived: boolean): Promise<Topic[]> {
    if (!roomIds.length) return [];
    // One request for topics with their progress and first completions; per-room totals alongside it.
    let query = sb
      .from('topics')
      .select('*, topic_progress(*), topic_completions(topic_id, user_id, completed_at), subtopics(done_at)')
      .in('room_id', roomIds)
      .eq('topic_completions.kind', 'first')
      .is('topic_completions.revoked_at', null)
      .order('position')
      .order('created_at');
    if (!includeArchived) query = query.eq('status', 'active');
    const [topics, times, planLinks] = await Promise.all([
      rows(query),
      Promise.all(roomIds.map((r) => rpc<Row[]>('room_topic_time', { p_room: r }))).then((x) => x.flat()),
      Promise.all(roomIds.map((r) => rpc<Row[]>('room_plan_topics', { p_room: r }))).then((x) => x.flat()),
    ]);
    if (!topics.length) return [];
    const today = await activeToday(topics.map((t) => t.id));
    const progress = topics.flatMap((t) => t.topic_progress ?? []);
    const firsts = topics.flatMap((t) => t.topic_completions ?? []);
    const key = (t: string, u: string) => `${t}:${u}`;
    const progressMap = new Map(progress.map((p) => [key(p.topic_id, p.user_id), p]));
    const firstMap = new Map(firsts.map((f) => [key(f.topic_id, f.user_id), f.completed_at as number]));
    const timeMap = new Map(times.map((t) => [key(t.topic_id, t.user_id), t]));
    const planMap = new Map(planLinks.map((l) => [l.topic_id, l.plan_task_id as string]));
    return topics.map((t) => {
      // Progress is tracked for the topic's owner only.
      const p = progressMap.get(key(t.id, t.created_by));
      const tm = timeMap.get(key(t.id, t.created_by));
      const prog: Record<string, TopicMemberProgress> = {
        [t.created_by]: {
          status: p?.status ?? 'not_started',
          completedAt: p?.completed_at ?? null,
          firstCompletedAt: firstMap.get(key(t.id, t.created_by)) ?? null,
          focusedMs: Number(tm?.ms ?? 0),
          sessions: Number(tm?.n ?? 0),
        },
      };
      return {
        id: t.id,
        roomId: t.room_id,
        title: t.title,
        description: t.description,
        category: t.category,
        estimatedMinutes: t.estimated_minutes,
        sessionTargetMinutes: t.session_target_minutes,
        deadline: t.deadline,
        planTaskId: planMap.get(t.id) ?? null,
        position: t.position,
        createdBy: t.created_by,
        status: t.status,
        createdAt: t.created_at,
        progress: prog,
        parts: countParts(t.subtopics),
        activeToday: today.has(t.id),
      };
    });
  }

  /** Which of these topics their owner studied, ticked a part of, or completed today. */
  const activeToday = async (topicIds: string[]) => new Set(topicIds.length ? await rpc<string[]>('active_today', { p_topics: topicIds }) : []);

  /** Which subtopics of these topics their owner studied or ticked today. */
  const activeParts = async (topicIds: string[]) => new Set(topicIds.length ? await rpc<string[]>('active_parts_today', { p_topics: topicIds }) : []);

  /** A topic with subtopics counts as done only while all of them are. */
  const partsOpen = (c: SubtopicCount) => c.total > 0 && c.done < c.total;

  const countParts = (list: Row[] | undefined): SubtopicCount => ({ done: (list ?? []).filter((x) => x.done_at !== null).length, total: list?.length ?? 0 });

  const isDone = (p: TopicMemberProgress | undefined) => Boolean(p && (p.status === 'completed' || p.firstCompletedAt));

  function summarize(viewerId: string, room: Row, topics: Topic[], members: string[], users: Map<string, Row>, statuses: Record<string, LiveStatus>, nextTopic: RoomSummary['nextTopic']): RoomSummary {
    const ordered = [...members].sort((a, b) => (a === viewerId ? -1 : b === viewerId ? 1 : 0));
    const active = topics.filter((t) => t.status === 'active');
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      startDate: room.start_date,
      endDate: room.end_date,
      color: room.color,
      status: room.status,
      createdBy: room.creator_id,
      createdAt: room.created_at,
      members: ordered
        .filter((uid) => users.has(uid))
        .map((uid) => ({
          user: toPublicUser(users.get(uid)!),
          completed: active.filter((t) => t.createdBy === uid && isDone(t.progress[uid])).length,
          total: active.filter((t) => t.createdBy === uid).length,
          focusedMs: topics.reduce((sum, t) => sum + (t.progress[uid]?.focusedMs ?? 0), 0),
          status: statuses[uid] ?? { state: 'idle', todayFocusedMs: 0 },
        })),
      nextTopic: room.status === 'active' ? nextTopic : null,
    };
  }

  async function roomsData(roomFilter?: string): Promise<{ viewer: string; summaries: RoomSummary[]; topics: Topic[]; rooms: Row[] }> {
    const viewer = await myId();
    // Rooms come with their members' profiles. For a single room we already know its id, so its topics
    // and next topic load at the same time; for the list they follow once the room ids are known.
    let query = sb
      .from('rooms')
      .select('*, room_members(user_id, joined_at, profiles(*))')
      .eq('room_members.status', 'active')
      .order('status')
      .order('updated_at', { ascending: false })
      .order('joined_at', { referencedTable: 'room_members' });
    if (roomFilter) query = query.eq('id', roomFilter);
    const roomExtras = (roomIds: string[]) =>
      Promise.all([loadTopics(roomIds, true), Promise.all(roomIds.map((r) => rpc<RoomSummary['nextTopic']>('room_next_topic', { p_room: r })))]);
    let rooms: Row[];
    let topics: Topic[];
    let next: RoomSummary['nextTopic'][];
    if (roomFilter) {
      // Someone outside the room gets "not found", never an error from the room's details.
      const { values, error } = await together([rows(query), roomExtras([roomFilter])] as const);
      rooms = values[0] ?? [];
      if (!rooms.length) return { viewer, summaries: [], topics: [], rooms };
      if (error) throw error;
      [topics, next] = values[1]!;
    } else {
      rooms = await rows(query);
      [topics, next] = await roomExtras(rooms.map((r) => r.id));
    }
    const memberRows = rooms.flatMap((r) => (r.room_members ?? []).map((m: Row) => ({ ...m, room_id: r.id })));
    const users = new Map<string, Row>(memberRows.filter((m) => m.profiles).map((m) => [m.user_id, m.profiles]));
    const statuses = await liveStatuses(ids(memberRows.map((m) => m.user_id)));
    const summaries = rooms.map((r, i) =>
      summarize(
        viewer,
        r,
        topics.filter((t) => t.roomId === r.id),
        memberRows.filter((m) => m.room_id === r.id).map((m) => m.user_id),
        users,
        statuses,
        next[i] ?? null,
      ),
    );
    return { viewer, summaries, topics, rooms };
  }

  async function listRooms(): Promise<RoomSummary[]> {
    return (await roomsData()).summaries;
  }

  async function roomDetail(roomId: string): Promise<RoomDetail> {
    const { values, error } = await together([
      roomsData(roomId),
      myId().then((id) => listActivity(id, { roomId, limit: 15 })),
      rpc<Row[]>('room_forest', { p_room: roomId }),
      rpc<number>('room_blooms', { p_room: roomId }),
      roomTasks(roomId),
    ] as const);
    const [data, activity, forest, blooms, goals] = values as unknown as [
      Awaited<ReturnType<typeof roomsData>> | undefined,
      Activity[],
      Row[],
      number,
      { goals: GoalRef[]; tasks: GoalTask[] } | undefined,
    ];
    if (data && !data.summaries.length) throw notFound('That room could not be found.');
    if (error) throw error;
    const { summaries, topics } = data!;
    return {
      ...summaries[0],
      topics: topics.filter((t) => t.status === 'active'),
      archivedTopics: topics.filter((t) => t.status === 'archived'),
      activity,
      forest: Object.fromEntries(forest.map((f) => [f.user_id, f.full_days])),
      blooms: blooms ?? 0,
      goals: goals?.goals ?? [],
      tasks: goals?.tasks ?? [],
    };
  }

  /** Both members' goals in a room and their tasks with real dates. */
  async function roomTasks(roomId: string): Promise<{ goals: GoalRef[]; tasks: GoalTask[] }> {
    const [list, roomTime] = await Promise.all([
      rpc<Row[]>('room_goals', { p_room: roomId }),
      rpc<Row[]>('room_topic_time', { p_room: roomId }).then((r) => new Map(r.map((x) => [x.topic_id, Number(x.ms)]))),
    ]);
    const plans: PlanRow[] = list.map((g) => ({ id: g.id, owner_id: g.owner_id, title: g.title, start_date: g.start_date, sprint_days: 7, status: 'active', created_at: 0 }));
    const tasks = await planTasks(ids(plans.map((x) => x.id)), async () => roomTime);
    return {
      goals: plans.map((x) => ({ id: x.id, title: x.title, ownerId: x.owner_id })),
      tasks: plans.flatMap((x) => goalTasks(x, tasks.get(x.id) ?? [])),
    };
  }

  // ───────────── goals (plans) ─────────────

  /** Tasks with done state and time. `timeFor` supplies focused time per topic. */
  const PLAN_TASK_COLUMNS = '*, topics(description, subtopics(id, title, done_at, planned_for, est_minutes, position), topic_completions(local_date))';

  async function planTasks(planIds: string[], timeFor: (topicIds: string[]) => Promise<Map<string, number>>, days?: { min: number; max: number }, loaded?: Row[]): Promise<Map<string, PlanTask[]>> {
    const byPlan = new Map<string, PlanTask[]>(planIds.map((id) => [id, []]));
    if (!planIds.length) return byPlan;
    let query = sb
      .from('plan_tasks')
      .select(PLAN_TASK_COLUMNS)
      .in('plan_id', planIds)
      .eq('status', 'active')
      .eq('topics.topic_completions.kind', 'first')
      .is('topics.topic_completions.revoked_at', null)
      .order('day', { nullsFirst: false })
      .order('position')
      .order('created_at');
    if (days) query = query.or(`and(day.gte.${days.min},day.lte.${days.max}),and(planned_day.gte.${days.min},planned_day.lte.${days.max})`);
    const list = loaded ?? (await rows(query));
    const topicIds = ids(list.map((t) => t.topic_id));
    const [time, today, partsToday] = await Promise.all([
      topicIds.length ? timeFor(topicIds) : new Map<string, number>(),
      activeToday(topicIds),
      activeParts(topicIds),
    ]);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const doneOn = new Map(list.filter((t) => t.topics?.topic_completions?.length).map((t) => [t.topic_id, t.topics.topic_completions[0].local_date as string]));
    for (const t of list) {
      const doneDate = t.topic_id ? (doneOn.get(t.topic_id) ?? null) : null;
      const parts = countParts(t.topics?.subtopics);
      byPlan.get(t.plan_id)!.push({
        id: t.id,
        day: t.day,
        plannedDay: t.planned_day,
        title: t.title,
        // A topic with subtopics takes as long as they do together.
        estMinutes: (t.topics?.subtopics ?? []).reduce((sum: number, x: Row) => sum + (x.est_minutes ?? 0), 0) || t.est_minutes,
        starred: t.starred,
        topicId: t.topic_id,
        done: doneDate !== null && !partsOpen(parts),
        doneDate,
        focusedMs: t.topic_id ? (time.get(t.topic_id) ?? 0) : 0,
        description: t.topics?.description ?? '',
        parts,
        activeToday: Boolean(t.topic_id && today.has(t.topic_id)),
        partList: [...(t.topics?.subtopics ?? [])]
          .sort((a: Row, b: Row) => a.position - b.position)
          .map((s: Row) => ({ id: s.id, title: s.title, date: s.planned_for, estMinutes: s.est_minutes, doneDate: s.done_at === null ? null : localDate(s.done_at, tz), activeToday: partsToday.has(s.id) })),
      });
    }
    return byPlan;
  }

  const myTime = async (topicIds: string[]) => new Map((await rpc<Row[]>('my_topic_time', { p_topics: topicIds })).map((r) => [r.topic_id, Number(r.ms)]));

  async function ownPlans(): Promise<{ me: Me; plans: PlanRow[]; spans: Map<string, SprintSpan[]>; tasks: Map<string, PlanTask[]> }> {
    const viewer = await me();
    // Goals arrive with their sprints and active tasks in one request.
    const plans = await rows<PlanRow & { plan_sprints: Row[]; plan_tasks: Row[] }>(
      sb
        .from('plans')
        .select(`*, rooms(name), plan_sprints(*, rooms(name)), plan_tasks(${PLAN_TASK_COLUMNS})`)
        .eq('owner_id', viewer.id)
        .eq('plan_tasks.status', 'active')
        .eq('plan_tasks.topics.topic_completions.kind', 'first')
        .is('plan_tasks.topics.topic_completions.revoked_at', null)
        .order('status')
        .order('start_date', { ascending: false })
        .order('day', { referencedTable: 'plan_tasks', nullsFirst: false })
        .order('position', { referencedTable: 'plan_tasks' })
        .order('created_at', { referencedTable: 'plan_tasks' }),
    );
    const planIds = plans.map((p) => p.id);
    const sprintRows = plans.flatMap((p) => p.plan_sprints ?? []);
    const tasks = await planTasks(planIds, myTime, undefined, plans.flatMap((p) => p.plan_tasks ?? []));
    const spans = new Map(planIds.map((id) => [id, spansOf(sprintRows.filter((s) => s.plan_id === id).map(toSprintRow))]));
    return { me: viewer, plans, spans, tasks };
  }

  const toSprintRow = (s: Row): SprintRow => ({ plan_id: s.plan_id, number: s.number, days: s.days, room_id: s.room_id, room_name: s.rooms?.name ?? null, completed_at: s.completed_at });

  async function listPlans(own = ownPlans()) {
    const { me: viewer, plans, spans, tasks } = await own;
    return plans.map((p) => summarizePlan(p, spans.get(p.id)!, tasks.get(p.id)!, viewer.today));
  }

  async function getPlan(planId: string) {
    const { me: viewer, plans, spans, tasks } = await ownPlans();
    const plan = plans.find((p) => p.id === planId);
    if (!plan) throw notFound('That goal could not be found.');
    return buildPlan(plan, spans.get(plan.id)!, tasks.get(plan.id)!, viewer.today);
  }

  // ───────────── activity & friends ─────────────

  async function listActivity(viewerId: string, opts: { roomId?: string; withUserId?: string; limit?: number } = {}): Promise<Activity[]> {
    let query = sb.from('activities').select('*, rooms(name), actor:profiles!actor_id(*)').order('created_at', { ascending: false }).limit(opts.limit ?? 30);
    if (opts.roomId) query = query.eq('room_id', opts.roomId);
    if (opts.withUserId) query = query.or(`actor_id.eq.${opts.withUserId},recipient_id.eq.${opts.withUserId}`);
    const list = await rows(query);
    const refIds = ids(list.map((a) => a.ref_id));
    const actors = new Map<string, Row>(list.filter((a) => a.actor).map((a) => [a.actor_id, a.actor]));
    const [topics, rooms] = await Promise.all([
      refIds.length ? rows(sb.from('topics').select('id, title').in('id', refIds)) : Promise.resolve([] as Row[]),
      refIds.length ? rows(sb.from('rooms').select('id, name').in('id', refIds)) : Promise.resolve([] as Row[]),
    ]);
    const titles = new Map([...topics.map((t) => [t.id, t.title] as const), ...rooms.map((r) => [r.id, r.name] as const)]);
    return list
      .filter((a) => actors.has(a.actor_id))
      .map((a) => ({
        id: a.id,
        type: a.type,
        actor: toPublicUser(actors.get(a.actor_id)!),
        recipientId: a.recipient_id,
        roomId: a.room_id,
        roomName: a.rooms?.name ?? null,
        reaction: a.reaction,
        message: a.message,
        refTitle: (a.ref_id && titles.get(a.ref_id)) ?? null,
        createdAt: a.created_at,
        readAt: a.recipient_id === viewerId ? a.read_at : null,
      }));
  }

  async function unreadCount(viewerId: string): Promise<number> {
    const { count, error } = await sb.from('activities').select('id', { count: 'exact', head: true }).eq('recipient_id', viewerId).is('read_at', null);
    if (error) throw fromSupabase(error);
    return count ?? 0;
  }

  async function recentCompletions(userId: string, limit = 5): Promise<CompletionSummary[]> {
    // RLS limits this to rooms you share with them.
    const list = await rows(
      sb.from('topic_completions').select('topic_id, completed_at, topics(title, room_id, rooms(name))').eq('user_id', userId).eq('kind', 'first').is('revoked_at', null).order('completed_at', { ascending: false }).limit(limit),
    );
    return list.filter((c) => c.topics).map((c) => ({ topicId: c.topic_id, topicTitle: c.topics.title, roomId: c.topics.room_id, roomName: c.topics.rooms?.name ?? '', completedAt: c.completed_at }));
  }

  async function friendsAndRequests(): Promise<{ friends: Friend[]; requests: FriendRequest[] }> {
    const viewer = await myId();
    const list = await rows(
      sb.from('friendships').select('*, requester:profiles!requester_id(*), recipient:profiles!recipient_id(*)').in('status', ['accepted', 'pending']).order('created_at', { ascending: false }),
    );
    const other = (f: Row) => (f.requester_id === viewer ? f.recipient_id : f.requester_id);
    const users = new Map<string, Row>(list.map((f) => [other(f), f.requester_id === viewer ? f.recipient : f.requester] as const).filter(([, u]) => u));
    const accepted = list.filter((f) => f.status === 'accepted' && users.has(other(f))).sort((a, b) => (a.responded_at ?? 0) - (b.responded_at ?? 0));
    const [statuses, recent] = await Promise.all([liveStatuses(accepted.map(other)), Promise.all(accepted.map((f) => recentCompletions(other(f))))]);
    const friends = accepted.map((f, i) => ({
      friendshipId: f.id,
      since: f.responded_at ?? f.created_at,
      user: toPublicUser(users.get(other(f))!),
      status: statuses[other(f)] ?? { state: 'idle' as const, todayFocusedMs: 0 },
      recentCompletions: recent[i],
    }));
    const requests = list
      .filter((f) => f.status === 'pending' && users.has(other(f)))
      .map((f) => ({ id: f.id, direction: (f.requester_id === viewer ? 'outgoing' : 'incoming') as FriendRequest['direction'], user: toPublicUser(users.get(other(f))!), createdAt: f.created_at }));
    return { friends, requests };
  }

  async function searchUsers(q: string): Promise<UserSearchResult[]> {
    const viewer = await myId();
    const term = q.trim().toLowerCase().replace(/^@/, '');
    if (term.length < 2) return [];
    const escaped = term.replace(/[\\%_]/g, (c) => '\\' + c);
    const found = await rows(sb.from('profiles').select('*').like('username', `${escaped}%`).order('username').limit(10));
    found.sort((a, b) => Number(b.username === term) - Number(a.username === term));
    const pairs = await rows(sb.from('friendships').select('*').in('status', ['accepted', 'pending']));
    return found.map((u) => {
      if (u.id === viewer) return { user: toPublicUser(u), relation: 'self' as const };
      const pair = pairs.find((f) => f.requester_id === u.id || f.recipient_id === u.id);
      const relation: UserSearchResult['relation'] = !pair ? 'none' : pair.status === 'accepted' ? 'friend' : pair.requester_id === viewer ? 'pending_outgoing' : 'pending_incoming';
      return { user: toPublicUser(u), relation };
    });
  }

  async function friendProfile(friendId: string) {
    const viewer = await myId();
    const { values, error } = await together([
      friendIds(viewer),
      profiles([friendId]),
      liveStatuses([friendId]),
      recentCompletions(friendId, 10),
      listRooms(),
      listActivity(viewer, { withUserId: friendId, limit: 20 }),
      rpc<ProgressStats>('progress_stats', { p_user: friendId }),
    ] as const);
    if (!values[0]?.includes(friendId)) throw error && !values[0] ? error : notFound('That person is not in your friends list.');
    if (error) throw error;
    const [, people, status, recent, rooms, activity, stats] = values as unknown as [string[], Map<string, Row>, Record<string, LiveStatus>, CompletionSummary[], RoomSummary[], Activity[], ProgressStats];
    const user = people.get(friendId)!;
    return {
      user: toPublicUser(user),
      status: status[friendId],
      recentCompletions: recent,
      rooms: rooms.filter((r) => r.members.some((m) => m.user.id === friendId)),
      activity,
      stats,
    };
  }

  // ───────────── sessions ─────────────

  async function listSessions(viewerId: string): Promise<SessionRecord[]> {
    const list = await rows(
      sb.from('study_sessions').select('*, topics(title), subtopics(title), rooms(name), session_corrections(old_ms, new_ms, reason, created_at), session_pauses(paused_at, resumed_at)').eq('user_id', viewerId).order('started_at', { ascending: false }).limit(50),
    );
    return list.map((s) => {
      const live = s.state === 'running' || s.state === 'paused';
      const pauses = (s.session_pauses ?? []).map((p: Row) => ({ pausedAt: p.paused_at, resumedAt: p.resumed_at }));
      return {
        id: s.id,
        roomId: s.room_id,
        roomName: s.rooms?.name ?? '',
        topicId: s.topic_id,
        topicTitle: s.topics?.title ?? '',
        subtopicTitle: s.subtopics?.title ?? null,
        state: s.state,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        focusedMs: live ? focusedMs({ startedAt: s.started_at, endedAt: null, pauses }, now()) : (s.focused_ms ?? 0),
        measuredMs: s.measured_ms,
        isRevision: s.is_revision,
        note: s.note,
        corrections: [...(s.session_corrections ?? [])]
          .sort((a: Row, b: Row) => a.created_at - b.created_at)
          .map((c: Row) => ({ oldMs: c.old_ms, newMs: c.new_ms, reason: c.reason, createdAt: c.created_at })),
      };
    });
  }

  // ───────────── home ─────────────

  async function home(): Promise<HomeData> {
    const viewer = await me();
    const today = viewer.today;
    const own = ownPlans();
    const [roomsAll, plans, ownLoaded, friends, stats, completedToday, unread, activeSession] = await Promise.all([
      listRooms(),
      listPlans(own),
      own,
      friendsAndRequests(),
      rpc<ProgressStats>('progress_stats', { p_user: viewer.id }),
      rows(sb.from('topic_completions').select('topic_id, completed_at, topics(title, room_id, rooms(name))').eq('user_id', viewer.id).eq('local_date', today).is('revoked_at', null).order('completed_at', { ascending: false })),
      unreadCount(viewer.id),
      rpc<ActiveSession | null>('active_session'),
    ]);
    const rooms = roomsAll.filter((r) => r.status === 'active');
    // Everything planned in your active goals that live in a room: subtopics by their day, small topics whole.
    const items = ownLoaded.plans
      .filter((p) => p.status === 'active' && p.room_id)
      .flatMap((p) => plannedItems(goalTasks(p, ownLoaded.tasks.get(p.id) ?? [])));
    const open = items.filter((t) => !t.done && t.date !== null).sort((a, b) => a.date!.localeCompare(b.date!));
    const scheduled = open.find((t) => t.date === today);
    const room = rooms.find((r) => r.nextTopic);
    const primary: HomeData['primary'] = scheduled
      ? { kind: 'item', item: scheduled }
      : room?.nextTopic
        ? { kind: 'topic', roomId: room.id, roomName: room.name, topicId: room.nextTopic.id, topicTitle: room.nextTopic.title }
        : null;
    return {
      me: viewer,
      activeSession,
      primary,
      friends: friends.friends,
      today: {
        focusedMs: stats.todayMs,
        completedTopics: completedToday.filter((c) => c.topics).map((c) => ({ topicId: c.topic_id, topicTitle: c.topics.title, roomId: c.topics.room_id, roomName: c.topics.rooms?.name ?? '', completedAt: c.completed_at })),
        partsDone: items.filter((t) => t.subtopicId && t.doneDate === today).length,
      },
      plans: plans.filter((p) => p.status === 'active').slice(0, 4),
      rooms,
      comingUp: open.filter((t) => t.date! >= today && t.date! <= addDays(today, 14)).slice(0, 8),
      unread,
    };
  }

  // ───────────── auth ─────────────

  async function signUp(body: unknown): Promise<{ me: Me }> {
    const input = parse(v.signUpSchema, body);
    if (!(await rpc<boolean>('username_available', { p_username: input.username }))) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'That username is taken. Try another one.', { field: 'username' });
    }
    const { data, error } = await sb.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: {
          username: input.username,
          display_name: input.displayName,
          profile_type: input.profileType,
          accent: input.accent,
          bio: input.bio ?? '',
          avatar: input.avatar,
          timezone: input.timezone,
        },
      },
    });
    if (error) throw new ApiError(error.status ?? 400, 'SIGNUP_FAILED', /registered|exists/i.test(error.message) ? 'An account with that email already exists. Try signing in.' : error.message);
    if (!data.session) throw new ApiError(400, 'CONFIRM_EMAIL', 'Check your inbox to confirm your email, then sign in.');
    return { me: await me() };
  }

  async function signIn(body: unknown): Promise<{ me: Me }> {
    const input = parse(v.signInSchema, body);
    const { error } = await sb.auth.signInWithPassword({ email: input.email, password: input.password });
    if (error) throw new ApiError(400, 'BAD_CREDENTIALS', /confirm/i.test(error.message) ? 'Please confirm your email first.' : 'That email and password do not match.');
    return { me: await me() };
  }

  // A reset email signs you in through its link, then you choose a new password. We never say whether
  // an email has an account, so the reply is the same either way.
  async function forgotPassword(body: unknown): Promise<{ ok: true }> {
    const input = parse(v.forgotPasswordSchema, body);
    const { error } = await sb.auth.resetPasswordForEmail(input.email, { redirectTo: input.redirectTo });
    if (error?.status === 429) throw new ApiError(429, 'TOO_MANY', 'Too many reset emails just now. Please wait a few minutes and try again.');
    if (error) throw new ApiError(error.status ?? 400, 'RESET_FAILED', 'We could not send the email. Please try again in a moment.');
    return { ok: true };
  }

  async function setPassword(body: unknown): Promise<{ ok: true }> {
    const input = parse(v.newPasswordSchema, body);
    await myId();
    const { error } = await sb.auth.updateUser({ password: input.password });
    if (error?.code === 'same_password') throw new ApiError(400, 'SAME_PASSWORD', 'Choose a password different from your old one.', { field: 'password' });
    if (error?.code === 'weak_password') throw new ApiError(400, 'WEAK_PASSWORD', 'That password is too easy to guess. Try a longer one.', { field: 'password' });
    if (error) throw new ApiError(error.status ?? 400, 'PASSWORD_FAILED', 'We could not change your password. Please try again.');
    return { ok: true };
  }

  // ───────────── router ─────────────

  async function request(method: Method, fullPath: string, body?: any): Promise<any> {
    const [path, queryString] = fullPath.split('?');
    const query = new URLSearchParams(queryString ?? '');
    const seg = path.split('/').filter(Boolean);
    const route = `${method} /${seg.map((s, i) => (isId(s, seg[i - 1]) ? ':id' : s)).join('/')}`;
    const p = seg.filter((s, i) => isId(s, seg[i - 1]));

    switch (route) {
      case 'POST /auth/signup':
        return signUp(body);
      case 'POST /auth/signin':
        return signIn(body);
      case 'POST /auth/forgot':
        return forgotPassword(body);
      case 'PUT /auth/password':
        return setPassword(body);
      case 'POST /auth/signout':
        meCache = null;
        await sb.auth.signOut();
        return { ok: true };
      case 'GET /me':
        return { me: await me() };
      case 'PATCH /me': {
        const input = parse(v.profileUpdateSchema, body);
        const id = await myId();
        const patch: Row = {};
        if (input.displayName !== undefined) patch.display_name = input.displayName;
        if (input.profileType !== undefined) patch.profile_type = input.profileType;
        if (input.accent !== undefined) patch.accent = input.accent;
        else if (input.profileType) patch.accent = { engineer: 'blue', doctor: 'pink', custom: undefined }[input.profileType];
        if (patch.accent === undefined) delete patch.accent;
        if (input.bio !== undefined) patch.bio = input.bio;
        if (input.avatar !== undefined) patch.avatar = input.avatar;
        if (input.colorScheme !== undefined) patch.color_scheme = input.colorScheme;
        if (input.timezone !== undefined) patch.timezone = input.timezone;
        if (input.shareStatus !== undefined) patch.share_status = input.shareStatus;
        if (input.prefs !== undefined) patch.prefs = { ...(await profiles([id])).get(id)?.prefs, ...input.prefs }; // fresh, not the cached copy
        await rows(sb.from('profiles').update(patch).eq('id', id).select('id'));
        meCache = null;
        return { me: await me() };
      }
      case 'GET /home':
        return home();

      case 'GET /users/search':
        return { results: await searchUsers(query.get('q') ?? '') };
      case 'GET /friends':
        return friendsAndRequests();
      case 'POST /friends/requests': {
        if (!body?.userId) throw new ApiError(400, 'BAD_REQUEST', 'Choose someone to add.');
        return rpc('send_friend_request', { p_user: body.userId });
      }
      case 'POST /friends/requests/:id/accept':
      case 'POST /friends/requests/:id/reject':
        await rpc('respond_friend_request', { p_id: p[0], p_accept: seg[3] === 'accept' });
        return { ok: true };
      case 'POST /friends/requests/:id/cancel':
        await rpc('cancel_friend_request', { p_id: p[0] });
        return { ok: true };
      case 'GET /friends/:id':
        return friendProfile(p[0]);
      case 'POST /friends/:id/remove':
        return rpc('unfriend', { p_user: p[0], p_leave_rooms: Boolean(body?.leaveRooms) });
      case 'POST /encourage': {
        const input = parse(v.encourageSchema, body);
        return { id: await rpc('encourage', { p_recipient: input.recipientId, p_reaction: input.reaction ?? null, p_message: input.message ?? null, p_room: input.roomId ?? null }) };
      }
      case 'GET /activity': {
        const viewer = await myId();
        const [activity, unread] = await Promise.all([listActivity(viewer, { limit: 40 }), unreadCount(viewer)]);
        return { activity, unread };
      }
      case 'POST /activity/read':
        await rpc('mark_activity_read');
        return { ok: true };

      case 'GET /rooms':
        return { rooms: await listRooms() };
      case 'POST /rooms': {
        const input = parse(v.roomCreateSchema, body);
        return { id: await rpc('create_room', { p_friend: input.friendId, p_name: input.name, p_description: input.description ?? '', p_start: input.startDate, p_end: input.endDate, p_color: input.color ?? 'sage' }) };
      }
      case 'GET /rooms/:id':
        return roomDetail(p[0]);
      case 'PATCH /rooms/:id': {
        const input = parse(v.roomUpdateSchema, body);
        const patch: Row = { updated_at: now() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        if (input.startDate !== undefined) patch.start_date = input.startDate;
        if (input.endDate !== undefined) patch.end_date = input.endDate;
        if (input.color !== undefined) patch.color = input.color;
        if (input.status !== undefined) patch.status = input.status;
        const updated = await rows(sb.from('rooms').update(patch).eq('id', p[0]).select('id'));
        if (!updated.length) throw notFound('That room could not be found.');
        return { ok: true };
      }
      case 'POST /rooms/:id/leave':
        await rpc('leave_room', { p_room: p[0] });
        return { ok: true };
      case 'POST /rooms/:id/topics': {
        const input = parse(v.topicCreateSchema, body);
        return {
          id: await rpc('create_topic', {
            p_room: p[0],
            p_title: input.title,
            p_description: input.description ?? '',
            p_category: input.category ?? '',
            p_estimated: input.estimatedMinutes ?? null,
            p_target: input.sessionTargetMinutes ?? null,
            p_deadline: input.deadline ?? null,
          }),
        };
      }
      case 'GET /topics/:id': {
        const t = (await rows(sb.from('topics').select('id, room_id, rooms(name)').eq('id', p[0])))[0];
        if (!t) throw notFound('That topic could not be found.');
        return { topicId: t.id, roomId: t.room_id, roomName: t.rooms?.name ?? '' };
      }
      case 'PATCH /topics/:id':
        await rpc('update_topic', { p_topic: p[0], p_patch: parse(v.topicUpdateSchema, body) });
        return { ok: true };
      case 'DELETE /topics/:id':
        await rpc('update_topic', { p_topic: p[0], p_patch: { status: 'archived' } });
        return { ok: true };
      case 'POST /topics/:id/complete': {
        const input = parse(v.sessionFinishSchema, body ?? {});
        return rpc('complete_topic', { p_topic: p[0], p_confirm_long: input.confirmLong ?? false, p_corrected: input.correctedMinutes ?? null, p_note: input.note ?? null });
      }
      case 'POST /topics/:id/reopen':
        await rpc('reopen_topic', { p_topic: p[0], p_mode: body?.mode === 'undo' ? 'undo' : 'revise' });
        return { ok: true };
      case 'GET /topics/:id/subtopics':
        return { subtopics: await rpc('topic_subtopics', { p_topic: p[0] }) };
      case 'POST /topics/:id/subtopics': {
        const input = parse(v.subtopicCreateSchema, body);
        return { id: await rpc('add_subtopic', { p_topic: p[0], p_title: input.title, p_date: input.date ?? null, p_est: input.estMinutes ?? null }) };
      }
      case 'PATCH /subtopics/:id':
        return rpc('update_subtopic', { p_id: p[0], p_patch: parse(v.subtopicUpdateSchema, body) });
      case 'DELETE /subtopics/:id':
        await rpc('delete_subtopic', { p_id: p[0] });
        return { ok: true };
      case 'POST /topics/:id/merge':
        await rpc('merge_topic', { p_from: p[0], p_into: parse(v.topicMergeSchema, body).intoId });
        return { ok: true };
      case 'GET /topics/:id/history': {
        const [events, sessions] = await Promise.all([
          rows(sb.from('topic_events').select('*').eq('topic_id', p[0]).order('created_at', { ascending: false }).limit(100)),
          rpc<Row[]>('topic_sessions', { p_topic: p[0] }),
        ]);
        return {
          events: events.map((e) => ({ id: e.id, type: e.type, userId: e.user_id, detail: e.detail, createdAt: e.created_at })),
          sessions: sessions.map((s) => ({ userId: s.user_id, startedAt: s.started_at, focusedMs: Number(s.focused_ms), isRevision: s.is_revision })),
        };
      }

      case 'GET /sessions/active':
        return { session: await rpc('active_session') };
      case 'GET /sessions':
        return { sessions: await listSessions(await myId()) };
      case 'POST /sessions': {
        const input = parse(v.sessionStartSchema, body);
        const session = await rpc<ActiveSession>('start_session', { p_topic: input.topicId, p_target: input.targetMinutes ?? null, p_remind: input.remindAfterHour ?? false });
        // On a subtopic (Subtopics): label the session as soon as it starts.
        if (input.subtopicId) return { session: await rpc('set_session_subtopic', { p_session: session.id, p_subtopic: input.subtopicId }) };
        return { session };
      }
      case 'POST /sessions/:id/subtopic':
        return { session: await rpc('set_session_subtopic', { p_session: p[0], p_subtopic: parse(v.sessionSubtopicSchema, body).subtopicId }) };
      case 'POST /sessions/:id/pause':
        return { session: await rpc('pause_session', { p_session: p[0] }) };
      case 'POST /sessions/:id/resume':
        return { session: await rpc('resume_session', { p_session: p[0] }) };
      case 'POST /sessions/:id/finish': {
        const input = parse(v.sessionFinishSchema, body ?? {});
        return rpc('finish_session', { p_session: p[0], p_complete: input.completeTopic ?? false, p_confirm_long: input.confirmLong ?? false, p_corrected: input.correctedMinutes ?? null, p_note: input.note ?? null });
      }
      case 'POST /sessions/:id/split': {
        const input = parse(v.sessionSplitSchema, body);
        return rpc('finish_session_split', { p_session: p[0], p_parts: input.parts, p_complete: input.completeTopic ?? false, p_note: input.note ?? null });
      }
      case 'POST /sessions/:id/discard':
        await rpc('discard_session', { p_session: p[0] });
        return { ok: true };
      case 'POST /sessions/:id/correct': {
        const input = parse(v.sessionCorrectSchema, body);
        return { session: await rpc('correct_session', { p_session: p[0], p_minutes: input.minutes, p_reason: input.reason ?? '' }) };
      }
      case 'PATCH /sessions/:id':
        await rpc('update_session', { p_session: p[0], p_patch: parse(v.sessionUpdateSchema, body) });
        return { ok: true };

      case 'GET /plans':
        return { plans: await listPlans() };
      case 'POST /plans': {
        const input = parse(v.planCreateSchema, body);
        if ('roomId' in input) return { id: await rpc('create_goal', { p_title: input.title, p_room: input.roomId }) };
        return { id: await rpc('create_plan', { p_title: input.title, p_start: input.startDate, p_sprint_days: input.sprintDays }) };
      }
      case 'GET /plans/:id':
        return { plan: await getPlan(p[0]) };
      case 'PATCH /plans/:id': {
        const { roomId, ...patch } = parse(v.planUpdateSchema, body);
        if (Object.keys(patch).length) await rpc('update_plan', { p_plan: p[0], p_patch: patch });
        if (roomId) await rpc('set_goal_room', { p_plan: p[0], p_room: roomId });
        return { ok: true };
      }
      case 'POST /plans/:id/merge':
        return { moved: await rpc('merge_goal', { p_from: p[0], p_into: parse(v.goalMergeSchema, body).into }) };
      case 'POST /plans/:id/goal-tasks': {
        const input = parse(v.goalTaskCreateSchema, body);
        const id = await rpc<string>('add_goal_task', { p_plan: p[0], p_date: input.date, p_title: input.title, p_est: input.estMinutes ?? null });
        // Its topic too, so subtopics can be added straight away.
        const topicId = ((await rows(sb.from('plan_tasks').select('topic_id').eq('id', id)))[0]?.topic_id as string | undefined) ?? null;
        return { id, topicId };
      }
      case 'POST /rooms/:id/tasks': {
        const input = parse(v.goalTaskCreateSchema, body);
        return { id: await rpc('add_room_task', { p_room: p[0], p_plan: input.planId ?? null, p_date: input.date, p_title: input.title, p_est: input.estMinutes ?? null }) };
      }
      case 'PATCH /goal-tasks/:id':
        await rpc('edit_goal_task', { p_task: p[0], p_patch: parse(v.goalTaskUpdateSchema, body) });
        return { ok: true };
      case 'DELETE /plan-tasks/:id':
        await rpc('remove_plan_task', { p_task: p[0] });
        return { ok: true };

      case 'GET /progress': {
        const userId = query.get('userId') ?? (await myId());
        return { stats: await rpc('progress_stats', { p_user: userId }) };
      }
      case 'POST /push/subscribe':
        if (!body?.endpoint || !body?.p256dh || !body?.auth) throw new ApiError(400, 'BAD_REQUEST', 'That notification subscription isn’t valid.');
        await rpc('save_push_subscription', { p_endpoint: body.endpoint, p_p256dh: body.p256dh, p_auth: body.auth });
        return { ok: true };
      case 'POST /push/unsubscribe':
        await rpc('delete_push_subscription', { p_endpoint: String(body?.endpoint ?? '') });
        return { ok: true };
      case 'POST /together/join': {
        const input = parse(v.joinStudySchema, body);
        return { session: await rpc('join_study', { p_friend: input.friendId, p_topic: input.topicId, p_target: input.targetMinutes ?? null }) };
      }
      case 'GET /together/:id': {
        const together = await rpc('together_json', { p_id: p[0] });
        if (!together) throw notFound('That study-together session could not be found.');
        return { together };
      }
      case 'POST /together/:id/break':
        return { together: await rpc('together_break', { p_id: p[0], p_on: Boolean(body?.on) }) };
      case 'GET /photos':
        return { photos: await rpc('my_photo_cheers') };
      case 'POST /photos': {
        const input = parse(v.photoCheerSchema, body);
        return { photo: await rpc('send_photo_cheer', { p_to: input.to, p_image: input.image, p_caption: input.caption ?? '', p_reply_to: input.replyTo ?? null }) };
      }
      case 'POST /photos/:id/seen':
        await rpc('seen_photo_cheer', { p_id: p[0] });
        return { ok: true };
      case 'POST /photos/:id/heart':
        await rpc('heart_photo_cheer', { p_id: p[0] });
        return { ok: true };
      case 'GET /routine':
        return { routine: await rpc('routine_of', { p_user: query.get('userId') ?? (await myId()) }) };
      case 'PUT /routine':
        return { routine: await rpc('set_routine', { p: parse(v.routineSchema, body) }) };
      case 'POST /cam/signal': {
        const m = parse(v.camSignalSchema, body);
        await rpc('send_cam_signal', { p_to: m.to, p_call: m.callId, p_kind: m.kind, p_payload: m.payload });
        return { ok: true };
      }
      case 'PUT /routine/day': {
        const { date, hours } = parse(v.dayHoursSchema, body);
        return { routine: await rpc('set_day_hours', { p_date: date, p_hours: hours }) };
      }
      case 'GET /challenge':
        return rpc('current_challenge', { p_friend: query.get('friendId'), p_week: query.get('week') });
      case 'POST /challenge': {
        const input = parse(v.challengeSchema, body);
        return { id: await rpc('set_challenge', { p_friend: input.friendId, p_week: input.week, p_kind: input.kind, p_target: input.target }) };
      }
      case 'POST /challenge/:id/cancel':
        await rpc('cancel_challenge', { p_id: p[0] });
        return { ok: true };
      case 'GET /recap':
        return { people: (await rpc('week_recap', { p_from: query.get('from'), p_to: query.get('to') })) ?? [] };
      case 'GET /revisions':
        return { revisions: await rpc('due_revisions', { p_days_ahead: Number(query.get('ahead') ?? 0) || 0 }) };
      case 'GET /progress/hours': {
        const userId = query.get('userId') ?? (await myId());
        return { report: await rpc('hours_report', { p_user: userId, p_from: query.get('from'), p_to: query.get('to') }) };
      }
    }
    throw notFound('Unknown route.');
  }

  return { request, serverNow: () => rpc<number>('server_now') };
}

/** Path segments that are ids: uuids, sprint numbers, and the id after /requests/. */
function isId(s: string, prev?: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || ['rooms', 'topics', 'subtopics', 'sessions', 'plans', 'plan-tasks', 'friends', 'requests'].includes(prev ?? '') && !['requests', 'search', 'active', 'topics'].includes(s);
}

export type Backend = ReturnType<typeof createBackend>;
