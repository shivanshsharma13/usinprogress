// Thin fetch wrapper. Errors are surfaced with the server's friendly message — never swallowed.

export class ApiError extends Error {
  status: number;
  code: string;
  data?: any;
  constructor(status: number, code: string, message: string, data?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** serverTime - clientTime, smoothed. Used so a running timer shows the server's truth. */
let clockSkew = 0;
export const serverNow = () => Date.now() + clockSkew;

export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number) {
  const estimate = serverMs - (sentAt + receivedAt) / 2;
  clockSkew = clockSkew === 0 ? estimate : clockSkew * 0.7 + estimate * 0.3;
}

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: () => void) => (onUnauthenticated = fn);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "You seem to be offline. Nothing was saved — please try again when you're connected.");
  }
  const st = res.headers.get('x-server-now');
  if (st) noteServerTime(Number(st), sentAt, Date.now());
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && onUnauthenticated && !path.startsWith('/auth/')) onUnauthenticated();
    const err = json?.error;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? 'Something went wrong. Nothing was saved.', err?.data);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
