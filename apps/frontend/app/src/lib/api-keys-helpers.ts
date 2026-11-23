import type { ApiKeyRow } from '@/lib/api/keys';

export type KeyLifecycleStatus =
  | 'active'
  | 'expiring_soon'
  | 'expired'
  | 'revoked';

export type ScopeDefinition = {
  scope: string;
  label: string;
  description: string;
};

export const KNOWN_SCOPES: ScopeDefinition[] = [
  {
    scope: 'jobs:read',
    label: 'jobs:read',
    description: 'Inspect jobs, payloads, attempts, and execution history.',
  },
  {
    scope: 'jobs:write',
    label: 'jobs:write',
    description: 'Enqueue new jobs and issue cancellation requests.',
  },
  {
    scope: 'queue:read',
    label: 'queue:read',
    description: 'Query aggregate queue statistics and active worker leases.',
  },
  {
    scope: 'keys:admin',
    label: 'keys:admin',
    description: 'Provision, inspect, and revoke machine API credentials.',
  },
  {
    scope: 'debug',
    label: 'debug',
    description: 'Access /internal/debug endpoints for local testing.',
  },
  {
    scope: '*',
    label: 'Full Access (*)',
    description: 'Unrestricted access to all current and future endpoints.',
  },
];

export const EXPIRY_PRESETS = [
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '180d', label: '180 days', days: 180 },
  { id: '365d', label: '1 year', days: 365 },
  { id: 'never', label: 'Never expires', days: null },
  { id: 'custom', label: 'Custom date', days: -1 },
] as const;

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the effective lifecycle status of an API key.
 * If revokedAt is set, it is always revoked.
 * If expiresAt is set and in the past, it is expired (backend rejects with 401).
 * If expiresAt is within 7 days, it is expiring_soon.
 * Otherwise active.
 */
export function getApiKeyLifecycle(
  key: Pick<ApiKeyRow, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): KeyLifecycleStatus {
  if (key.revokedAt) {
    return 'revoked';
  }
  if (key.expiresAt) {
    const expTime = new Date(key.expiresAt).getTime();
    if (expTime <= now) {
      return 'expired';
    }
    if (expTime - now <= SEVEN_DAYS_MS) {
      return 'expiring_soon';
    }
  }
  return 'active';
}

/**
 * Maps lifecycle status to semantic badge tone and label.
 */
export function getKeyStatusBadgeProps(status: KeyLifecycleStatus): {
  tone: 'success' | 'warning' | 'danger';
  label: string;
} {
  switch (status) {
    case 'revoked':
      return { tone: 'danger', label: 'Revoked' };
    case 'expired':
      return { tone: 'warning', label: 'Expired' };
    case 'expiring_soon':
      return { tone: 'warning', label: 'Expiring soon' };
    case 'active':
    default:
      return { tone: 'success', label: 'Active' };
  }
}

/**
 * Calculates summary KPI metrics for the keys inventory.
 * Each key is counted into exactly one primary category so sum(active, expiringSoon, expired, revoked) === total.
 */
export function computeKeyMetrics(keys: ApiKeyRow[], now = Date.now()) {
  let active = 0;
  let expiringSoon = 0;
  let expired = 0;
  let revoked = 0;

  for (const key of keys) {
    const status = getApiKeyLifecycle(key, now);
    if (status === 'revoked') {
      revoked++;
    } else if (status === 'expired') {
      expired++;
    } else if (status === 'expiring_soon') {
      expiringSoon++;
    } else {
      active++;
    }
  }

  return {
    total: keys.length,
    active,
    expiringSoon,
    expired,
    revoked,
  };
}

/**
 * Filters keys based on a search query and a status category.
 * Strictly maps to the lifecycle status so past-expiry unrevoked keys are never misclassified.
 */
export function filterApiKeys(
  keys: ApiKeyRow[],
  query: string,
  statusFilter: 'all' | 'active' | 'expiring_soon' | 'expired' | 'revoked',
  now = Date.now(),
): ApiKeyRow[] {
  const normalizedQuery = query.trim().toLowerCase();

  return keys.filter((key) => {
    const lifecycle = getApiKeyLifecycle(key, now);
    if (statusFilter !== 'all') {
      if (statusFilter !== lifecycle) {
        return false;
      }
    }

    if (!normalizedQuery) return true;

    const nameMatch = key.name.toLowerCase().includes(normalizedQuery);
    const prefixMatch = key.prefix.toLowerCase().includes(normalizedQuery);
    const scopeMatch = key.scopes.some((s) =>
      s.toLowerCase().includes(normalizedQuery),
    );

    return nameMatch || prefixMatch || scopeMatch;
  });
}

/**
 * Masks the secret token for shoulder-surfing protection while preserving the prefix.
 * Token format: veyra_<prefix>_<secretBody>
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const parts = secret.split('_');
  if (parts.length >= 3) {
    const prefixPart = `${parts[0]}_${parts[1]}`;
    return `${prefixPart}_••••••••••••••••••••••••••••••••••••••••••••••••`;
  }
  return '••••••••••••••••••••••••••••••••••••••••••••••••';
}

/**
 * Validates key creation input and prepares payload for submission.
 */
export function validateCreateKeyInput(input: {
  name: string;
  expiryPreset: string;
  customExpiry?: string;
  scopeMode: 'all' | 'custom';
  selectedScopes: string[];
  now?: number;
}):
  | {
      valid: true;
      data: { name: string; expiresAt: string | null; scopes: string[] };
    }
  | { valid: false; error: string } {
  const now = input.now ?? Date.now();
  const trimmedName = input.name.trim();

  if (!trimmedName) {
    return { valid: false, error: 'Key name is required' };
  }

  let expiresAt: string | null = null;
  if (input.expiryPreset === 'never') {
    expiresAt = null;
  } else if (input.expiryPreset === 'custom') {
    if (!input.customExpiry) {
      return { valid: false, error: 'Please choose a custom expiration date' };
    }
    const d = new Date(input.customExpiry);
    if (Number.isNaN(d.getTime()) || d.getTime() <= now) {
      return { valid: false, error: 'Expiration must be in the future' };
    }
    expiresAt = d.toISOString();
  } else {
    const preset = EXPIRY_PRESETS.find((p) => p.id === input.expiryPreset);
    if (preset?.days) {
      const d = new Date(now + preset.days * 86400000);
      expiresAt = d.toISOString();
    }
  }

  let scopes: string[] = ['*'];
  if (input.scopeMode === 'custom') {
    const validScopes = input.selectedScopes.filter(Boolean);
    if (validScopes.length === 0) {
      return { valid: false, error: 'Select at least one scope for this key' };
    }
    scopes = validScopes;
  }

  return {
    valid: true,
    data: {
      name: trimmedName,
      expiresAt,
      scopes,
    },
  };
}

/**
 * Generates an operator curl command snippet to verify a minted secret.
 */
export function generateCurlSnippet(secret: string, origin?: string): string {
  const base = origin || 'http://localhost:8080';
  return `curl -s -i -H "Authorization: Bearer ${secret}" "${base}/queue/stats"`;
}
