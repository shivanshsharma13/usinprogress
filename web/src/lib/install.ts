// Installing the app on the home screen. Chrome and Edge offer an install prompt once the page qualifies;
// we hold on to it so Settings can show an "Install" button. Safari has no prompt, only Share → Add to
// Home Screen, so Settings explains that instead.
import { useSyncExternalStore } from 'react';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState = 'installed' | 'ready' | 'ios' | 'unavailable';

let deferred: InstallPrompt | null = null;
let installed = typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    changed();
  });
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function state(): InstallState {
  if (installed) return 'installed';
  if (deferred) return 'ready';
  if (isIos()) return 'ios';
  return 'unavailable';
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    state,
  );
}

/** Shows the browser's install dialog. Resolves true if the person installed the app. */
export async function installApp(): Promise<boolean> {
  if (!deferred) return false;
  const prompt = deferred;
  deferred = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === 'accepted') installed = true;
  changed();
  return outcome === 'accepted';
}
