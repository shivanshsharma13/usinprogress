// The screens' data interface. Same calls as before (api.get('/rooms') …), now answered in the browser
// by the Supabase data layer. Errors carry a friendly message — never swallowed.
import { createBackend } from '../data/backend';
import { ApiError } from '../data/errors';
import { supabase } from './supabase';

export { ApiError };

const backend = createBackend(supabase, { now: () => serverNow() });

/** databaseTime - clientTime, smoothed, so a running timer shows the saved timestamps' truth. */
let clockSkew = 0;
export const serverNow = () => Date.now() + clockSkew;

export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number) {
  const estimate = serverMs - (sentAt + receivedAt) / 2;
  clockSkew = clockSkew === 0 ? estimate : clockSkew * 0.7 + estimate * 0.3;
}

/** Re-measures the clock difference with the database (on start, and when the tab comes back). */
export async function syncClock() {
  const sentAt = Date.now();
  try {
    const db = await backend.serverNow();
    noteServerTime(Number(db), sentAt, Date.now());
  } catch {}
}

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: () => void) => (onUnauthenticated = fn);

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  try {
    return (await backend.request(method, path, body)) as T;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401 && onUnauthenticated && !path.startsWith('/auth/')) onUnauthenticated();
      throw e;
    }
    // supabase-js network failures surface as TypeErrors.
    throw new ApiError(0, 'NETWORK', "You seem to be offline. Nothing was saved — please try again when you're connected.");
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
