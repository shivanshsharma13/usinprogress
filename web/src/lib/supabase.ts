import { createClient } from '@supabase/supabase-js';

// The project URL and its public ("anon"/publishable) key are meant to be in browser code: every table
// is protected by row-level security, and every write goes through a checked database function.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);

// A password-reset link that has expired or was already used comes back with an error in the URL
// hash. Read it before the client tidies the URL.
const linkParams = new URLSearchParams(location.hash.slice(1));
export const linkError = linkParams.get('error_description');

// If Supabase sends a reset link to the Site URL instead of /reset, we still need to ask for the new
// password. True only on the first check after arriving from a reset link.
let recoveryArrival = linkParams.get('type') === 'recovery';
export function takeRecoveryArrival(): boolean {
  const arrived = recoveryArrival;
  recoveryArrival = false;
  return arrived;
}

/** Where reset emails send people: the /reset page of this site, wherever it is hosted. */
export const resetUrl = () => new URL(`${import.meta.env.BASE_URL}reset`, location.origin).href;

export const supabase = createClient(url ?? 'http://127.0.0.1:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
