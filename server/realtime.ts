// Server-Sent Events hub. The database is the source of truth; events only tell clients
// which data changed ("invalidate these keys") so they refetch the authoritative state.
import type { Response } from 'express';

export type Channel =
  | 'me'
  | 'friends'
  | 'rooms'
  | 'room'
  | 'plans'
  | 'calendar'
  | 'activity'
  | 'session'
  | 'progress';

export interface InvalidateEvent {
  keys: Channel[];
  roomId?: string;
  /** Optional gentle toast for the recipient, e.g. a new reaction. */
  notice?: { kind: 'encouragement' | 'completion' | 'friend'; text: string };
}

export class RealtimeHub {
  private clients = new Map<string, Set<Response>>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const res of set) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  connect(userId: string, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ serverNow: Date.now() })}\n\n`);
    let set = this.clients.get(userId);
    if (!set) this.clients.set(userId, (set = new Set()));
    set.add(res);
    res.on('close', () => {
      set!.delete(res);
      if (!set!.size) this.clients.delete(userId);
    });
  }

  send(userIds: Iterable<string>, event: InvalidateEvent) {
    const payload = `event: invalidate\ndata: ${JSON.stringify(event)}\n\n`;
    for (const id of new Set(userIds)) {
      for (const res of this.clients.get(id) ?? []) res.write(payload);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }
}
