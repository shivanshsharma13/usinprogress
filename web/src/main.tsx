import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { CACHE_MAX_AGE, persistOptions } from './lib/cache';
import { App } from './App';
import { applyScheme, installAccentVariables, storedScheme } from './lib/theme';
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
