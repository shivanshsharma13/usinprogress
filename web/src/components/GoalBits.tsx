import type { Goal } from '@shared/types';
import { formatDate } from '@shared/dates';
import { ProgressBar } from './ui';

export const PERIOD_LABEL: Record<Goal['period'], string> = { yearly: 'Yearly', monthly: 'Monthly', weekly: 'Weekly', custom: 'Custom' };

export function goalValueText(g: Goal): string {
  if (g.status === 'done') return 'Done ✨';
  const { done, total } = g.progress;
  return total ? `${done} of ${total} topics done` : 'No topics yet';
}

/** Compact goal line with its progress bar, used on Home and friend profiles. */
export function GoalSummary({ goal, accent }: { goal: Goal; accent?: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between top">
        <div className="grow">
          <div className="bold">{goal.title}</div>
          <div className="tiny muted">
            {PERIOD_LABEL[goal.period]}
            {goal.roomName ? ` · ${goal.roomName}` : ''} · until {formatDate(goal.deadline)}
          </div>
        </div>
        <span className="small num bold">{goal.progress.percent}%</span>
      </div>
      <ProgressBar value={goal.progress.percent} max={100} accent={accent} label={goal.title} />
      <div className="small muted num">{goalValueText(goal)}</div>
    </div>
  );
}

/** Top-level goals of a list (whose parent isn't in the list), in yearly → monthly → weekly order. */
export function rootGoals(goals: Goal[]): Goal[] {
  const ids = new Set(goals.map((g) => g.id));
  const order = { yearly: 0, monthly: 1, weekly: 2, custom: 3 };
  return goals.filter((g) => !g.parentId || !ids.has(g.parentId)).sort((a, b) => order[a.period] - order[b.period]);
}
