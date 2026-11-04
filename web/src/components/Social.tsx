// Parting ways: unfriending someone and taking a room off your list. Both ask first and say exactly what
// happens to the shared rooms and history.
import { useState } from 'react';
import type { PublicUser, RoomSummary } from '@shared/types';
import { useAction } from '../lib/queries';
import { api } from '../lib/api';
import { Modal } from './ui';

const AFTER_LEAVING = [['rooms'], ['room'], ['friends'], ['friend'], ['plans'], ['plan'], ['tasks'], ['progress']];

export function UnfriendModal({ friend, rooms, onClose, onDone }: { friend: PublicUser; rooms: RoomSummary[]; onClose: () => void; onDone?: () => void }) {
  const [leaveRooms, setLeaveRooms] = useState(false);
  const shared = rooms.filter((r) => r.status === 'active' && r.members.some((m) => m.user.id === friend.id));
  const remove = useAction(() => api.post(`/friends/${friend.id}/remove`, { leaveRooms }), {
    invalidate: [...AFTER_LEAVING, ['search'], ['activity']],
    success: `${friend.displayName} is no longer in your friends`,
    onSuccess: () => {
      onClose();
      onDone?.();
    },
  });
  return (
    <Modal
      title={`Unfriend ${friend.displayName}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Keep friends
          </button>
          <button className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
            {remove.isPending ? 'Removing…' : 'Unfriend'}
          </button>
        </>
      }
    >
      <div className="stack">
        <ul className="small stack" style={{ gap: 6, paddingLeft: 18, margin: 0 }}>
          <li>You'll stop seeing each other's live status, hours and shared calendar items.</li>
          <li>They won't be told. You can add each other again any time.</li>
          {shared.length > 0 ? (
            <li>
              {shared.length === 1 ? 'Your shared room' : `Your ${shared.length} shared rooms`} ({shared.map((r) => `“${r.name}”`).join(', ')}) will be archived
              for both of you. Study time and history are kept.
            </li>
          ) : (
            <li>You have no active rooms together.</li>
          )}
        </ul>
        {shared.length > 0 && (
          <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={leaveRooms} onChange={(e) => setLeaveRooms(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              Also remove {shared.length === 1 ? 'that room' : 'those rooms'} from my list
              <span className="muted"> — your topics there are archived; {friend.displayName} keeps their copy.</span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

export function LeaveRoomModal({
  room,
  meId,
  onClose,
  onDone,
}: {
  room: Pick<RoomSummary, 'id' | 'name' | 'members'>;
  meId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const other = room.members.find((m) => m.user.id !== meId)?.user;
  const leave = useAction(() => api.post(`/rooms/${room.id}/leave`), {
    invalidate: AFTER_LEAVING,
    success: `“${room.name}” removed from your rooms`,
    onSuccess: () => {
      onClose();
      onDone?.();
    },
  });
  return (
    <Modal
      title={`Remove “${room.name}”?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={leave.isPending} onClick={() => leave.mutate(undefined)}>
            {leave.isPending ? 'Removing…' : 'Remove room'}
          </button>
        </>
      }
    >
      <ul className="small stack" style={{ gap: 6, paddingLeft: 18, margin: 0 }}>
        <li>The room leaves your list. This can't be undone; you can always create a new room.</li>
        <li>Your topics in it are archived and any sprint you pulled in goes back to your goals. Your study hours stay in your progress.</li>
        <li>{other ? `${other.displayName} keeps the room and their own topics.` : 'Nobody else is in this room, so it closes.'}</li>
        <li className="muted">Only want to pause it? Archive it instead — that can be undone.</li>
      </ul>
    </Modal>
  );
}
