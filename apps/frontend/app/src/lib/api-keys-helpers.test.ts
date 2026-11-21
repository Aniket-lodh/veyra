import {
  computeKeyMetrics,
  EXPIRY_PRESETS,
  filterApiKeys,
  generateCurlSnippet,
  getApiKeyLifecycle,
  getKeyStatusBadgeProps,
  maskSecret,
  SEVEN_DAYS_MS,
  validateCreateKeyInput,
} from './api-keys-helpers.ts';
import type { ApiKeyRow } from '@/lib/api/keys';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('api-keys-helpers', () => {
  const fixedNow = 1700000000000; // Fixed timestamp for deterministic tests

  const mockKey = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
    id: 'key_1',
    name: 'test-key',
    prefix: 'veyra_abcdef12',
    scopes: ['jobs:read'],
    createdAt: new Date(fixedNow - 86400000).toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });

  describe('getApiKeyLifecycle & Status Resolution', () => {
    it('returns "revoked" if revokedAt is set even if not expired', () => {
      const key = mockKey({
        revokedAt: new Date(fixedNow - 1000).toISOString(),
        expiresAt: new Date(fixedNow + 100000).toISOString(),
      });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'revoked');
    });

    it('returns "revoked" if revokedAt is set even if expired', () => {
      const key = mockKey({
        revokedAt: new Date(fixedNow - 1000).toISOString(),
        expiresAt: new Date(fixedNow - 100000).toISOString(),
      });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'revoked');
    });

    it('returns "expired" if expiresAt is in the past and unrevoked', () => {
      const key = mockKey({
        expiresAt: new Date(fixedNow - 1000).toISOString(),
      });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'expired');
    });

    it('returns "expiring_soon" if expiresAt is within 7 days', () => {
      const key = mockKey({
        expiresAt: new Date(fixedNow + SEVEN_DAYS_MS - 1000).toISOString(),
      });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'expiring_soon');
    });

    it('returns "active" if expiresAt is more than 7 days in future', () => {
      const key = mockKey({
        expiresAt: new Date(fixedNow + SEVEN_DAYS_MS + 86400000).toISOString(),
      });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'active');
    });

    it('returns "active" if expiresAt is null and unrevoked', () => {
      const key = mockKey({ expiresAt: null, revokedAt: null });
      assert.equal(getApiKeyLifecycle(key, fixedNow), 'active');
    });
  });

  describe('getKeyStatusBadgeProps', () => {
    it('maps all lifecycle states to expected tones and labels', () => {
      assert.deepEqual(getKeyStatusBadgeProps('active'), {
        tone: 'success',
        label: 'Active',
      });
      assert.deepEqual(getKeyStatusBadgeProps('expiring_soon'), {
        tone: 'warning',
        label: 'Expiring soon',
      });
      assert.deepEqual(getKeyStatusBadgeProps('expired'), {
        tone: 'warning',
        label: 'Expired',
      });
      assert.deepEqual(getKeyStatusBadgeProps('revoked'), {
        tone: 'danger',
        label: 'Revoked',
      });
    });
  });

  describe('computeKeyMetrics', () => {
    it('computes 5 mutually exclusive counts across lifecycle states', () => {
      const keys: ApiKeyRow[] = [
        mockKey({ id: 'k1', expiresAt: null }), // active
        mockKey({
          id: 'k2',
          expiresAt: new Date(fixedNow + 2 * 86400000).toISOString(),
        }), // expiring_soon
        mockKey({
          id: 'k3',
          expiresAt: new Date(fixedNow - 86400000).toISOString(),
        }), // expired
        mockKey({
          id: 'k4',
          revokedAt: new Date(fixedNow - 5000).toISOString(),
        }), // revoked
        mockKey({
          id: 'k5',
          revokedAt: new Date(fixedNow - 1000).toISOString(),
          expiresAt: new Date(fixedNow - 86400000).toISOString(),
        }), // revoked takes precedence
      ];

      const metrics = computeKeyMetrics(keys, fixedNow);
      assert.deepEqual(metrics, {
        total: 5,
        active: 1,
        expiringSoon: 1,
        expired: 1,
        revoked: 2,
      });
    });
  });

  describe('filterApiKeys', () => {
    const keys: ApiKeyRow[] = [
      mockKey({
        id: 'k1',
        name: 'payment-worker',
        prefix: 'veyra_11112222',
        scopes: ['jobs:write'],
        expiresAt: new Date(fixedNow + 10 * 86400000).toISOString(),
      }),
      mockKey({
        id: 'k2',
        name: 'expiring-pipeline',
        prefix: 'veyra_22223333',
        scopes: ['jobs:read'],
        expiresAt: new Date(fixedNow + 2 * 86400000).toISOString(),
      }),
      mockKey({
        id: 'k3',
        name: 'metrics-exporter',
        prefix: 'veyra_33334444',
        scopes: ['queue:read'],
        expiresAt: new Date(fixedNow - 1000).toISOString(),
      }),
      mockKey({
        id: 'k4',
        name: 'ci-runner',
        prefix: 'veyra_55556666',
        scopes: ['*'],
        revokedAt: new Date(fixedNow - 1000).toISOString(),
      }),
    ];

    it('matches query by name, prefix, or scope', () => {
      assert.equal(filterApiKeys(keys, 'payment', 'all', fixedNow).length, 1);
      assert.equal(filterApiKeys(keys, '33334444', 'all', fixedNow).length, 1);
      assert.equal(
        filterApiKeys(keys, 'queue:read', 'all', fixedNow).length,
        1,
      );
    });

    it('filters strictly by each lifecycle tab', () => {
      const all = filterApiKeys(keys, '', 'all', fixedNow);
      assert.equal(all.length, 4);

      const active = filterApiKeys(keys, '', 'active', fixedNow);
      assert.equal(active.length, 1);
      assert.equal(active[0].id, 'k1');

      const expiringSoon = filterApiKeys(keys, '', 'expiring_soon', fixedNow);
      assert.equal(expiringSoon.length, 1);
      assert.equal(expiringSoon[0].id, 'k2');

      const expired = filterApiKeys(keys, '', 'expired', fixedNow);
      assert.equal(expired.length, 1);
      assert.equal(expired[0].id, 'k3');

      const revoked = filterApiKeys(keys, '', 'revoked', fixedNow);
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].id, 'k4');
    });
  });

  describe('maskSecret', () => {
    it('masks full secret while preserving public prefix part', () => {
      const mockKey = ['veyra', '89abcdef', 'payload1234567890'].join('_');
      const masked = maskSecret(mockKey);
      assert.equal(masked.startsWith('veyra_89abcdef_•'), true);
      assert.equal(masked.includes('payload'), false);
    });

    it('returns empty string if secret is empty', () => {
      assert.equal(maskSecret(''), '');
    });
  });

  describe('validateCreateKeyInput', () => {
    it('rejects empty key name', () => {
      const res = validateCreateKeyInput({
        name: '   ',
        expiryPreset: '30d',
        scopeMode: 'custom',
        selectedScopes: ['jobs:read'],
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.error, 'Key name is required');
      }
    });

    it('rejects custom expiry in the past', () => {
      const res = validateCreateKeyInput({
        name: 'test-key',
        expiryPreset: 'custom',
        customExpiry: new Date(fixedNow - 1000).toISOString(),
        scopeMode: 'custom',
        selectedScopes: ['jobs:read'],
        now: fixedNow,
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.error, 'Expiration must be in the future');
      }
    });

    it('rejects empty scopes in custom mode', () => {
      const res = validateCreateKeyInput({
        name: 'test-key',
        expiryPreset: '30d',
        scopeMode: 'custom',
        selectedScopes: [],
        now: fixedNow,
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.error, 'Select at least one scope for this key');
      }
    });

    it('validates and formats granular scopes input correctly', () => {
      const res = validateCreateKeyInput({
        name: 'worker-key',
        expiryPreset: '90d',
        scopeMode: 'custom',
        selectedScopes: ['jobs:read', 'jobs:write'],
        now: fixedNow,
      });
      assert.equal(res.valid, true);
      if (res.valid) {
        assert.equal(res.data.name, 'worker-key');
        assert.deepEqual(res.data.scopes, ['jobs:read', 'jobs:write']);
        assert.equal(
          res.data.expiresAt,
          new Date(fixedNow + 90 * 86400000).toISOString(),
        );
      }
    });

    it('validates wildcard * when scopeMode is all', () => {
      const res = validateCreateKeyInput({
        name: 'admin-key',
        expiryPreset: 'never',
        scopeMode: 'all',
        selectedScopes: ['jobs:read'],
        now: fixedNow,
      });
      assert.equal(res.valid, true);
      if (res.valid) {
        assert.deepEqual(res.data.scopes, ['*']);
        assert.equal(res.data.expiresAt, null);
      }
    });
  });

  describe('EXPIRY_PRESETS', () => {
    it('contains standard lifecycle presets including never and custom', () => {
      assert.equal(
        EXPIRY_PRESETS.some((p) => p.id === 'never'),
        true,
      );
      assert.equal(
        EXPIRY_PRESETS.some((p) => p.id === '30d'),
        true,
      );
      assert.equal(
        EXPIRY_PRESETS.some((p) => p.id === '90d'),
        true,
      );
      assert.equal(
        EXPIRY_PRESETS.some((p) => p.id === 'custom'),
        true,
      );
    });
  });

  describe('generateCurlSnippet', () => {
    it('formats curl with bearer token and target URL', () => {
      const token = 'sample-token';
      const snippet = generateCurlSnippet(token, 'http://localhost:8008');
      assert.equal(snippet.includes(token), true);
      assert.equal(snippet.includes('http://localhost:8008/queue/stats'), true);
      assert.equal(snippet.startsWith('curl -s -i -H'), true);
    });

    it('defaults to http://localhost:8008 when origin is omitted', () => {
      const snippet = generateCurlSnippet('sample-token');
      assert.equal(snippet.includes('http://localhost:8008/queue/stats'), true);
    });
  });
});
