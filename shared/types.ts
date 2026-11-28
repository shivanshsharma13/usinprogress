// API response shapes shared by server and client.
import type { PauseInterval } from './timer.ts';
import type { AvatarConfig, ProfileType, ReactionKey } from './theme.ts';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  profileType: ProfileType;
  accent: string;
  bio: string;
  avatar: AvatarConfig;
}

/** Optional features, switched on in Settings → Motivation & focus. A missing key means off. */
export type PrefKey = string;
export type Prefs = Partial<Record<PrefKey, boolean>>;

/** A selfie sent to a friend (Settings → Motivation & focus → Photo cheers). Kept for 24 hours. */
export interface PhotoCheer {
  id: string;
  senderId: string;
  recipientId: string;
  image: string; // data:image/jpeg;base64,… with the frame already drawn in
  caption: string;
  replyTo: string | null;
  createdAt: number;
  seenAt: number | null;
  heartedAt: number | null;
}

/** One work day's hours. An end earlier than the start is a night shift. */
export interface WorkSlot {
  day: number; // 0 = Sunday … 6 = Saturday
  start: string; // "09:30"
  end: string; // "18:30"
}

/** One date that went differently from the usual hours. */
export type DayChange = { start: string; end: string } | { off: true };

/** Sleep and work hours, for the day split (Settings → Motivation & focus). */
export interface Routine {
  sleepMinutes: number;
  work?: WorkSlot[]; // each work day with its own hours (missing on routines saved before per-day hours)
  dayChanges?: Record<string, DayChange>; // "YYYY-MM-DD" → that day's hours, kept for two weeks
  // The old shape: the same hours on every work day. Still sent, for older app versions.
  workStart: string | null;
  workEnd: string | null;
  workDays: number[];
}

/** A topic due for revision (1, 3, 7 and 21 days after you first finished it). */
export interface RevisionDue {
  topicId: string;
  title: string;
  roomId: string;
  roomName: string;
  step: number; // 1–4
  dueDate: string;
  firstDoneDate: string;
}

/** One person's week (or any range up to a month), for streaks and the weekly recap. */
export interface WeekRecap {
  userId: string;
  streak: { current: number; best: number; studiedToday: boolean };
  totalMs: number;
  bestDay: { date: string; ms: number } | null;
  topicsDone: number;
  trees: number;
}

/** This week's challenge between you and a friend. Progress is focused ms ('hours') or full days ('days'). */
export interface Challenge {
  id: string;
  weekStart: string;
  kind: 'hours' | 'days';
  target: number;
  createdBy: string;
  wonAt: number | null;
  progress: Record<string, number>;
}

export interface Me extends PublicUser {
  colorScheme: 'light' | 'dark';
  timezone: string;
  shareStatus: boolean;
  prefs: Prefs; // Settings → Motivation & focus
  createdAt: number;
  today: string; // user's current local date
}

export interface ActiveSession {
  id: string;
  roomId: string;
  roomName: string;
  topicId: string;
  topicTitle: string;
  state: 'running' | 'paused';
  startedAt: number;
  pauses: PauseInterval[];
  targetMinutes: number | null;
  remindAfterHour: boolean;
  isRevision: boolean;
  togetherId?: string | null; // studying together with a friend (see Together)
  subtopicId?: string | null; // the part of the topic this session is on (Subtopics)
  subtopicTitle?: string | null;
}

/** Two friends studying at the same time: a shared timer, and a break either can call for both. */
export interface Together {
  id: string;
  hostId: string;
  guestId: string;
  startedAt: number;
  breakStartedAt: number | null;
  breakBy: string | null;
  breakMs: number;
  live: boolean; // false once either of you finishes
  people: Record<string, { state: 'running' | 'paused' | 'finished' | 'discarded'; topicTitle: string | null }>;
}

/** What a friend is allowed to see about someone's live activity. */
export interface LiveStatus {
  state: 'studying' | 'paused' | 'idle' | 'hidden';
  topicTitle?: string;
  roomId?: string;
  roomName?: string;
  startedAt?: number;
  pauses?: PauseInterval[];
  todayFocusedMs: number;
}

export interface CompletionSummary {
  topicId: string;
  topicTitle: string;
  roomId: string;
  roomName: string;
  completedAt: number;
}

export interface Friend {
  friendshipId: string;
  since: number;
  user: PublicUser;
  status: LiveStatus;
  recentCompletions: CompletionSummary[];
}

export interface FriendRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  user: PublicUser;
  createdAt: number;
}

export interface UserSearchResult {
  user: PublicUser;
  relation: 'none' | 'friend' | 'pending_outgoing' | 'pending_incoming' | 'self';
}

export interface MemberProgress {
  user: PublicUser;
  completed: number;
  total: number;
  focusedMs: number;
  status: LiveStatus;
}

export interface RoomSummary {
  id: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  color: string;
  status: 'active' | 'archived';
  createdBy: string;
  createdAt: number;
  members: MemberProgress[];
  nextTopic: { id: string; title: string } | null; // my next incomplete topic
}

export type TopicStatus = 'not_started' | 'in_progress' | 'completed' | 'revising';

export interface TopicMemberProgress {
  status: TopicStatus;
  completedAt: number | null;
  firstCompletedAt: number | null;
  focusedMs: number;
  sessions: number;
}

export interface Topic {
  id: string;
  roomId: string;
  title: string;
  description: string;
  category: string;
  estimatedMinutes: number | null;
  sessionTargetMinutes: number | null;
  deadline: string | null;
  planTaskId: string | null; // set when this topic is a task from a goal's sprint
  position: number;
  createdBy: string;
  status: 'active' | 'archived';
  createdAt: number;
  progress: Record<string, TopicMemberProgress>; // keyed by user id
  parts: SubtopicCount;
  activeToday?: boolean; // its owner studied it, ticked a part or completed it today
}

/** How many subtopics a topic has, and how many are done. */
export interface SubtopicCount {
  done: number;
  total: number;
}

/** A part of a topic ("Pascal's Triangle" → "II"), with its owner's time on it. */
export interface Subtopic {
  id: string;
  topicId: string;
  title: string;
  doneAt: number | null;
  date?: string | null; // the day it's planned for (null = not planned yet)
  estMinutes?: number | null; // how long it takes
  focusedMs: number;
  sessions: number;
}

/** A subtopic as goal tasks carry it: planned for a day, done, or touched today. */
export interface PartRef {
  id: string;
  title: string;
  date: string | null; // the day it's planned for
  estMinutes: number | null;
  doneDate: string | null;
  activeToday?: boolean; // studied or ticked today
}

export interface RoomDetail extends RoomSummary {
  topics: Topic[];
  archivedTopics: Topic[];
  activity: Activity[];
  forest: Record<string, number>; // per member: days they finished everything planned in this room
  blooms: number; // weekly challenges the two members won together (golden sunflowers)
  goals: GoalRef[]; // both members' goals in this room
  tasks: GoalTask[]; // their tasks (your friend's undated ones show only as topics)
}

export interface TopicHistoryEntry {
  id: string;
  type: string;
  userId: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  roomId: string;
  roomName: string;
  topicId: string;
  topicTitle: string;
  subtopicTitle?: string | null;
  state: 'running' | 'paused' | 'finished' | 'discarded';
  startedAt: number;
  endedAt: number | null;
  focusedMs: number;
  measuredMs: number | null;
  isRevision: boolean;
  note: string;
  corrections: { oldMs: number; newMs: number; reason: string; createdAt: number }[];
}

// ───────────── Plans (goals): plan → sprints → days → tasks ─────────────

export interface PlanTask {
  id: string;
  day: number | null; // 0-based day of the plan it's scheduled on; null = in the backlog
  plannedDay: number | null; // the day it was planned for (kept when it slips into the backlog)
  title: string;
  estMinutes: number | null;
  starred: boolean;
  topicId: string | null; // set once its sprint is pulled into a room
  done: boolean;
  doneDate: string | null; // owner's calendar date it was completed
  focusedMs: number;
  description?: string; // its topic's description
  parts?: SubtopicCount; // its topic's subtopics
  activeToday?: boolean; // studied, a part ticked or completed today, so it shows under Today
  partList?: PartRef[]; // its topic's subtopics, in order
}

export type DayStatus = 'upcoming' | 'today' | 'done' | 'partial' | 'missed' | 'rest';

export interface PlanDay {
  day: number; // 0-based day of the plan
  number: number; // 1-based, as shown ("Day 6")
  date: string;
  status: DayStatus;
  /** Today/upcoming: tasks scheduled that day. Past days: what was planned or done that day. */
  tasks: PlanTask[];
}

export interface PlanSprint {
  number: number;
  length: number; // days
  startDate: string;
  endDate: string;
  roomId: string | null;
  roomName: string | null;
  completedAt: number | null;
  done: number;
  total: number;
  focusedMs: number;
  estMinutes: number;
  days: PlanDay[];
}

export interface PlanSummary {
  id: string;
  title: string;
  startDate: string;
  endDate: string; // end of the last sprint
  sprintDays: number; // default length for a new sprint
  sprintCount: number;
  sprintsCompleted: number;
  currentSprint: number | null; // the sprint covering today, if any
  done: number;
  total: number;
  backlog: number;
  focusedMs: number;
  status: 'active' | 'archived';
  roomId: string | null; // the room the goal lives in
  roomName: string | null;
}

/** A goal's task with its real date, as rooms and goal pages list them. */
export interface GoalTask {
  id: string; // plan task id
  planId: string;
  planTitle: string;
  ownerId: string;
  title: string;
  date: string | null; // null = no date
  estMinutes: number | null;
  topicId: string | null; // its topic in the goal's room (what you study)
  done: boolean;
  doneDate: string | null;
  focusedMs: number;
  description?: string;
  parts?: SubtopicCount;
  activeToday?: boolean;
  partList?: PartRef[];
  // Set on a planned subtopic (rooms and goal lists show these as "Topic › Subtopic"; title is the topic's).
  subtopicId?: string;
  subtopicTitle?: string;
}

/** A goal as a room lists it. */
export interface GoalRef {
  id: string;
  title: string;
  ownerId: string;
}

export interface Plan extends PlanSummary {
  sprints: PlanSprint[];
  backlogTasks: PlanTask[];
  tasks: GoalTask[]; // every task, with its date
}

export interface Activity {
  id: string;
  type: 'reaction' | 'message' | 'topic_completed' | 'room_created' | 'friend_accepted' | 'topic_added' | 'challenge_set' | 'challenge_won' | 'together_joined' | 'day_finished';
  actor: PublicUser;
  recipientId: string | null;
  roomId: string | null;
  roomName: string | null;
  reaction: ReactionKey | null;
  message: string | null;
  refTitle: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface ProgressStats {
  userId: string;
  todayMs: number;
  weekMs: number;
  completedTopics: number;
  sessions: number;
  daily: { date: string; ms: number }[]; // last 7 days
}

/** Focused time per day and per topic over a date range (yours, or a friend's: topic names only for shared rooms). */
export interface HoursReport {
  userId: string;
  from: string;
  to: string;
  today: string;
  daily: { date: string; ms: number }[];
  topics: {
    topicId: string;
    title: string;
    roomId: string;
    roomName: string;
    ms: number;
    sessions: number;
    subtopicsTotal?: number;
    subtopicsDone?: number;
    subtopics?: { id: string; title: string; ms: number; done: boolean }[]; // studied in the range, longest first
  }[];
  otherMs: number;
}

export interface HomeData {
  me: Me;
  activeSession: ActiveSession | null;
  // What to study now: the first thing planned for today in your goals, or the next topic in a room.
  primary:
    | { kind: 'item'; item: GoalTask }
    | { kind: 'topic'; roomId: string; roomName: string; topicId: string; topicTitle: string }
    | null;
  friends: Friend[];
  today: { focusedMs: number; completedTopics: CompletionSummary[]; partsDone: number };
  plans: PlanSummary[];
  rooms: RoomSummary[];
  comingUp: GoalTask[]; // open planned items from today on, soonest first
  unread: number;
}
