import { describe, expect, it } from 'vitest';
import { buildQueue, campaignRefs, contentRefsOf } from '../src/content/collect.js';
import { itemDirName, itemKey } from '../src/content/types.js';
import { makeNode } from './fixtures/graphFixtures.js';

const email = (cellId: string, id: string) =>
  makeNode({
    cellId,
    style: 'email',
    name: `Email ${id}`,
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  });

const UNLAYER_ID = 'f2b4dd0d-3a9a-4442-8b04-dd5388c060c2';
const CONVRRT_ID = 'a48c6cc8-af85-498d-8b86-cac4eda2977b';

describe('itemKey / itemDirName', () => {
  it('keys on kind, attribute and id', () => {
    expect(itemKey({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('form:webformId:681');
  });

  it('uses the bare id for the primary attribute and prefixes the others', () => {
    expect(itemDirName({ kind: 'form', attribute: 'webformId', id: '681' })).toBe('681');
    expect(itemDirName({ kind: 'form', attribute: 'internalFormId', id: '681' })).toBe(
      'internalFormId-681',
    );
  });

  it('prefixes a convrrt landing page key with its attribute', () => {
    expect(itemDirName({ kind: 'landingPage', attribute: 'convrrtLandingPageId', id: CONVRRT_ID })).toBe(
      `convrrtLandingPageId-${CONVRRT_ID}`,
    );
  });
});

describe('contentRefsOf', () => {
  it('lifts scalar references', () => {
    const refs = contentRefsOf([email('7', '2048')]);
    expect(refs.map((r) => r.key)).toEqual([
      { kind: 'email', attribute: 'marketingEmailId', id: '2048' },
    ]);
  });

  it('lifts array references, one per value', () => {
    const node = makeNode({
      style: 'landingPage',
      references: { tagIds: [], tagCategoryIds: [], landingPageId: ['11', '12'] },
    });
    expect(contentRefsOf([node]).map((r) => r.key.id)).toEqual(['11', '12']);
  });

  it('keeps two id spaces of the same kind apart', () => {
    const node = makeNode({
      style: 'newsletterRequest',
      references: { tagIds: [], tagCategoryIds: [], webformId: '681', internalFormId: '681' },
    });
    expect(contentRefsOf([node]).map((r) => itemKey(r.key))).toEqual([
      'form:webformId:681',
      'form:internalFormId:681',
    ]);
  });

  it('ignores ids that fail the content id pattern', () => {
    const node = makeNode({
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '../../etc' },
    });
    expect(contentRefsOf([node])).toEqual([]);
  });

  it('lifts a UUID reference for a modern Unlayer landing page', () => {
    const node = makeNode({
      style: 'unlayerLandingPage',
      references: { tagIds: [], tagCategoryIds: [], unlayerLandingPageId: UNLAYER_ID },
    });
    expect(contentRefsOf([node]).map((r) => r.key)).toEqual([
      { kind: 'landingPage', attribute: 'unlayerLandingPageId', id: UNLAYER_ID },
    ]);
  });

  it('falls back to config for convrrtLandingPageId when there is no lifted reference', () => {
    const node = makeNode({
      style: 'convrrtLandingPage',
      config: { convrrtLandingPageId: CONVRRT_ID },
    });
    expect(contentRefsOf([node]).map((r) => r.key)).toEqual([
      { kind: 'landingPage', attribute: 'convrrtLandingPageId', id: CONVRRT_ID },
    ]);
  });

  it('strips the Java Long suffix from a config fallback value', () => {
    const node = makeNode({
      style: 'convrrtLandingPage',
      config: { convrrtLandingPageId: '2048L' },
    });
    expect(contentRefsOf([node]).map((r) => r.key.id)).toEqual(['2048']);
  });

  it.each(['../x', 'a/b', '', '-leading', 'x'.repeat(65)])(
    'ignores the unsafe id %s',
    (id) => {
      const node = makeNode({
        references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
      });
      expect(contentRefsOf([node])).toEqual([]);
    },
  );

  it('skips ids that consist only of zeros (0 means nothing selected)', () => {
    const node0 = makeNode({
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '0' },
    });
    expect(contentRefsOf([node0])).toEqual([]);
  });

  it('skips 0L (Keap uses 0 / 0L for "none")', () => {
    const node = makeNode({
      style: 'convrrtLandingPage',
      config: { convrrtLandingPageId: '0L' },
    });
    expect(contentRefsOf([node])).toEqual([]);
  });

  it('still collects valid numeric ids like 10', () => {
    const node = makeNode({
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '10' },
    });
    const refs = contentRefsOf([node]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.key).toEqual({ kind: 'email', attribute: 'marketingEmailId', id: '10' });
  });
});

describe('campaignRefs', () => {
  it('marks draft-only, published-only and shared steps', () => {
    const refs = campaignRefs(
      '987',
      [email('7', '1'), email('8', '2')],
      [email('7', '1'), email('9', '3')],
    );
    expect(refs.map((r) => [r.use.cellId, r.use.version])).toEqual([
      ['7', 'both'],
      ['8', 'draft'],
      ['9', 'published'],
    ]);
    expect(refs[0]?.use).toMatchObject({ funnelId: '987', style: 'email', name: 'Email 1' });
  });
});

describe('buildQueue', () => {
  it('fetches shared content once and remembers every use', () => {
    const queue = buildQueue([
      ...campaignRefs('1', [email('7', '2048')], []),
      ...campaignRefs('2', [email('4', '2048')], []),
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.usedBy.map((u) => u.funnelId)).toEqual(['1', '2']);
  });

  it('orders by kind, then attribute, then numeric id', () => {
    const sms = makeNode({
      cellId: '3',
      style: 'sms',
      references: { tagIds: [], tagCategoryIds: [], marketingAutomatedSmsId: '5' },
    });
    const queue = buildQueue(campaignRefs('1', [sms, email('1', '100'), email('2', '9')], []));
    expect(queue.map((i) => itemKey(i))).toEqual([
      'email:marketingEmailId:9',
      'email:marketingEmailId:100',
      'sms:marketingAutomatedSmsId:5',
    ]);
  });

  it('orders two UUID ids and one numeric id of the same kind/attribute deterministically', () => {
    const uuidA = 'b2b4dd0d-3a9a-4442-8b04-dd5388c060c2';
    const uuidB = 'f2b4dd0d-3a9a-4442-8b04-dd5388c060c2';
    const page = (cellId: string, id: string) =>
      makeNode({
        cellId,
        style: 'unlayerLandingPage',
        references: { tagIds: [], tagCategoryIds: [], unlayerLandingPageId: id },
      });
    const queue = buildQueue(
      campaignRefs('1', [page('1', uuidB), page('2', uuidA), page('3', '5')], []),
    );
    expect(queue.map((i) => i.id)).toEqual(['5', uuidA, uuidB]);
  });
});
