import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../shell/AppContext.js';

type Rows = { data: Record<string, unknown>[] };

/** Fetches a list endpoint for the selected organisation. */
export function useList(path: string, enabled = true) {
  const { api, orgId } = useApp();
  return useQuery({
    queryKey: ['list', orgId, path],
    queryFn: async () => ((await api.get(path, orgId)) as Rows).data,
    enabled: enabled && !!orgId,
    retry: false,
  });
}

/** Invalidate everything fetched for this organisation after a change. */
export function useInvalidate() {
  const qc = useQueryClient();
  const { orgId } = useApp();
  return () =>
    qc
      .invalidateQueries({ queryKey: ['list', orgId] })
      .then(() => qc.invalidateQueries({ queryKey: ['one', orgId] }));
}

/** Fetches one resource (object response) for the selected organisation. */
export function useOne<T = Record<string, unknown>>(path: string | null, enabled = true) {
  const { api, orgId } = useApp();
  return useQuery({
    queryKey: ['one', orgId, path],
    queryFn: async () => (await api.get(path as string, orgId)) as T,
    enabled: enabled && !!orgId && !!path,
    retry: false,
  });
}

export interface Person {
  id: string;
  displayName: string;
  roleKeys: string[];
  roleNames: string[];
  locationIds: string[];
}
/** Active members of the organisation for owner and assignee pickers. */
export function usePeople(enabled = true) {
  const q = useOne<{ data: Person[] }>('/api/v1/admin/people', enabled);
  return q.data?.data ?? [];
}
