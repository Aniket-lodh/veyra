import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/auth-context';
import { useState, type FormEvent } from 'react';

export function AuthScreen() {
  const { state, signIn, signUp } = useAuth();
  const isBootstrap = state.status === 'bootstrap';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (isBootstrap) {
        await signUp(email.trim(), password);
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the API. Is it running?');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="border-border w-full max-w-sm space-y-4 border p-6"
      >
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Veyra
          </p>
          <h1 className="text-lg font-semibold tracking-tight">
            {isBootstrap ? 'Create admin account' : 'Sign in'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isBootstrap
              ? 'Set up the first admin for this deployment. Use at least 12 characters for the password.'
              : 'Sign in with your operator email and password.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete={isBootstrap ? 'new-password' : 'current-password'}
            required
            minLength={isBootstrap ? 12 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error ? (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Please wait…' : isBootstrap ? 'Create admin' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
