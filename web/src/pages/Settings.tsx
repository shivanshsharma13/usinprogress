import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ACCENTS, DEFAULT_ACCENT, type AvatarConfig, type ProfileType } from '@shared/theme';
import type { Me } from '@shared/types';
import { useAction, useMe } from '../lib/queries';
import { api } from '../lib/api';
import { applyScheme, personVars } from '../lib/theme';
import { Field, Spinner, Switch } from '../components/ui';
import { Buddy } from '../components/Buddy';

const ACCESSORIES: { key: NonNullable<AvatarConfig['accessory']>; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'glasses', label: 'Glasses' },
  { key: 'stethoscope', label: 'Stethoscope' },
  { key: 'headphones', label: 'Headphones' },
  { key: 'leaf', label: 'Leaf' },
  { key: 'bow', label: 'Bow' },
];
const MOODS: { key: NonNullable<AvatarConfig['mood']>; label: string }[] = [
  { key: 'happy', label: 'Happy' },
  { key: 'calm', label: 'Calm' },
  { key: 'sleepy', label: 'Sleepy' },
];

export function SettingsPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState<Me | null>(null);
  useEffect(() => {
    if (me && !f) setF(me);
  }, [me]);

  const save = useAction((body: Partial<Me>) => api.patch<{ me: Me }>('/me', body), {
    invalidate: [['me']],
    success: 'Saved',
    onSuccess: (r) => {
      qc.setQueryData<any>(['me'], r.me);
      setF(r.me);
    },
  });
  const signOut = async () => {
    await api.post('/auth/signout');
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData<any>(['me'], null);
    navigate('/', { replace: true });
  };

  if (!me || !f) return <Spinner />;
  const set = (p: Partial<Me>) => setF({ ...f, ...p });
  const dirty = f.displayName !== me.displayName || f.bio !== me.bio || f.profileType !== me.profileType || f.accent !== me.accent || JSON.stringify(f.avatar) !== JSON.stringify(me.avatar) || f.timezone !== me.timezone;

  return (
    <div className="stack-lg" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h1>Profile & settings</h1>
          <p className="muted">@{me.username}</p>
        </div>
        <button className="btn" onClick={signOut}>
          Sign out
        </button>
      </div>

      <div className="card stack" style={personVars(f.accent)}>
        <div className="row">
          <span className="avatar" style={{ width: 88, height: 88 }}>
            <Buddy accent={f.accent} avatar={f.avatar} size={80} />
          </span>
          <div className="grow stack" style={{ gap: 8 }}>
            <Field label="Your name">
              <input className="input" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={40} />
            </Field>
          </div>
        </div>
        <Field label="About you">
          <input className="input" value={f.bio} onChange={(e) => set({ bio: e.target.value })} maxLength={200} />
        </Field>
        <div className="field">
          <span className="label">What best describes you?</span>
          <div className="row wrap">
            {(['engineer', 'doctor', 'custom'] as ProfileType[]).map((t) => (
              <button
                key={t}
                className={`chip-btn${f.profileType === t ? ' on' : ''}`}
                onClick={() => set({ profileType: t, accent: t === 'custom' ? f.accent : DEFAULT_ACCENT[t] })}
              >
                {t === 'engineer' ? 'Engineer' : t === 'doctor' ? 'Doctor' : 'Custom'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Your colour</span>
          <div className="row wrap">
            {Object.values(ACCENTS).map((a) => (
              <button key={a.key} className={`swatch${f.accent === a.key ? ' on' : ''}`} style={{ background: `var(--acc-${a.key})` }} aria-label={a.label} aria-pressed={f.accent === a.key} onClick={() => set({ accent: a.key })} />
            ))}
          </div>
          <span className="hint">Your friend sees you in this colour everywhere. Changing it never changes your study records.</span>
        </div>
        <div className="field">
          <span className="label">Study buddy</span>
          <div className="row wrap">
            {ACCESSORIES.map((a) => (
              <button key={a.key} className={`chip-btn${(f.avatar.accessory ?? 'none') === a.key ? ' on' : ''}`} onClick={() => set({ avatar: { ...f.avatar, accessory: a.key } })}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="row wrap">
            {MOODS.map((m) => (
              <button key={m.key} className={`chip-btn${(f.avatar.mood ?? 'happy') === m.key ? ' on' : ''}`} onClick={() => set({ avatar: { ...f.avatar, mood: m.key } })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Time zone" hint="Used to decide what counts as “today”.">
          <div className="row">
            <input className="input grow" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} />
            <button className="btn small" onClick={() => set({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>
              Use this device's
            </button>
          </div>
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" disabled={!dirty} onClick={() => setF(me)}>
            Reset
          </button>
          <button
            className="btn primary"
            disabled={!dirty || save.isPending || !f.displayName.trim()}
            onClick={() => save.mutate({ displayName: f.displayName, bio: f.bio, profileType: f.profileType, accent: f.accent, avatar: f.avatar, timezone: f.timezone })}
          >
            Save profile
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2>Privacy & display</h2>
        <Switch checked={me.shareStatus} onChange={(v) => save.mutate({ shareStatus: v })} label="Show my live study status to friends" />
        <p className="tiny muted">When off, friends only see that your status is private. Your goals are private unless you share each one.</p>
        <Switch
          checked={me.colorScheme === 'dark'}
          onChange={(v) => {
            applyScheme(v ? 'dark' : 'light');
            save.mutate({ colorScheme: v ? 'dark' : 'light' });
          }}
          label="Dark mode"
        />
      </div>
    </div>
  );
}
