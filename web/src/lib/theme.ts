import type { CSSProperties } from 'react';
import { ACCENTS, accentOf } from '@shared/theme';

export type Scheme = 'light' | 'dark';

const STORE_KEY = 'uip-scheme';

export function storedScheme(): Scheme {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyScheme(scheme: Scheme) {
  document.documentElement.dataset.theme = scheme;
  try {
    localStorage.setItem(STORE_KEY, scheme);
  } catch {}
}

/** Defines --acc-<key> / --acc-<key>-soft for every accent, with dark-mode variants. */
export function installAccentVariables() {
  const light = Object.values(ACCENTS).map((a) => `--acc-${a.key}: ${a.solid}; --acc-${a.key}-soft: ${a.surface};`).join(' ');
  const dark = Object.values(ACCENTS).map((a) => `--acc-${a.key}: ${a.solidDark}; --acc-${a.key}-soft: ${a.surfaceDark};`).join(' ');
  const style = document.createElement('style');
  style.textContent = `:root { ${light} } :root[data-theme='dark'] { ${dark} }`;
  document.head.appendChild(style);
}

const key = (accentKey: string | undefined) => accentOf(accentKey).key;

/** A person's identity colour as CSS variables --c / --c-soft (theme-aware). */
export function personVars(accentKey: string | undefined): CSSProperties {
  const k = key(accentKey);
  return { ['--c' as any]: `var(--acc-${k})`, ['--c-soft' as any]: `var(--acc-${k}-soft)` };
}

export const accentVar = (accentKey: string | undefined) => `var(--acc-${key(accentKey)})`;

/** Sets the signed-in user's accent as --me / --me-soft for the whole app. */
export function applyMyAccent(accentKey: string | undefined) {
  const k = key(accentKey);
  const root = document.documentElement.style;
  root.setProperty('--me', `var(--acc-${k})`);
  root.setProperty('--me-soft', `var(--acc-${k}-soft)`);
}
