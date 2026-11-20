import { fetchAuthStatus, login, logout, signup } from '@/lib/api/auth';
import type { AuthUser } from '@/lib/auth/session';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type AuthState =
  | { status: 'loading' }
  | { status: 'bootstrap' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthUser };

type AuthContextValue = {
  state: AuthState;
  user: AuthUser | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  onSessionExpired: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_STATUS_KEY = ['auth-status'] as const;

function statusToState(
  data: { bootstrapped: boolean; user?: AuthUser } | undefined,
  isLoading: boolean,
  isError: boolean,
): AuthState {
  if (isLoading) return { status: 'loading' };
  if (isError) return { status: 'unauthenticated' };
  if (!data) return { status: 'loading' };
  if (!data.bootstrapped) return { status: 'bootstrap' };
  if (data.user) return { status: 'authenticated', user: data.user };
  return { status: 'unauthenticated' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [sessionExpired, setSessionExpired] = useState(false);

  const statusQuery = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: ({ signal }) => fetchAuthStatus(signal),
    staleTime: 30_000,
    retry: false,
  });

  const state: AuthState = useMemo(() => {
    const derived = statusToState(
      statusQuery.data,
      statusQuery.isLoading || (statusQuery.isFetching && !statusQuery.data),
      statusQuery.isError,
    );
    if (sessionExpired && derived.status === 'authenticated') {
      return { status: 'unauthenticated' };
    }
    return derived;
  }, [
    statusQuery.data,
    statusQuery.isLoading,
    statusQuery.isFetching,
    statusQuery.isError,
    sessionExpired,
  ]);

  const refresh = useCallback(async () => {
    setSessionExpired(false);
    await queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY });
  }, [queryClient]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { user } = await login(email, password);
      setSessionExpired(false);
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        bootstrapped: true,
        user,
      });
    },
    [queryClient],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      const { user } = await signup(email, password);
      setSessionExpired(false);
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        bootstrapped: true,
        user,
      });
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setSessionExpired(false);
      queryClient.setQueryData(AUTH_STATUS_KEY, {
        bootstrapped: true,
        user: undefined,
      });
    }
  }, [queryClient]);

  const onSessionExpired = useCallback(() => {
    setSessionExpired(true);
  }, []);

  const value = useMemo(
    () => ({
      state,
      user: state.status === 'authenticated' ? state.user : null,
      refresh,
      signIn,
      signUp,
      signOut,
      onSessionExpired,
    }),
    [state, refresh, signIn, signUp, signOut, onSessionExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
