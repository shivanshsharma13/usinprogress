import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { forgotPasswordSchema, newPasswordSchema } from '@shared/validation';
import { api, ApiError } from '../lib/api';
import { linkError, resetUrl } from '../lib/supabase';
import { toast } from '../lib/toast';
import { Field } from '../components/ui';
import { Buddy } from '../components/Buddy';

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card stack-lg">
        <div className="center stack" style={{ alignItems: 'center' }}>
          <div className="row" style={{ gap: 0 }}>
            <Buddy accent="blue" avatar={{ accessory: 'glasses' }} size={64} />
            <Buddy accent="pink" avatar={{ accessory: 'stethoscope' }} size={64} />
          </div>
          <h1>Us in Progress</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

function Help() {
  return (
    <div className="card stack small">
      <h3>Can't get back in?</h3>
      <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
        <li>Look in spam or promotions for an email from Supabase Auth.</li>
        <li>Use the newest email. Each link works once, for one hour.</li>
        <li>Make sure it's the email you signed up with. Your username won't work here.</li>
        <li>
          No email after a few minutes? Ask the person who runs this app. They can send you a reset link from the Supabase
          dashboard, under Authentication → Users.
        </li>
      </ul>
      <p className="tiny muted">Your rooms, plans and study history stay safe while you reset. Only the password changes.</p>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { email, redirectTo: resetUrl() };
    const check = forgotPasswordSchema.safeParse(body);
    if (!check.success) return setError({ field: 'email', message: check.error.issues[0].message });
    setBusy(true);
    try {
      await api.post('/auth/forgot', body);
      setSentTo(check.data.email);
    } catch (err) {
      setError({ message: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {sentTo ? (
        <div className="card stack">
          <h2>Check your inbox</h2>
          <p>
            If <b>{sentTo}</b> has an account, a reset link is on its way. Open it on this device and choose a new password.
          </p>
          <div className="row wrap">
            <button className="btn" onClick={() => setSentTo(null)}>
              Send again
            </button>
            <Link className="btn ghost" to="/signin">
              Back to sign in
            </Link>
          </div>
        </div>
      ) : (
        <form className="card stack" onSubmit={submit} noValidate>
          <h2>Forgot your password?</h2>
          <p className="small muted">Enter the email you signed up with and we'll send you a link to choose a new one.</p>
          <Field label="Email" error={error?.field === 'email' ? error.message : null}>
            <input className="input" type="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          {error && !error.field && (
            <div className="banner error" role="alert">
              {error.message}
            </div>
          )}
          <button className="btn primary big block" disabled={busy}>
            {busy ? 'One moment…' : 'Send reset link'}
          </button>
          <p className="center small muted">
            Remembered it? <Link to="/signin">Sign in</Link>
          </p>
        </form>
      )}
      <Help />
    </AuthShell>
  );
}

/** Signed out on /reset: the link was bad, expired or already used. */
export function ResetLinkProblemPage() {
  return (
    <AuthShell>
      <div className="card stack">
        <h2>That link didn't work</h2>
        <p className="small">{linkError ? `${linkError.replace(/\.?$/, '')}.` : 'This reset link has expired or was already used.'} Ask for a fresh one and use the newest email.</p>
        <Link className="btn primary block" to="/forgot">
          Send a new link
        </Link>
      </div>
      <Help />
    </AuthShell>
  );
}

export function NewPasswordForm({ onDone, submitLabel = 'Save new password' }: { onDone?: () => void; submitLabel?: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const check = newPasswordSchema.safeParse({ password, confirm });
    if (!check.success) {
      const issue = check.error.issues[0];
      return setError({ field: String(issue.path[0] ?? ''), message: issue.message });
    }
    setBusy(true);
    try {
      await api.put('/auth/password', { password, confirm });
      setPassword('');
      setConfirm('');
      toast('Password changed 🌱');
      onDone?.();
    } catch (err) {
      const e = err as ApiError;
      setError({ field: e.data?.field, message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (f: string) => (error?.field === f ? error.message : null);
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field label="New password" hint="At least 8 characters." error={fieldError('password')}>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <Field label="Type it again" error={fieldError('confirm')}>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      {error && !error.field && (
        <div className="banner error" role="alert">
          {error.message}
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy || !password}>
          {busy ? 'One moment…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Signed in through a reset link: choose the new password, then carry on. */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  return (
    <div className="stack-lg" style={{ maxWidth: 460, margin: '0 auto', width: '100%' }}>
      <div className="card stack">
        <h2>Choose a new password</h2>
        <p className="small muted">You're signed in from the reset link. Pick a new password so you can sign in next time.</p>
        <NewPasswordForm onDone={() => navigate('/', { replace: true })} />
      </div>
    </div>
  );
}
