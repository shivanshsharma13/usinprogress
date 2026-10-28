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
  linkedGoals: { id: string; title: string; ownerId: string }[];
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

export interface GoalProgress {
  /** count units, minutes for time goals, 0/1 for completion goals */
  value: number;
  target: number | null;
  percent: number | null; // capped at 100 for display; null when not measurable
  items: number; // distinct completed work items counted
}

export interface Goal {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  period: 'yearly' | 'monthly' | 'weekly' | 'custom';
  startDate: string;
  deadline: string;
  measure: 'count' | 'time' | 'completion';
  target: number | null;
  unit: string;
  parentId: string | null;
  visibility: 'private' | 'friends';
  status: 'active' | 'done' | 'archived';
  doneAt: number | null;
  links: { roomId?: string; topicId?: string; label: string }[];
  progress: GoalProgress;
  childIds: string[];
}

export interface Task {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  date: string;
  startTime: string | null;
  durationMinutes: number | null;
  goalId: string | null;
  goalTitle: string | null;
  roomId: string | null;
  roomName: string | null;
  topicId: string | null;
  topicTitle: string | null;
  quantity: number;
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
  goals: Goal[];
  rooms: RoomSummary[];
  upcoming: Task[];
  unread: number;
}
