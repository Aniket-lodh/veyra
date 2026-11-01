// One file owns every TanStack Query cache key for the app. Centralising
// makes invalidation refactor-safe: when an enqueue mutation needs to
// refresh the jobs list and the dashboard stats, it references these
// builders rather than re-typing string arrays at the call site.
//
// Convention:
//   queryKeys.jobs.all     → ['jobs']           — root for invalidation
//   queryKeys.jobs.list(p) → ['jobs', 'list', p]
//   queryKeys.jobs.detail  → ['jobs', 'detail', id]
//   queryKeys.workers.all  → ['workers']
//   queryKeys.stats.all    → ['queue-stats']
//
// Deeper namespaces match the hierarchy TanStack Query uses for partial
// invalidation: `invalidateQueries({ queryKey: queryKeys.jobs.all })`
// refreshes lists and details together.
import type { ListJobsParams } from '@/lib/api/jobs';

export const queryKeys = {
  jobs: {
    all: ['jobs'] as const,
    list: (params: ListJobsParams) => ['jobs', 'list', params] as const,
    detail: (id: string) => ['jobs', 'detail', id] as const,
  },
  workers: {
    all: ['workers'] as const,
  },
  stats: {
    all: ['queue-stats'] as const,
  },
} as const;
