import { describe, expect, it } from 'vitest';
import {
  type Progress,
  emptyProgress,
  pendingFunnelIds,
  progressPathFor,
  recordOutcome,
  reconcile,
} from '../src/progress.js';

const NOW = '2026-08-05T06:00:00.000Z';
const LATER = '2026-08-05T06:05:00.000Z';

function fixture(): Progress {
  return {
    app: 'jordan',
    enumeratedAt: '2026-08-05T05:00:00.000Z',
    startedAt: NOW,
    updatedAt: NOW,
    total: 4,
    entries: {
      '584': { status: 'done', at: NOW, cells: 43, decisions: 1 },
      '987': { status: 'done', at: NOW, cells: 33, decisions: 1 },
      '953': { status: 'failed', at: NOW, error: 'editor timeout' },
    },
  };
}

describe('emptyProgress', () => {
  it('carries the enumeration timestamp through', () => {
    const p = emptyProgress('jordan', 170, '2026-08-05T05:00:00.000Z', NOW);
    expect(p).toMatchObject({
      app: 'jordan',
      total: 170,
      enumeratedAt: '2026-08-05T05:00:00.000Z',
      startedAt: NOW,
      updatedAt: NOW,
    });
    expect(p.entries).toEqual({});
  });

  it('tolerates an unknown enumeration timestamp', () => {
    expect(emptyProgress('jordan', 1, null, NOW).enumeratedAt).toBeNull();
  });
});

describe('pendingFunnelIds', () => {
  const all = ['584', '987', '953', '745'];

  it('skips completed campaigns', () => {
    expect(pendingFunnelIds(fixture(), all, false)).toEqual(['953', '745']);
  });

  it('retries failures — a failure is not a final state', () => {
    expect(pendingFunnelIds(fixture(), all, false)).toContain('953');
  });

  it('returns everything under force', () => {
    expect(pendingFunnelIds(fixture(), all, true)).toEqual(all);
  });

  it('preserves the order of the supplied list', () => {
    expect(pendingFunnelIds(fixture(), ['745', '953'], false)).toEqual(['745', '953']);
  });

  it('returns nothing when all are done', () => {
    expect(pendingFunnelIds(fixture(), ['584', '987'], false)).toEqual([]);
  });
});

describe('recordOutcome', () => {
  it('adds an entry and advances updatedAt', () => {
    const next = recordOutcome(fixture(), '745', { status: 'done', at: LATER, cells: 10 }, LATER);
    expect(next.entries['745']).toEqual({ status: 'done', at: LATER, cells: 10 });
    expect(next.updatedAt).toBe(LATER);
  });

  it('does not mutate the input', () => {
    const before = fixture();
    recordOutcome(before, '745', { status: 'done', at: LATER }, LATER);
    expect(before.entries['745']).toBeUndefined();
    expect(before.updatedAt).toBe(NOW);
  });

  it('overwrites a previous failure when the retry succeeds', () => {
    const next = recordOutcome(fixture(), '953', { status: 'done', at: LATER, cells: 5 }, LATER);
    expect(next.entries['953']).toMatchObject({ status: 'done' });
    expect(next.entries['953']?.error).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('demotes a done entry whose artifacts are gone, and names it', () => {
    const result = reconcile(fixture(), (id) => id !== '987', LATER);
    expect(result.demoted).toEqual(['987']);
    expect(result.progress.entries['987']).toBeUndefined();
    expect(result.progress.entries['584']).toMatchObject({ status: 'done' });
  });

  it('leaves failures alone — they have no artifacts to verify', () => {
    const result = reconcile(fixture(), () => false, LATER);
    expect(result.demoted).toEqual(['584', '987']);
    expect(result.progress.entries['953']).toMatchObject({ status: 'failed' });
  });

  it('reports nothing when disk agrees', () => {
    const result = reconcile(fixture(), () => true, LATER);
    expect(result.demoted).toEqual([]);
    expect(result.progress).toEqual(fixture());
  });

  it('does not mutate the input', () => {
    const before = fixture();
    reconcile(before, () => false, LATER);
    expect(before.entries['584']).toMatchObject({ status: 'done' });
  });
});

describe('progressPathFor', () => {
  it('nests under the app directory', () => {
    expect(progressPathFor('jordan')).toBe('artifacts/jordan/progress.json');
  });

  it('validates the app name', () => {
    expect(() => progressPathFor('../../etc')).toThrow(/Invalid app name/);
  });
});

describe('Progress round-trips through JSON', () => {
  it('preserves every field', () => {
    const before = fixture();
    expect(JSON.parse(JSON.stringify(before))).toEqual(before);
  });
});
