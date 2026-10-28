import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  status: number;
  code: string;
  data?: unknown;
  constructor(status: number, code: string, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const forbidden = (message = "You don't have access to this.") => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'We could not find that.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT', data?: unknown) => new HttpError(409, code, message, data);

export function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.join('.') || undefined;
    throw new HttpError(400, 'VALIDATION', issue?.message ?? 'Invalid input', { field });
  }
  return result.data;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, data: err.data } });
    return;
  }
  // A uniqueness rule in the database caught a duplicate (e.g. two taps racing to start a session).
  if (err?.code === '23505') {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'That was already saved. Please refresh and try again.' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed request.' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Nothing was saved.' } });
}
