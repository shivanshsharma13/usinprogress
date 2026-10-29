import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { toast } from './toast';
import { noteLocalWrite } from './realtime';
import type {
  Activity,
  ActiveSession,
  Friend,
  FriendRequest,
  HomeData,
  LiveStatus,
  Me,
  ProgressStats,
  CalendarPlanItem,
  Plan,
  PlanSummary,
  PublicUser,
  RoomDetail,
  RoomSummary,
  SprintMark,
  SessionRecord,
  Task,
  TopicHistoryEntry,
  UserSearchResult,
  CompletionSummary,
} from '@shared/types';

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.get<{ me: Me }>('/me')).me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });

export const useHome = () => useQuery({ queryKey: ['home'], queryFn: () => api.get<HomeData>('/home') });
export const useRooms = () => useQuery({ queryKey: ['rooms'], queryFn: async () => (await api.get<{ rooms: RoomSummary[] }>('/rooms')).rooms });
export const useRoom = (id: string | undefined) =>
  useQuery({ queryKey: ['room', id], queryFn: () => api.get<RoomDetail>(`/rooms/${id}`), enabled: Boolean(id) });
export const useFriends = () =>
  useQuery({ queryKey: ['friends'], queryFn: () => api.get<{ friends: Friend[]; requests: FriendRequest[] }>('/friends') });
export const useFriend = (id: string | undefined) =>
  useQuery({
    queryKey: ['friend', id],
    enabled: Boolean(id),
    queryFn: () =>
      api.get<{ user: PublicUser; status: LiveStatus; recentCompletions: CompletionSummary[]; rooms: RoomSummary[]; activity: Activity[]; stats: ProgressStats }>(
        `/friends/${id}`,
      ),
  });
export const usePlans = () => useQuery({ queryKey: ['plans'], queryFn: async () => (await api.get<{ plans: PlanSummary[] }>('/plans')).plans });
export const usePlan = (id: string | undefined) =>
  useQuery({ queryKey: ['plan', id], enabled: Boolean(id), queryFn: async () => (await api.get<{ plan: Plan }>(`/plans/${id}`)).plan });
export const useTasks = (from: string, to: string) =>
  useQuery({
    queryKey: ['tasks', from, to],
    queryFn: () => api.get<{ tasks: Task[]; planItems: CalendarPlanItem[]; sprints: SprintMark[] }>(`/tasks?from=${from}&to=${to}`),
    placeholderData: (prev) => prev,
  });
export const useActiveSession = (enabled = true) =>
  useQuery({ queryKey: ['session'], enabled, queryFn: async () => (await api.get<{ session: ActiveSession | null }>('/sessions/active')).session });
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: async () => (await api.get<{ sessions: SessionRecord[] }>('/sessions')).sessions });
export const useActivity = () => useQuery({ queryKey: ['activity'], queryFn: () => api.get<{ activity: Activity[]; unread: number }>('/activity') });
export const useProgress = (userId?: string) =>
  useQuery({ queryKey: ['progress', userId ?? 'me'], queryFn: async () => (await api.get<{ stats: ProgressStats }>(`/progress${userId ? `?userId=${userId}` : ''}`)).stats });
export const useTopicHistory = (id: string | null) =>
  useQuery({
    queryKey: ['topicHistory', id],
    enabled: Boolean(id),
    queryFn: () => api.get<{ events: TopicHistoryEntry[]; sessions: { userId: string; startedAt: number; focusedMs: number; isRevision: boolean }[] }>(`/topics/${id}/history`),
  });
export const useUserSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    enabled: q.trim().length >= 2,
    queryFn: async () => (await api.get<{ results: UserSearchResult[] }>(`/users/search?q=${encodeURIComponent(q.trim())}`)).results,
  });

/**
 * A mutation that refetches the given keys on success and shows the server's error message on
 * failure. Callers keep their form input on error so nothing typed is lost.
 */
export function useAction<TVars, TResult = any>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: string[][]; success?: string | ((r: TResult) => string | undefined); onSuccess?: (r: TResult, v: TVars) => void; onError?: (e: ApiError, v: TVars) => boolean | void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: noteLocalWrite,
    onSuccess: (r, v) => {
      noteLocalWrite();
      for (const k of opts.invalidate ?? [['home']]) void qc.invalidateQueries({ queryKey: k });
      void qc.invalidateQueries({ queryKey: ['home'] });
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast(msg, 'success');
      opts.onSuccess?.(r, v);
    },
    onError: (e, v) => {
      const err = e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e));
      if (opts.onError?.(err, v)) return;
      toast(err.message, 'error', 6000);
    },
  });
}
