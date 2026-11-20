import { apiFetch } from '@/lib/api/client';
import type { AuthUser } from '@/lib/auth/session';

export type AuthStatus = {
  bootstrapped: boolean;
  user?: AuthUser;
};

export function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  return apiFetch<AuthStatus>('/auth/status', {
    signal,
    skipAuthRedirect: true,
  });
}

export function login(
  email: string,
  password: string,
): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: { email, password },
    skipAuthRedirect: true,
  });
}

export function signup(
  email: string,
  password: string,
): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/auth/signup', {
    method: 'POST',
    body: { email, password },
    skipAuthRedirect: true,
  });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/auth/logout', {
    method: 'POST',
    skipAuthRedirect: true,
  });
}

export function fetchMe(signal?: AbortSignal): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/auth/me', { signal });
}
