import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { CACHE_MAX_AGE, persistOptions } from './lib/cache';
import { App } from './App';
import { applyScheme, installAccentVariables, storedScheme } from './lib/theme';
import { getFocusSettings } from './lib/focusSettings';
import { notificationWorker, setWorkerFastStart } from './lib/notifications';
import './lib/install';
import './styles.css';

installAccentVariables();
applyScheme(storedScheme());

const queryClient = new QueryClient({
  defaultOptions: {
    // Realtime marks screens stale when data changes, so cached screens can be shown straight away.
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2 * 60_000, gcTime: CACHE_MAX_AGE },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);

// The background worker keeps the app's files for a fast start (unless turned off in Settings) and shows
// notifications. Registering waits until the page has loaded so it never slows the first screen.
if (import.meta.env.PROD) addEventListener('load', () => void notificationWorker().then(() => setWorkerFastStart(getFocusSettings().fastStart)));
