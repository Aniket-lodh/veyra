import { parseLivePayload } from './payload.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('parseLivePayload', () => {
  it('parses invalidate resources', () => {
    const resources = parseLivePayload(
      JSON.stringify({
        v: 1,
        revision: 7,
        resources: ['jobs', 'stats'],
        at: '2026-11-07T00:00:00Z',
      }),
    );
    assert.deepEqual(resources, ['jobs', 'stats']);
  });

  it('filters unknown resources', () => {
    const resources = parseLivePayload(
      JSON.stringify({ v: 1, revision: 1, resources: ['jobs', 'nope'] }),
    );
    assert.deepEqual(resources, ['jobs']);
  });

  it('returns null on garbage', () => {
    assert.equal(parseLivePayload('not-json'), null);
    assert.equal(parseLivePayload('{"resources":"x"}'), null);
  });
});
