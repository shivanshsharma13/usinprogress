// Account-wide switches for optional features (Settings → Motivation & focus). Flipping one updates the
// screen straight away and saves in the background; a failed save puts it back.
import { useQueryClient } from '@tanstack/react-query';
import type { Me, PrefKey } from '@shared/types';
import { api } from './api';
import { useAction, useMe } from './queries';

export function usePref(key: PrefKey): [boolean, (on: boolean) => void, boolean] {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const save = useAction((on: boolean) => api.patch<{ me: Me }>('/me', { prefs: { [key]: on } }), {
    invalidate: [['me']],
    onSuccess: (r) => qc.setQueryData<Me>(['me'], r.me),
    onError: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const set = (on: boolean) => {
    qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, prefs: { ...m.prefs, [key]: on } } : m));
    save.mutate(on);
  };
  return [me?.prefs?.[key] === true, set, save.isPending];
}
