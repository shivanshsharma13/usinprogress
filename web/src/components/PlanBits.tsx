import { Link } from 'react-router';
import { formatDate } from '@shared/dates';
import type { DayStatus, PlanSummary } from '@shared/types';
import { fmt, ProgressBar } from './ui';

export const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/** "Sprint 3 of 11" or where the plan stands in time. */
export function sprintLabel(p: PlanSummary, today: string): string {
  if (p.currentSprint) return `Sprint ${p.currentSprint} of ${p.sprintCount}`;
  return today < p.startDate ? `Starts ${formatDate(p.startDate)}` : `Ended ${formatDate(p.endDate)}`;
}

/** One goal as a compact row with its progress, linking to its page. */
export function PlanLine({ plan, today, accent }: { plan: PlanSummary; today: string; accent?: string }) {
  return (
    <Link to={`/goals/${plan.id}`} className="stack" style={{ gap: 6, textDecoration: 'none' }}>
      <div className="row between top">
        <div className="grow">
          <div className="bold">{plan.title}</div>
          <div className="tiny muted">
            {sprintLabel(plan, today)} · {fmt(plan.focusedMs)} spent
          </div>
        </div>
        <span className="small num bold">{percent(plan.done, plan.total)}%</span>
      </div>
      <ProgressBar value={plan.done} max={plan.total} accent={accent} label={plan.title} />
      <div className="small muted num">
        {plan.done} of {plan.total} tasks done
      </div>
    </Link>
  );
}

export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  upcoming: '',
  today: 'Today',
  done: 'Completed',
  partial: 'Partially completed',
  missed: 'Missed',
  rest: 'Rest day',
};
