import { useState } from 'react';
import { REACTIONS, type ReactionKey } from '@shared/theme';
import type { Activity } from '@shared/types';
import { api } from '../lib/api';
import { useAction } from '../lib/queries';
import { Avatar, relativeTime } from './ui';

export function EncourageButtons({ recipientId, name, roomId, withMessage }: { recipientId: string; name: string; roomId?: string; withMessage?: boolean }) {
  const [message, setMessage] = useState('');
  const send = useAction((body: { reaction?: ReactionKey; message?: string }) => api.post('/encourage', { recipientId, roomId, ...body }), {
    invalidate: [['activity'], ['friend']],
    success: `Sent to ${name} 💌`,
    onSuccess: (_r, v) => v.message && setMessage(''),
  });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="reactions">
        {(Object.keys(REACTIONS) as ReactionKey[]).map((k) => (
          <button key={k} className="reaction-btn" disabled={send.isPending} onClick={() => send.mutate({ reaction: k })} aria-label={`Send “${REACTIONS[k].label}” to ${name}`}>
            {REACTIONS[k].emoji} {REACTIONS[k].label}
          </button>
        ))}
      </div>
      {withMessage && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim()) send.mutate({ message: message.trim() });
          }}
        >
          <input className="input grow" maxLength={280} placeholder={`A short note for ${name}…`} value={message} onChange={(e) => setMessage(e.target.value)} />
          <button className="btn" disabled={!message.trim() || send.isPending}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

function describe(a: Activity, meId: string): string {
  const who = a.actor.id === meId ? 'You' : a.actor.displayName;
  switch (a.type) {
    case 'reaction':
      return `${who} sent ${REACTIONS[a.reaction!]?.emoji ?? ''} “${REACTIONS[a.reaction!]?.label ?? ''}”`;
    case 'message':
      return `${who} wrote: “${a.message}”`;
    case 'topic_completed':
      return `${who} completed “${a.refTitle}”${a.roomName ? ` in ${a.roomName}` : ''} 🌼`;
    case 'room_created':
      return `${who} planted a new room: ${a.roomName}`;
    case 'friend_accepted':
      return `${who} ${a.actor.id === meId ? 'became friends 🌱' : 'accepted your friend request 🌱'}`;
    case 'goal_done':
      return `${who} reached a goal${a.refTitle ? `: “${a.refTitle}”` : ''} ✨`;
    default:
      return `${who} did something nice`;
  }
}

export function ActivityFeed({ items, meId, empty = 'Nothing here yet.' }: { items: Activity[]; meId: string; empty?: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <div>
      {items.map((a) => (
        <div className="feed-item" key={a.id}>
          <Avatar user={a.actor} size={30} />
          <div className="grow">
            <div style={{ fontWeight: a.recipientId === meId && !a.readAt ? 700 : 500 }}>{describe(a, meId)}</div>
            <div className="tiny muted">{relativeTime(a.createdAt)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
