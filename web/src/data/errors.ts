// Errors the app shows. Database functions raise SQLSTATE P0400/P0403/P0404/P0409 with a friendly
// message (and optional JSON detail); those become an HTTP-like status the screens already understand.

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

const STATUS: Record<string, number> = { P0400: 400, P0401: 401, P0403: 403, P0404: 404, P0409: 409, '42501': 403, '23505': 409, '23514': 400, '22P02': 404, '22007': 400 };
const DEFAULT_CODE: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' };

export function fromSupabase(error: { code?: string; message: string; details?: string | null }): ApiError {
  let status = STATUS[error.code ?? ''] ?? 500;
  let message = error.message;
  let detail: any = null;
  try {
    detail = error.details ? JSON.parse(error.details) : null;
  } catch {}
  if (/ROOM_FULL/.test(message)) status = 409;
  if (error.code === '42501') message = "You don't have access to this.";
  if (error.code === '23505') message = 'That was already saved. Please refresh and try again.';
  if (error.code === '23514') message = 'Some of that information isn\'t valid. Please check and try again.';
  if (error.code === '22P02') message = 'We could not find that.';
  if (status === 500) message = 'Something went wrong on our side. Nothing was saved.';
  const code = detail?.code ?? DEFAULT_CODE[status] ?? 'SERVER_ERROR';
  const data = detail?.code === 'SESSION_ACTIVE' ? detail.session : detail;
  return new ApiError(status, code, message, data);
}

export const notFound = (message = 'We could not find that.') => new ApiError(404, 'NOT_FOUND', message);
export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
