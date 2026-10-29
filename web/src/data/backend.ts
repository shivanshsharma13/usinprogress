// The app's data layer, running in the browser against Supabase.
//
// Screens call request('GET', '/rooms/…') exactly as they did with the old server. Each path is answered
// here: reads go through row-level security (people only ever receive rows they may see), and every
// write is a database function that checks the signed-in user and runs atomically. Nothing in this file
// is trusted for security — the database enforces it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';
import * as v from '../../../shared/validation.ts';
import { addDays, addMonths, localDate } from '../../../shared/dates.ts';
import { focusedMs } from '../../../shared/timer.ts';
import { buildPlan, buildSprint, dateOf, sprintFor, spansOf, summarizePlan, type PlanRow, type SprintRow, type SprintSpan } from '../../../shared/planView.ts';
import type {
  Activity,
  ActiveSession,
  CalendarPlanItem,
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
  RoomSprint,
  RoomSummary,
  SessionRecord,
  SprintMark,
  Task,
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
    createdAt: p.created_at,
    today: localDate(now(), p.timezone),
  });

  async function profiles(list: string[]): Promise<Map<string, Row>> {
    if (!list.length) return new Map();
    const found = await rows(sb.from('profiles').select('*').in('id', list));
    return new Map(found.map((p) => [p.id, p]));
  }

  async function me(): Promise<Me> {
    const id = await myId();
    const p = (await profiles([id])).get(id);
    if (!p) throw unauthenticated();
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
    let query = sb.from('topics').select('*').in('room_id', roomIds).order('position').order('created_at');
    if (!includeArchived) query = query.eq('status', 'active');
    const topics = await rows(query);
    if (!topics.length) return [];
    const topicIds = topics.map((t) => t.id);
    const [progress, firsts, times, planLinks] = await Promise.all([
      rows(sb.from('topic_progress').select('*').in('topic_id', topicIds)),
      rows(sb.from('topic_completions').select('topic_id, user_id, completed_at').in('topic_id', topicIds).eq('kind', 'first').is('revoked_at', null)),
      Promise.all(roomIds.map((r) => rpc<Row[]>('room_topic_time', { p_room: r }))).then((x) => x.flat()),
      Promise.all(roomIds.map((r) => rpc<Row[]>('room_plan_topics', { p_room: r }))).then((x) => x.flat()),
    ]);
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
      };
    });
  }

  const isDone = (p: TopicMemberProgress | undefined) => Boolean(p && (p.status === 'completed' || p.firstCompletedAt));

  async function summarize(viewerId: string, room: Row, topics: Topic[], members: string[], users: Map<string, Row>, statuses: Record<string, LiveStatus>): Promise<RoomSummary> {
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
      nextTopic: room.status === 'active' ? await rpc('room_next_topic', { p_room: room.id }) : null,
    };
  }

  async function roomsData(roomFilter?: string): Promise<{ viewer: string; summaries: RoomSummary[]; topics: Topic[]; rooms: Row[] }> {
    const viewer = await myId();
    let query = sb.from('rooms').select('*').order('status').order('updated_at', { ascending: false });
    if (roomFilter) query = query.eq('id', roomFilter);
    const rooms = await rows(query);
    const roomIds = rooms.map((r) => r.id);
    const [topics, memberRows] = await Promise.all([
      loadTopics(roomIds, true),
      roomIds.length ? rows(sb.from('room_members').select('room_id, user_id, joined_at').in('room_id', roomIds).eq('status', 'active').order('joined_at')) : Promise.resolve([] as Row[]),
    ]);
    const everyone = ids(memberRows.map((m) => m.user_id));
    const [users, statuses] = await Promise.all([profiles(everyone), liveStatuses(everyone)]);
    const summaries = await Promise.all(
      rooms.map((r) =>
        summarize(
          viewer,
          r,
          topics.filter((t) => t.roomId === r.id),
          memberRows.filter((m) => m.room_id === r.id).map((m) => m.user_id),
          users,
          statuses,
        ),
      ),
    );
    return { viewer, summaries, topics, rooms };
  }

  async function listRooms(): Promise<RoomSummary[]> {
    return (await roomsData()).summaries;
  }

  async function roomDetail(roomId: string): Promise<RoomDetail> {
    const { viewer, summaries, topics } = await roomsData(roomId);
    if (!summaries.length) throw notFound('That room could not be found.');
    const [activity, sprints] = await Promise.all([listActivity(viewer, { roomId, limit: 15 }), sharedSprints(roomId)]);
    return {
      ...summaries[0],
      topics: topics.filter((t) => t.status === 'active'),
      archivedTopics: topics.filter((t) => t.status === 'archived'),
      activity,
      sprints,
    };
  }

  // ───────────── goals (plans) ─────────────

  /** Tasks with done state and time. `timeFor` supplies focused time per topic. */
  async function planTasks(planIds: string[], timeFor: (topicIds: string[]) => Promise<Map<string, number>>, days?: { min: number; max: number }): Promise<Map<string, PlanTask[]>> {
    const byPlan = new Map<string, PlanTask[]>(planIds.map((id) => [id, []]));
    if (!planIds.length) return byPlan;
    let query = sb.from('plan_tasks').select('*').in('plan_id', planIds).eq('status', 'active').order('day', { nullsFirst: false }).order('position').order('created_at');
    if (days) query = query.or(`and(day.gte.${days.min},day.lte.${days.max}),and(planned_day.gte.${days.min},planned_day.lte.${days.max})`);
    const list = await rows(query);
    const topicIds = ids(list.map((t) => t.topic_id));
    const [completions, time] = await Promise.all([
      topicIds.length ? rows(sb.from('topic_completions').select('topic_id, local_date').in('topic_id', topicIds).eq('kind', 'first').is('revoked_at', null)) : Promise.resolve([] as Row[]),
      topicIds.length ? timeFor(topicIds) : Promise.resolve(new Map<string, number>()),
    ]);
    const doneOn = new Map(completions.map((c) => [c.topic_id, c.local_date as string]));
    for (const t of list) {
      const doneDate = t.topic_id ? (doneOn.get(t.topic_id) ?? null) : null;
      byPlan.get(t.plan_id)!.push({
        id: t.id,
        day: t.day,
        plannedDay: t.planned_day,
        title: t.title,
        estMinutes: t.est_minutes,
        starred: t.starred,
        topicId: t.topic_id,
        done: doneDate !== null,
        doneDate,
        focusedMs: t.topic_id ? (time.get(t.topic_id) ?? 0) : 0,
      });
    }
    return byPlan;
  }

  const myTime = async (topicIds: string[]) => new Map((await rpc<Row[]>('my_topic_time', { p_topics: topicIds })).map((r) => [r.topic_id, Number(r.ms)]));

  async function ownPlans(): Promise<{ me: Me; plans: PlanRow[]; spans: Map<string, SprintSpan[]>; tasks: Map<string, PlanTask[]> }> {
    const viewer = await me();
    const plans = await rows<PlanRow>(sb.from('plans').select('*').eq('owner_id', viewer.id).order('status').order('start_date', { ascending: false }));
    const planIds = plans.map((p) => p.id);
    const [sprintRows, tasks] = await Promise.all([
      planIds.length ? rows(sb.from('plan_sprints').select('*, rooms(name)').in('plan_id', planIds)) : Promise.resolve([] as Row[]),
      planTasks(planIds, myTime),
    ]);
    const spans = new Map(planIds.map((id) => [id, spansOf(sprintRows.filter((s) => s.plan_id === id).map(toSprintRow))]));
    return { me: viewer, plans, spans, tasks };
  }

  const toSprintRow = (s: Row): SprintRow => ({ plan_id: s.plan_id, number: s.number, days: s.days, room_id: s.room_id, room_name: s.rooms?.name ?? null, completed_at: s.completed_at });

  async function listPlans() {
    const { me: viewer, plans, spans, tasks } = await ownPlans();
    return plans.map((p) => summarizePlan(p, spans.get(p.id)!, tasks.get(p.id)!, viewer.today));
  }

  async function getPlan(planId: string) {
    const { me: viewer, plans, spans, tasks } = await ownPlans();
    const plan = plans.find((p) => p.id === planId);
    if (!plan) throw notFound('That goal could not be found.');
    return buildPlan(plan, spans.get(plan.id)!, tasks.get(plan.id)!, viewer.today);
  }

  interface VisibleSprint {
    plan: PlanRow;
    span: SprintSpan;
  }

  /** Open sprints pulled into rooms you're in (optionally one room) — yours and your friend's. */
  async function visibleSprints(roomId?: string): Promise<VisibleSprint[]> {
    const list = await rpc<Row[]>('visible_sprints', { p_room: roomId ?? null });
    return list.map((s) => ({
      plan: { id: s.plan_id, owner_id: s.owner_id, title: s.plan_title, start_date: s.start_date, sprint_days: s.days, status: 'active', created_at: 0 },
      span: { plan_id: s.plan_id, number: s.number, days: s.days, room_id: s.room_id, room_name: s.room_name, completed_at: null, first: s.first_day, last: s.last_day },
    }));
  }

  async function sharedSprints(roomId: string): Promise<RoomSprint[]> {
    const list = await visibleSprints(roomId);
    if (!list.length) return [];
    const planIds = ids(list.map((s) => s.plan.id));
    const roomTime = new Map((await rpc<Row[]>('room_topic_time', { p_room: roomId })).map((r) => [r.topic_id, Number(r.ms)]));
    const tasks = await planTasks(planIds, async () => roomTime, {
      min: Math.min(...list.map((s) => s.span.first)),
      max: Math.max(...list.map((s) => s.span.last)),
    });
    const owners = await profiles(ids(list.map((s) => s.plan.owner_id)));
    return list.map(({ plan, span }) => {
      // Day status follows the owner's own calendar day.
      const today = localDate(now(), owners.get(plan.owner_id)?.timezone ?? 'UTC');
      return { ...buildSprint(plan, span, tasks.get(plan.id)!, today), planId: plan.id, planTitle: plan.title, ownerId: plan.owner_id };
    });
  }

  /** Goal tasks and sprint markers for a date range: all of yours, plus friends' pulled sprints. */
  async function calendarPlanItems(viewer: Me, from: string, to: string, friends: boolean): Promise<{ items: CalendarPlanItem[]; sprints: SprintMark[] }> {
    const own = await ownPlans();
    const shared = friends ? (await visibleSprints()).filter((s) => s.plan.owner_id !== viewer.id) : [];
    const friendPlanIds = ids(shared.map((s) => s.plan.id));
    const friendTasks = await planTasks(friendPlanIds, async () => new Map());
    const items: CalendarPlanItem[] = [];
    const marks: SprintMark[] = [];
    const add = (plan: PlanRow, spans: SprintSpan[], tasks: PlanTask[], mine: boolean) => {
      for (const s of spans) {
        const startDate = dateOf(plan, s.first);
        const endDate = dateOf(plan, s.last);
        if (startDate <= to && endDate >= from) marks.push({ planId: plan.id, planTitle: plan.title, ownerId: plan.owner_id, number: s.number, startDate, endDate, roomName: s.room_name });
      }
      for (const t of tasks) {
        if (t.day === null) continue;
        const date = dateOf(plan, t.day);
        const s = sprintFor(spans, t.day);
        if (date < from || date > to || !s) continue;
        items.push({
          id: t.id,
          planId: plan.id,
          planTitle: plan.title,
          sprintNumber: s.number,
          ownerId: plan.owner_id,
          title: t.title,
          date,
          estMinutes: t.estMinutes,
          done: t.done,
          topicId: mine ? t.topicId : null,
          roomId: s.room_id,
          roomName: s.room_name,
        });
      }
    };
    for (const p of own.plans.filter((x) => x.status === 'active')) add(p, own.spans.get(p.id)!, own.tasks.get(p.id)!, true);
    for (const id of friendPlanIds) {
      const mine = shared.filter((s) => s.plan.id === id);
      add(mine[0].plan, mine.map((s) => s.span), friendTasks.get(id)!, false);
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { items, sprints: marks };
  }

  // ───────────── calendar tasks ─────────────

  async function listTasks(viewerId: string, from: string, to: string, includeFriends = true): Promise<Task[]> {
    let query = sb.from('tasks').select('*, rooms(name), topics(title)').eq('status', 'active').gte('date', from).lte('date', to).order('date').order('start_time', { nullsFirst: false }).order('created_at');
    if (!includeFriends) query = query.eq('owner_id', viewerId);
    const list = await rows(query);
    const mineIds = list.filter((t) => t.owner_id === viewerId).map((t) => t.id);
    const notes = mineIds.length ? new Map((await rows(sb.from('task_notes').select('task_id, note').in('task_id', mineIds))).map((n) => [n.task_id, n.note])) : new Map();
    return list.map((t) => ({
      id: t.id,
      ownerId: t.owner_id,
      title: t.title,
      description: t.owner_id === viewerId ? t.description : '',
      date: t.date,
      startTime: t.start_time,
      durationMinutes: t.duration_minutes,
      roomId: t.rooms ? t.room_id : null,
      roomName: t.rooms?.name ?? null,
      topicId: t.topics ? t.topic_id : null,
      topicTitle: t.topics?.title ?? null,
      shared: t.shared,
      note: notes.get(t.id) ?? '',
      completed: t.completed_at !== null,
      completedAt: t.completed_at,
      status: t.status,
    }));
  }

  async function getTask(taskId: string): Promise<Task> {
    const viewer = await myId();
    const t = (await rows(sb.from('tasks').select('date').eq('id', taskId)))[0];
    if (!t) throw notFound('That task could not be found.');
    const found = (await listTasks(viewer, t.date, t.date)).find((x) => x.id === taskId);
    if (!found) throw notFound('That task could not be found.');
    return found;
  }

  // ───────────── activity & friends ─────────────

  async function listActivity(viewerId: string, opts: { roomId?: string; withUserId?: string; limit?: number } = {}): Promise<Activity[]> {
    let query = sb.from('activities').select('*, rooms(name)').order('created_at', { ascending: false }).limit(opts.limit ?? 30);
    if (opts.roomId) query = query.eq('room_id', opts.roomId);
    if (opts.withUserId) query = query.or(`actor_id.eq.${opts.withUserId},recipient_id.eq.${opts.withUserId}`);
    const list = await rows(query);
    const refIds = ids(list.map((a) => a.ref_id));
    const [actors, topics, rooms] = await Promise.all([
      profiles(ids(list.map((a) => a.actor_id))),
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
    const list = await rows(sb.from('friendships').select('*').in('status', ['accepted', 'pending']).order('created_at', { ascending: false }));
    const other = (f: Row) => (f.requester_id === viewer ? f.recipient_id : f.requester_id);
    const accepted = list.filter((f) => f.status === 'accepted').sort((a, b) => (a.responded_at ?? 0) - (b.responded_at ?? 0));
    const users = await profiles(ids(list.map(other)));
    const statuses = await liveStatuses(accepted.map(other));
    const friends = await Promise.all(
      accepted
        .filter((f) => users.has(other(f)))
        .map(async (f) => ({
          friendshipId: f.id,
          since: f.responded_at ?? f.created_at,
          user: toPublicUser(users.get(other(f))!),
          status: statuses[other(f)] ?? { state: 'idle' as const, todayFocusedMs: 0 },
          recentCompletions: await recentCompletions(other(f)),
        })),
    );
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
    if (!(await friendIds(viewer)).includes(friendId)) throw notFound('That person is not in your friends list.');
    const user = (await profiles([friendId])).get(friendId)!;
    const [status, recent, rooms, activity, stats] = await Promise.all([
      liveStatuses([friendId]),
      recentCompletions(friendId, 10),
      listRooms(),
      listActivity(viewer, { withUserId: friendId, limit: 20 }),
      rpc<ProgressStats>('progress_stats', { p_user: friendId }),
    ]);
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
      sb.from('study_sessions').select('*, topics(title), rooms(name), session_corrections(old_ms, new_ms, reason, created_at), session_pauses(paused_at, resumed_at)').eq('user_id', viewerId).order('started_at', { ascending: false }).limit(50),
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
    const [roomsAll, tasks, plans, planned, friends, stats, completedToday, tasksDone, unread, activeSession] = await Promise.all([
      listRooms(),
      listTasks(viewer.id, addDays(today, -1), addDays(today, 14), false),
      listPlans(),
      calendarPlanItems(viewer, today, addDays(today, 14), false),
      friendsAndRequests(),
      rpc<ProgressStats>('progress_stats', { p_user: viewer.id }),
      rows(sb.from('topic_completions').select('topic_id, completed_at, topics(title, room_id, rooms(name))').eq('user_id', viewer.id).eq('local_date', today).is('revoked_at', null).order('completed_at', { ascending: false })),
      sb.from('tasks').select('id', { count: 'exact', head: true }).eq('owner_id', viewer.id).eq('completed_date', today).eq('status', 'active'),
      unreadCount(viewer.id),
      rpc<ActiveSession | null>('active_session'),
    ]);
    const rooms = roomsAll.filter((r) => r.status === 'active');
    const todaysOpen = tasks.filter((t) => t.date! <= today && !t.completed && (t.date === today || t.topicId));
    let primary: HomeData['primary'] = null;
    const scheduled = todaysOpen.find((t) => t.date === today);
    if (scheduled) primary = { kind: 'task', task: scheduled };
    else {
      const room = rooms.find((r) => r.nextTopic);
      if (room?.nextTopic) primary = { kind: 'topic', roomId: room.id, roomName: room.name, topicId: room.nextTopic.id, topicTitle: room.nextTopic.title };
    }
    return {
      me: viewer,
      activeSession,
      primary,
      friends: friends.friends,
      today: {
        focusedMs: stats.todayMs,
        completedTopics: completedToday.filter((c) => c.topics).map((c) => ({ topicId: c.topic_id, topicTitle: c.topics.title, roomId: c.topics.room_id, roomName: c.topics.rooms?.name ?? '', completedAt: c.completed_at })),
        completedTasks: tasksDone.count ?? 0,
      },
      plans: plans.filter((p) => p.status === 'active').slice(0, 4),
      rooms,
      upcoming: tasks.filter((t) => t.date! >= today && !t.completed).slice(0, 5),
      plannedTasks: planned.items.filter((t) => !t.done).slice(0, 8),
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
        await rows(sb.from('profiles').update(patch).eq('id', id).select('id'));
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
      case 'POST /encourage': {
        const input = parse(v.encourageSchema, body);
        return { id: await rpc('encourage', { p_recipient: input.recipientId, p_reaction: input.reaction ?? null, p_message: input.message ?? null, p_room: input.roomId ?? null }) };
      }
      case 'GET /activity': {
        const viewer = await myId();
        return { activity: await listActivity(viewer, { limit: 40 }), unread: await unreadCount(viewer) };
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
      case 'PUT /rooms/:id/topics/order':
        await rpc('reorder_topics', { p_room: p[0], p_ids: parse(v.reorderSchema, body).topicIds });
        return { ok: true };

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
        return { session: await rpc('start_session', { p_topic: input.topicId, p_target: input.targetMinutes ?? null, p_remind: input.remindAfterHour ?? false, p_task: input.taskId ?? null }) };
      }
      case 'POST /sessions/:id/pause':
        return { session: await rpc('pause_session', { p_session: p[0] }) };
      case 'POST /sessions/:id/resume':
        return { session: await rpc('resume_session', { p_session: p[0] }) };
      case 'POST /sessions/:id/finish': {
        const input = parse(v.sessionFinishSchema, body ?? {});
        return rpc('finish_session', { p_session: p[0], p_complete: input.completeTopic ?? false, p_confirm_long: input.confirmLong ?? false, p_corrected: input.correctedMinutes ?? null, p_note: input.note ?? null });
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
        return { id: await rpc('create_plan', { p_title: input.title, p_start: input.startDate, p_sprint_days: input.sprintDays }) };
      }
      case 'GET /plans/:id':
        return { plan: await getPlan(p[0]) };
      case 'PATCH /plans/:id':
        await rpc('update_plan', { p_plan: p[0], p_patch: parse(v.planUpdateSchema, body) });
        return { ok: true };
      case 'POST /plans/:id/sprints':
        return { number: await rpc('add_sprint', { p_plan: p[0], p_days: parse(v.sprintCreateSchema, body ?? {}).days ?? null }) };
      case 'PATCH /plans/:id/sprints/:id':
        await rpc('resize_sprint', { p_plan: p[0], p_n: Number(p[1]), p_days: parse(v.sprintUpdateSchema, body).days });
        return { ok: true };
      case 'DELETE /plans/:id/sprints/:id':
        await rpc('remove_sprint', { p_plan: p[0], p_n: Number(p[1]) });
        return { ok: true };
      case 'POST /plans/:id/sprints/:id/pull':
        return { roomId: await rpc('pull_sprint', { p_plan: p[0], p_n: Number(p[1]), p_room: parse(v.pullSprintSchema, body).roomId }) };
      case 'POST /plans/:id/sprints/:id/unpull':
        await rpc('unpull_sprint', { p_plan: p[0], p_n: Number(p[1]) });
        return { ok: true };
      case 'POST /plans/:id/sprints/:id/complete':
      case 'POST /plans/:id/sprints/:id/reopen':
        await rpc('set_sprint_completed', { p_plan: p[0], p_n: Number(p[1]), p_completed: seg[4] === 'complete' });
        return { ok: true };
      case 'POST /plans/:id/tasks': {
        const input = parse(v.planTaskCreateSchema, body);
        return { id: await rpc('add_plan_task', { p_plan: p[0], p_day: input.day, p_title: input.title, p_est: input.estMinutes ?? null }) };
      }
      case 'PATCH /plan-tasks/:id':
        await rpc('update_plan_task', { p_task: p[0], p_patch: parse(v.planTaskUpdateSchema, body) });
        return { ok: true };
      case 'DELETE /plan-tasks/:id':
        await rpc('remove_plan_task', { p_task: p[0] });
        return { ok: true };

      case 'GET /tasks': {
        const viewer = await me();
        const valid = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
        const from = valid(query.get('from')) ?? addMonths(viewer.today, -1);
        const to = valid(query.get('to')) ?? addMonths(viewer.today, 2);
        const [tasks, planned] = await Promise.all([listTasks(viewer.id, from, to), calendarPlanItems(viewer, from, to, true)]);
        return { tasks, planItems: planned.items, sprints: planned.sprints };
      }
      case 'POST /tasks': {
        const input = parse(v.taskCreateSchema, body);
        return { task: await getTask(await rpc('create_task', { p: input })) };
      }
      case 'PATCH /tasks/:id':
        await rpc('update_task', { p_task: p[0], p: parse(v.taskUpdateSchema, body) });
        return { task: await getTask(p[0]) };
      case 'DELETE /tasks/:id':
        await rpc('update_task', { p_task: p[0], p: { status: 'archived' } });
        return { ok: true };

      case 'GET /progress': {
        const userId = query.get('userId') ?? (await myId());
        return { stats: await rpc('progress_stats', { p_user: userId }) };
      }
    }
    throw notFound('Unknown route.');
  }

  return { request, serverNow: () => rpc<number>('server_now') };
}

/** Path segments that are ids: uuids, sprint numbers, and the id after /requests/. */
function isId(s: string, prev?: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || (prev === 'sprints' && /^\d+$/.test(s)) || ['rooms', 'topics', 'sessions', 'plans', 'plan-tasks', 'tasks', 'friends', 'requests'].includes(prev ?? '') && !['requests', 'search', 'active', 'order', 'topics'].includes(s);
}

export type Backend = ReturnType<typeof createBackend>;
