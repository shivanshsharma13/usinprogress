// Revision reminders (Settings → Motivation & focus): topics to revise 1, 3, 7 and 21 days after you first
// finished them. Shown on Home and in each room's "Today" for you only.
import { useNavigate } from 'react-router';
import { daysBetween, formatDate } from '@shared/dates';
import type { RevisionDue } from '@shared/types';
import { usePref } from '../lib/prefs';
import { useAction, useMe, useRevisions } from '../lib/queries';
import { api } from '../lib/api';
import { RefreshIcon } from './icons';

const STEP_DAYS = [1, 3, 7, 21];

export function RevisionsDue({ roomId }: { roomId?: string }) {
  const [on] = usePref('revisions');
  const { data: me } = useMe();
  const { data } = useRevisions(on);
  const navigate = useNavigate();
  const revise = useAction((r: RevisionDue) => api.post(`/topics/${r.topicId}/reopen`, { mode: 'revise' }), {
    invalidate: [['room'], ['rooms'], ['revisions']],
    onSuccess: (_r, r) => navigate(`/study?topic=${r.topicId}`),
  });
  if (!on || !data || !me) return null;
  const list = data.filter((r) => !roomId || r.roomId === roomId);
  const due = list.filter((r) => r.dueDate <= me.today);
  const soon = list.length - due.length;
  if (!list.length) return null;

  return (
    <div className="card stack revisions-card">
      <div className="row between">
        <h3 className="row" style={{ gap: 6 }}>
          <RefreshIcon width={18} aria-hidden="true" /> Revise today
        </h3>
        {soon > 0 && <span className="tiny muted">{soon} more this week</span>}
      </div>
      {due.length ? (
        <div className="stack" style={{ gap: 8 }}>
          {due.map((r) => {
            const late = daysBetween(r.dueDate, me.today);
            return (
              <div key={r.topicId} className="revision-row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="small bold ellipsis">{r.title}</div>
                  <div className="tiny muted">
                    Revision {r.step} of 4 · day {STEP_DAYS[r.step - 1]}
                    {!roomId && ` · ${r.roomName}`}
                    {late > 0 && <span className="chip warn tiny" style={{ marginLeft: 6 }}>{late === 1 ? '1 day late' : `${late} days late`}</span>}
                  </div>
                </div>
                <button className="btn small" disabled={revise.isPending} onClick={() => revise.mutate(r)}>
                  Revise
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="tiny muted">Nothing due today. Next: {formatDate(list[0].dueDate, { weekday: 'long' })}.</p>
      )}
    </div>
  );
}
