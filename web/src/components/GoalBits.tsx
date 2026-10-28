import type { Goal } from '@shared/types';
import { formatDate } from '@shared/dates';
import { ProgressBar } from './ui';

export function goalValueText(g: Goal): string {
  const p = g.progress;
  if (g.measure === 'completion') return g.status === 'done' ? 'Done ✨' : 'Not done yet';
  if (g.measure === 'time') {
    const h = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
    return p.target ? `${h(p.value)} of ${h(p.target)}` : `${h(p.value)} focused`;
  }
  const unit = g.unit || 'done';
  return p.target ? `${trim(p.value)} of ${trim(p.target)} ${unit}` : `${trim(p.value)} ${unit}`;
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const PERIOD_LABEL: Record<Goal['period'], string> = { yearly: 'Yearly', monthly: 'Monthly', weekly: 'Weekly', custom: 'Custom' };

export function GoalSummary({ goal, accent }: { goal: Goal; accent?: string }) {
  const p = goal.progress;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between top">
        <div className="grow">
          <div className="bold">{goal.title}</div>
          <div className="tiny muted">
            {PERIOD_LABEL[goal.period]} · until {formatDate(goal.deadline)}
          </div>
        </div>
        <span className="small num bold">{p.percent != null ? `${p.percent}%` : ''}</span>
      </div>
      {p.percent != null && <ProgressBar value={p.percent} max={100} accent={accent} label={goal.title} />}
      <div className="small muted num">{goalValueText(goal)}</div>
    </div>
  );
}
