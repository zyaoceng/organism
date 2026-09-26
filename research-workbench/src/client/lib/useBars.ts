import { useCallback, useEffect, useState } from 'react';
import type { Bar } from '../../domain/market/indicators';
import type { BarsResponse } from '../../shared/api';
import { api } from './api';
import { useWorkspace } from './store';

/** Daily bars for the project's primary security from its configured price source (cached server-side). */
export function useBars(provider?: string) {
  const sec = useWorkspace((s) => s.securities[0]);
  const [res, setRes] = useState<BarsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (refresh = false) => {
      if (!sec) return;
      setLoading(true);
      try {
        setRes(await api.bars(sec.id, provider ?? sec.priceSource, refresh));
      } catch (e) {
        setRes({ provider: provider ?? sec.priceSource, bars: [], lastFetchedAt: null, error: (e as Error).message });
      } finally {
        setLoading(false);
      }
    },
    [sec, provider],
  );
  useEffect(() => {
    void load(false);
  }, [load]);
  const bars: Bar[] = res?.bars ?? [];
  return { bars, res, loading, reload: load, security: sec };
}
