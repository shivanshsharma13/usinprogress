// Subtopics: the parts of a topic, like "Pascal's Triangle" → I, II, III. In a goal you give each one a day and
// how long it takes; the room then shows it on that day as "Topic › Subtopic". A topic is complete when all of its
// subtopics are. Two topics that turned out to be the same can be merged.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { GoalTask, Subtopic } from '@shared/types';
import { api } from '../lib/api';
import { useAction, useMe } from '../lib/queries';
import { addDays, formatDate } from '@shared/dates';
import { formatMinutes } from '@shared/timer';
import { toast } from '../lib/toast';
import { fmt, Modal, ProgressBar } from './ui';
import { CheckIcon, PlayIcon, XIcon } from './icons';

const INVALIDATE = [['subtopics'], ['room'], ['rooms'], ['plan'], ['plans'], ['progress']];

export function useSubtopics(topicId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['subtopics', topicId],
    enabled: Boolean(topicId) && enabled,
    queryFn: () => api.get<{ subtopics: Subtopic[] }>(`/topics/${topicId}/subtopics`).then((r) => r.subtopics),
  });
}

/** "2/4 subtopics · 50%" with a bar: how far through its parts a topic is. */
export function PartsMeter({ done, total }: { done: number; total: number }) {
  const pct = Math.round((done / total) * 100);
  return (
    <span className="parts-meter tiny">
      <ProgressBar value={done} max={total} thin label={`${done} of ${total} subtopics done`} />
      <span className="muted num">
        {done}/{total} subtopics · {pct}%
      </span>
    </span>
  );
}

/** What ticking a subtopic did to its topic. */
export type TopicChange = 'completed' | 'undone' | null;
export function announce(change: TopicChange) {
  if (change === 'completed') toast('All subtopics done, so the topic is complete 🌼', 'success');
  else if (change === 'undone') toast('Topic reopened: not every subtopic is done', 'notice');
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** A task opened up: its description and subtopics. Only the owner can change them. */
export function SubtopicPanel({ topicId, description, canAct }: { topicId: string; description: string; canAct: boolean }) {
  const navigate = useNavigate();
  const { data: list, isLoading } = useSubtopics(topicId);
  const [title, setTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newEst, setNewEst] = useState('');
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(description);
  const add = useAction(() => api.post(`/topics/${topicId}/subtopics`, { title: title.trim(), date: newDate || null, estMinutes: newEst ? Number(newEst) : null }), {
    invalidate: INVALIDATE,
    onSuccess: () => setTitle(''),
  });
  const tick = useAction((s: Subtopic) => api.patch<{ topic: TopicChange }>(`/subtopics/${s.id}`, { done: !s.doneAt }), {
    invalidate: INVALIDATE,
    onSuccess: (r) => announce(r.topic),
  });
  const remove = useAction((s: Subtopic) => api.del(`/subtopics/${s.id}`), { invalidate: INVALIDATE, success: 'Subtopic removed' });
  const today = useMe().data?.today ?? '';
  // When you'll do a subtopic and how long it takes: the room shows it on that day.
  const plan = useAction(({ s, patch }: { s: Subtopic; patch: { date?: string | null; estMinutes?: number | null } }) => api.patch(`/subtopics/${s.id}`, patch), {
    invalidate: INVALIDATE,
  });
  const when = (d: string) => (d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' }));
  const saveNote = useAction(() => api.patch(`/topics/${topicId}`, { description: note.trim() }), {
    invalidate: INVALIDATE,
    success: 'Saved',
    onSuccess: () => setEditingNote(false),
  });

  return (
    <div className="sub-panel stack" style={{ gap: 8 }}>
      {editingNote ? (
        <form
          className="stack"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            saveNote.mutate(undefined);
          }}
        >
          <textarea className="input" rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What this topic covers, links, what to focus on…" aria-label="Description" />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost small" onClick={() => (setNote(description), setEditingNote(false))}>
              Cancel
            </button>
            <button className="btn primary small" disabled={saveNote.isPending}>
              Save
            </button>
          </div>
        </form>
      ) : description ? (
        <p className="small sub-desc">
          {description}
          {canAct && (
            <button className="link-btn tiny" onClick={() => setEditingNote(true)}>
              Edit
            </button>
          )}
        </p>
      ) : (
        canAct && (
          <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setEditingNote(true)}>
            ＋ Add a description
          </button>
        )
      )}

      {isLoading ? (
        <span className="tiny muted">Loading subtopics…</span>
      ) : list?.length ? (
        <ul className="sub-list">
          {list.map((s) => (
            <li key={s.id} className={s.doneAt ? 'done' : ''}>
              <button className="sub-check" disabled={!canAct || tick.isPending} onClick={() => tick.mutate(s)} aria-pressed={Boolean(s.doneAt)} aria-label={s.doneAt ? `${s.title} is done. Mark as not done` : `Mark ${s.title} done`}>
                {s.doneAt && <CheckIcon width={12} />}
              </button>
              <span className="grow sub-title">
                {s.title}
                {s.focusedMs > 0 && <span className="tiny muted num"> · {fmt(s.focusedMs)}</span>}
                {(!canAct || s.doneAt) && (s.date || s.estMinutes) ? (
                  <span className="tiny muted"> · {[s.date && when(s.date), s.estMinutes && `~${formatMinutes(s.estMinutes)}`].filter(Boolean).join(' · ')}</span>
                ) : null}
              </span>
              {canAct && !s.doneAt && (
                <span className="sub-plan">
                  <input
                    type="date"
                    className={`input sub-date${s.date && today && s.date < today ? ' late' : ''}`}
                    value={s.date ?? ''}
                    onChange={(e) => plan.mutate({ s, patch: { date: e.target.value || null } })}
                    aria-label={`Day for ${s.title}`}
                  />
                  <EstSelect value={s.estMinutes ?? null} onChange={(m) => plan.mutate({ s, patch: { estMinutes: m } })} label={`Time for ${s.title}`} />
                </span>
              )}
              {canAct && !s.doneAt && (
                <button className="btn ghost icon small" onClick={() => navigate(`/study?topic=${topicId}&sub=${s.id}`)} aria-label={`Study ${s.title}`}>
                  <PlayIcon width={16} />
                </button>
              )}
              {canAct && (
                <button
                  className="btn ghost icon small"
                  onClick={() => confirm(`Remove “${s.title}”? Its study time stays on the topic.`) && remove.mutate(s)}
                  aria-label={`Remove ${s.title}`}
                >
                  <XIcon width={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !canAct && <span className="tiny muted">No subtopics yet.</span>
      )}

      {canAct && (
        <form
          className="sub-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && !add.isPending) add.mutate(undefined);
          }}
        >
          <input className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Add a subtopic… e.g. Part II, or Revision" aria-label="New subtopic" />
          <input type="date" className="input sub-date" value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="Day for the new subtopic" />
          <EstSelect value={newEst ? Number(newEst) : null} onChange={(m) => setNewEst(m ? String(m) : '')} label="Time for the new subtopic" />
          <button className="btn small" disabled={!title.trim() || add.isPending}>
            Add
          </button>
        </form>
      )}
    </div>
  );
}

const ESTS = [15, 30, 45, 60, 90, 120, 180];

/** How long a subtopic takes. */
export function EstSelect({ value, onChange, label }: { value: number | null; onChange: (m: number | null) => void; label: string }) {
  const options = value && !ESTS.includes(value) ? [...ESTS, value].sort((a, b) => a - b) : ESTS;
  return (
    <select className="input sub-est" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} aria-label={label}>
      <option value="">⏱ time</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {formatMinutes(m)}
        </option>
      ))}
    </select>
  );
}

/** On the timer's start card: which part of the topic you're about to study. */
export function SubtopicPicker({ topicId, value, onChange }: { topicId: string; value: string | null; onChange: (id: string | null) => void }) {
  const { data: list } = useSubtopics(topicId);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const add = useAction(() => api.post<{ id: string }>(`/topics/${topicId}/subtopics`, { title: title.trim() }), {
    invalidate: INVALIDATE,
    onSuccess: (r) => {
      onChange(r.id);
      setTitle('');
      setAdding(false);
    },
  });
  const parts = [...(list ?? [])].sort((a, b) => Number(Boolean(a.doneAt)) - Number(Boolean(b.doneAt)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="small bold">Which part?</span>
      <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Which part of the topic">
        <button type="button" className={`chip-btn${value === null ? ' on' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>
          Whole topic
        </button>
        {parts.map((s) => (
          <button key={s.id} type="button" className={`chip-btn${value === s.id ? ' on' : ''}`} aria-pressed={value === s.id} onClick={() => onChange(s.id)}>
            {s.doneAt ? '✓ ' : ''}
            {s.title}
          </button>
        ))}
        {!adding && (
          <button type="button" className="chip-btn" onClick={() => setAdding(true)}>
            ＋ New part
          </button>
        )}
      </div>
      {adding && (
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && !add.isPending) add.mutate(undefined);
          }}
        >
          <input className="input grow" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="e.g. Part II, or Revision" aria-label="New subtopic" />
          <button className="btn small" disabled={!title.trim() || add.isPending}>
            Add
          </button>
          <button type="button" className="btn ghost icon small" onClick={() => setAdding(false)} aria-label="Cancel">
            <XIcon width={14} />
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * While typing a new task: if you already have one with that name, offer to study it again; if the new name
 * is an existing one plus a bit more ("Pascal's Triangle III"), offer to add the bit as a subtopic there.
 */
export function SameNameHint({ title, existing, onAdded }: { title: string; existing: GoalTask[]; onAdded: () => void }) {
  const navigate = useNavigate();
  const typed = title.trim().replace(/\s+/g, ' ');
  const mine = existing.filter((t) => t.topicId);
  const same = mine.find((t) => norm(t.title) === norm(typed));
  const parent = same
    ? undefined
    : mine.filter((t) => norm(typed).startsWith(norm(t.title) + ' ')).sort((a, b) => b.title.length - a.title.length)[0];
  const rest = parent ? typed.slice(norm(parent.title).length).trim().replace(/^[-–:·,]\s*/, '') : '';
  const add = useAction(() => api.post(`/topics/${parent!.topicId}/subtopics`, { title: rest }), {
    invalidate: INVALIDATE,
    onSuccess: () => {
      toast(`Added “${rest}” to ${parent!.title} ✓`, 'success');
      onAdded();
    },
  });
  if (typed.length < 2 || (!same && !(parent && rest))) return null;
  return (
    <div className="same-name small" role="status">
      {same ? (
        <>
          You already have “{same.title}”{same.done ? ' (done)' : ''}. Study it again and add a subtopic there?{' '}
          <button type="button" className="btn small" onClick={() => navigate(`/study?topic=${same.topicId}`)}>
            Study it again
          </button>
        </>
      ) : (
        <>
          Looks like part of “{parent!.title}”.{' '}
          <button type="button" className="btn small" disabled={add.isPending} onClick={() => add.mutate(undefined)}>
            Add “{rest}” as a subtopic
          </button>
        </>
      )}
    </div>
  );
}

/** Fold this topic into another of yours: its time, completion and subtopics move across. */
export function MergeTopicModal({ task, candidates, onClose }: { task: GoalTask; candidates: GoalTask[]; onClose: () => void }) {
  const options = candidates
    .filter((c) => c.topicId && c.topicId !== task.topicId)
    .sort((a, b) => Number(norm(b.title) === norm(task.title)) - Number(norm(a.title) === norm(task.title)) || Number(a.done) - Number(b.done));
  const [into, setInto] = useState<string | null>(options[0]?.topicId ?? null);
  const merge = useAction(() => api.post(`/topics/${task.topicId}/merge`, { intoId: into }), {
    invalidate: [...INVALIDATE, ['home'], ['tasks']],
    success: 'Merged ✓',
    onSuccess: onClose,
  });
  const target = options.find((o) => o.topicId === into);
  return (
    <Modal
      title={`Merge “${task.title}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!into || merge.isPending} onClick={() => merge.mutate(undefined)}>
            Merge
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          Pick the topic to keep. “{task.title}” moves into it: its study time, completion and subtopics come along
          {target && norm(target.title) !== norm(task.title) ? `, and it becomes a subtopic of “${target.title}”` : ''}. Then “{task.title}” leaves your list.
          This can't be undone.
        </p>
        {options.length ? (
          <div className="stack merge-options" style={{ gap: 6 }} role="radiogroup" aria-label="Merge into">
            {options.map((o) => (
              <label key={o.topicId} className={`merge-option${into === o.topicId ? ' on' : ''}`}>
                <input type="radio" name="merge-into" checked={into === o.topicId} onChange={() => setInto(o.topicId)} />
                <span className="grow">
                  <b>{o.title}</b>
                  <span className="tiny muted">
                    {[norm(o.title) === norm(task.title) ? 'same name' : '', o.done ? 'done' : '', o.focusedMs ? fmt(o.focusedMs) : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="small">You have no other topics here to merge into.</p>
        )}
      </div>
    </Modal>
  );
}
