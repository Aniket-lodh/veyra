let authRequiredNotifier: (() => void) | null = null;

export function registerAuthRequiredNotifier(fn: () => void): void {
  authRequiredNotifier = fn;
}

export function notifyAuthRequired(): void {
  authRequiredNotifier?.();
}
