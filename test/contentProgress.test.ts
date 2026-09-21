import { describe, expect, it } from 'vitest';
import {
  type ContentProgress,
  contentProgressPathFor,
  emptyContentProgress,
  pendingItems,
  reconcileContent,
  recordItem,
} from '../src/content/progress.js';
import type { ContentItemKey } from '../src/content/types.js';

const NOW = '2026-09-21T06:00:00.000Z';
const LATER = '2026-09-21T06:05:00.000Z';
const item = (id: string): ContentItemKey => ({ kind: 'email', attribute: 'marketingEmailId', id });

function fixture(): ContentProgress {
  return {
    app: 'jordan',
    startedAt: NOW,
    updatedAt: NOW,
    entries: {
      'email:marketingEmailId:1': { status: 'done', at: NOW },
      'email:marketingEmailId:2': { status: 'failed', at: NOW, error: 'timeout' },
      'email:marketingEmailId:3': { status: 'notFound', at: NOW },
    },
  };
}

describe('pendingItems', () => {
  const all = ['1', '2', '3', '4'].map(item);

  it('retries failures and skips done and notFound', () => {
    expect(pendingItems(fixture(), all, false).map((i) => i.id)).toEqual(['2', '4']);
  });

  it('returns everything when forced', () => {
    expect(pendingItems(fixture(), all, true)).toHaveLength(4);
  });
});

describe('recordItem', () => {
  it('records without mutating', () => {
    const before = fixture();
    const after = recordItem(before, 'email:marketingEmailId:4', { status: 'done', at: LATER }, LATER);
    expect(after.entries['email:marketingEmailId:4']?.status).toBe('done');
    expect(after.updatedAt).toBe(LATER);
    expect(before.entries['email:marketingEmailId:4']).toBeUndefined();
  });
});

describe('reconcileContent', () => {
  it('demotes done entries whose stored item is missing', () => {
    const { progress, demoted } = reconcileContent(fixture(), () => false, LATER);
    expect(demoted).toEqual(['email:marketingEmailId:1']);
    expect(progress.entries['email:marketingEmailId:1']).toBeUndefined();
    expect(progress.entries['email:marketingEmailId:3']?.status).toBe('notFound');
  });

  it('returns the same object when nothing changes', () => {
    const before = fixture();
    expect(reconcileContent(before, () => true, LATER).progress).toBe(before);
  });
});

describe('paths', () => {
  it('files progress beside the other artifacts', () => {
    expect(contentProgressPathFor('Jordan')).toBe('artifacts/jordan/content-progress.json');
    expect(emptyContentProgress('jordan', NOW).entries).toEqual({});
  });
});
