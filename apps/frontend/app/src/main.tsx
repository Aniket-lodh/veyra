import App from './App.tsx';
import './index.css';
import { ApiError } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// QueryClient defaults tuned for an operator dashboard. Reasoning behind
// each non-default:
//
//   refetchOnWindowFocus: false
//     Operators leave this tab open in a corner. Refetching on every tab
//     switch is noisy and would clobber an in-progress filter typing.
//
//   retry: only on network / 5xx, never on 4xx
//     4xx responses (404 on a missing job, 400 on an invalid filter) are
//     the api telling us "this request was wrong" — retrying just amplifies
//     the bad call. Network glitches and 5xx are worth one retry.
//
//   staleTime: 1s
//     The hooks already poll explicitly (refetchInterval); staleTime > 0
//     suppresses the "fetch immediately when this query mounts" behavior
//     that would otherwise double-fetch when two screens share a key
//     within a single tick.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1_000,
      retry: (failureCount, error) => {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
