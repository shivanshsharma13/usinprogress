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

export interface Me extends PublicUser {
  colorScheme: 'light' | 'dark';
  timezone: string;
  shareStatus: boolean;
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
  taskId: string | null;
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
  position: number;
  createdBy: string;
  status: 'active' | 'archived';
  createdAt: number;
  progress: Record<string, TopicMemberProgress>; // keyed by user id
}

export interface RoomDetail extends RoomSummary {
  topics: Topic[];
  archivedTopics: Topic[];
  activity: Activity[];
  sprints: RoomSprint[]; // both members' sprints pulled into this room
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
  day: number; // 0-based day of the plan
  title: string;
  estMinutes: number | null;
  starred: boolean;
  topicId: string | null; // set once the sprint is pulled into a room
  done: boolean;
  focusedMs: number;
}

export type DayStatus = 'upcoming' | 'today' | 'done' | 'partial' | 'missed' | 'rest';

export interface PlanDay {
  day: number; // 0-based day of the plan
  number: number; // 1-based day of the plan, as shown ("Day 6")
  date: string;
  status: DayStatus;
  tasks: PlanTask[];
}

export interface PlanSprint {
  number: number;
  startDate: string;
  endDate: string;
  roomId: string | null;
  roomName: string | null;
  completedAt: number | null;
  done: number;
  total: number;
  days: PlanDay[];
}

export interface PlanSummary {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  sprintDays: number;
  sprintCount: number;
  sprintsCompleted: number;
  currentSprint: number | null; // the sprint covering today, if any
  done: number;
  total: number;
  focusedMs: number;
  status: 'active' | 'archived';
}

export interface Plan extends PlanSummary {
  sprints: PlanSprint[];
}

/** A pulled sprint as shown in a room, for either member. */
export interface RoomSprint extends PlanSprint {
  planId: string;
  planTitle: string;
  ownerId: string;
}

export interface Task {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  date: string | null; // null = not scheduled on the calendar
  startTime: string | null;
  durationMinutes: number | null;
  roomId: string | null;
  roomName: string | null;
  topicId: string | null;
  topicTitle: string | null;
  shared: boolean;
  note: string; // empty for other people
  completed: boolean;
  completedAt: number | null;
  status: 'active' | 'archived';
}

export interface Activity {
  id: string;
  type: 'reaction' | 'message' | 'topic_completed' | 'room_created' | 'friend_accepted' | 'goal_done' | 'topic_added';
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
  completedTasks: number;
  sessions: number;
  daily: { date: string; ms: number }[]; // last 7 days
}

export interface HomeData {
  me: Me;
  activeSession: ActiveSession | null;
  primary:
    | { kind: 'task'; task: Task }
    | { kind: 'topic'; roomId: string; roomName: string; topicId: string; topicTitle: string }
    | null;
  friends: Friend[];
  today: { focusedMs: number; completedTopics: CompletionSummary[]; completedTasks: number };
  plans: PlanSummary[];
  rooms: RoomSummary[];
  upcoming: Task[];
  unread: number;
}
