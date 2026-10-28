import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ACCENTS, DEFAULT_ACCENT, type ProfileType } from '@shared/theme';
import { signUpSchema } from '@shared/validation';
import type { Me } from '@shared/types';
import { api, ApiError } from '../lib/api';
import { personVars } from '../lib/theme';
import { Buddy } from '../components/Buddy';
import { Field } from '../components/ui';

const TYPES: { key: ProfileType; title: string; text: string; accessory: 'glasses' | 'stethoscope' | 'leaf' }[] = [
  { key: 'engineer', title: 'Engineer', text: 'Calm blue, notebooks and little algorithms.', accessory: 'glasses' },
  { key: 'doctor', title: 'Doctor', text: 'Soft pink, botanical notes and gentle care.', accessory: 'stethoscope' },
  { key: 'custom', title: 'Custom', text: 'Pick your own colour.', accessory: 'leaf' },
];

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileType, setProfileType] = useState<ProfileType>('engineer');
  const [accent, setAccent] = useState('lavender');
  const [bio, setBio] = useState('');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body =
      mode === 'signup'
        ? {
            username,
            password,
            displayName,
            profileType,
            accent: profileType === 'custom' ? accent : DEFAULT_ACCENT[profileType],
            bio: bio || undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        : { username, password };
    if (mode === 'signup') {
      const check = signUpSchema.safeParse(body);
      if (!check.success) {
        const issue = check.error.issues[0];
        setError({ field: String(issue.path[0] ?? ''), message: issue.message });
        return;
      }
    }
    setBusy(true);
    try {
      const res = await api.post<{ me: Me }>(mode === 'signup' ? '/auth/signup' : '/auth/signin', body);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData<any>(['me'], res.me);
      navigate(mode === 'signup' ? '/friends?welcome=1' : '/', { replace: true });
    } catch (err) {
      const e = err as ApiError;
      setError({ field: e.data?.field, message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (f: string) => (error?.field === f ? error.message : null);
  const previewAccent = profileType === 'custom' ? accent : DEFAULT_ACCENT[profileType];

  return (
    <div className="auth-wrap">
      <div className="auth-card stack-lg">
        <div className="center stack" style={{ alignItems: 'center' }}>
          <div className="row" style={{ gap: 0 }}>
            <Buddy accent="blue" avatar={{ accessory: 'glasses' }} size={64} />
            <Buddy accent="pink" avatar={{ accessory: 'stethoscope' }} size={64} />
          </div>
          <h1>Us in Progress</h1>
          <p className="muted">A quiet little garden where two people grow, side by side.</p>
        </div>

        <form className="card stack" onSubmit={submit} noValidate>
          <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
          <Field label="Username" hint={mode === 'signup' ? 'Your friend will search for this.' : undefined} error={fieldError('username')}>
            <input className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined} error={fieldError('password')}>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>

          {mode === 'signup' && (
            <>
              <Field label="Your name" hint="What your friend will see." error={fieldError('displayName')}>
                <input className="input" autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </Field>
              <div className="field">
                <span className="label">What best describes you?</span>
                <div className="choice-grid" role="radiogroup">
                  {TYPES.map((t) => {
                    const acc = t.key === 'custom' ? accent : DEFAULT_ACCENT[t.key];
                    return (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={profileType === t.key}
                        key={t.key}
                        className={`choice${profileType === t.key ? ' on' : ''}`}
                        style={personVars(acc)}
                        onClick={() => setProfileType(t.key)}
                      >
                        <Buddy accent={acc} avatar={{ accessory: t.accessory }} size={44} />
                        <b>{t.title}</b>
                        <span className="small muted">{t.text}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="hint">This only changes colours and little details — you can study anything, and change it later.</span>
              </div>
              {profileType === 'custom' && (
                <div className="field">
                  <span className="label">Your colour</span>
                  <div className="row wrap">
                    {Object.values(ACCENTS).map((a) => (
                      <button
                        type="button"
                        key={a.key}
                        className={`swatch${accent === a.key ? ' on' : ''}`}
                        style={{ background: `var(--acc-${a.key})` }}
                        aria-label={a.label}
                        aria-pressed={accent === a.key}
                        onClick={() => setAccent(a.key)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <Field label="A short line about you (optional)">
                <input className="input" maxLength={200} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="e.g. Preparing for interviews, one problem at a time" />
              </Field>
            </>
          )}

          {error && !error.field && (
            <div className="banner error" role="alert">
              {error.message}
            </div>
          )}
          <button className="btn primary big block" disabled={busy} style={mode === 'signup' ? ({ ['--me' as any]: `var(--acc-${previewAccent})` }) : undefined}>
            {busy ? 'One moment…' : mode === 'signup' ? 'Create my account' : 'Sign in'}
          </button>
          <p className="center small muted">
            {mode === 'signup' ? (
              <>
                Already have an account? <Link to="/signin">Sign in</Link>
              </>
            ) : (
              <>
                New here? <Link to="/signup">Create an account</Link>
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
