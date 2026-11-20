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
