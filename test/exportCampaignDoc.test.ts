import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src/content/redact.js';
import type { ContentItemKey } from '../src/content/types.js';
import { buildCampaignDoc, draftNodesOf } from '../src/export/campaignDoc.js';
import { htmlToText } from '../src/export/htmlText.js';
import { findMergeFields } from '../src/export/mergeFields.js';
import {
  attachmentFileName,
  campaignFolderName,
  contentRef,
  slugify,
} from '../src/export/paths.js';
import { makeCampaign, makeNode, makeSequence } from './fixtures/graphFixtures.js';

describe('findMergeFields', () => {
  it('finds unique merge fields across texts, sorted', () => {
    expect(
      findMergeFields('Hi ~Contact.FirstName~, from ~Owner.Name~', null, 'Bye ~Contact.FirstName~'),
    ).toEqual(['~Contact.FirstName~', '~Owner.Name~']);
  });

  it('ignores stray tildes', () => {
    expect(findMergeFields('~ not a field ~ and ~br~')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('keeps paragraphs and line breaks and drops styles', () => {
    expect(
      htmlToText('<style>p{}</style><p>Hi&nbsp;there,</p><p>Line one<br>Line two</p><ul><li>A</li></ul>'),
    ).toBe('Hi there,\nLine one\nLine two\n- A');
  });
});

describe('paths', () => {
  it('slugs names to at most 60 characters', () => {
    expect(slugify('Trip Completed — Follow-Up (2024)!')).toBe('trip-completed-follow-up-2024');
    expect(slugify('x'.repeat(80))).toHaveLength(60);
    expect(slugify(null)).toBe('untitled');
    expect(campaignFolderName('987', 'Welcome')).toBe('987-welcome');
  });

  it('points single-file kinds at a json file and the rest at a folder', () => {
    expect(contentRef({ kind: 'email', attribute: 'marketingEmailId', id: '2048' })).toBe('emails/2048');
    expect(contentRef({ kind: 'sms', attribute: 'marketingAutomatedSmsId', id: '5' })).toBe('sms/5.json');
    expect(contentRef({ kind: 'form', attribute: 'internalFormId', id: '3' })).toBe(
      'forms/internalFormId-3',
    );
  });

  it('makes attachment names safe and unique', () => {
    const used = new Set<string>();
    expect(attachmentFileName('Price List.pdf', used)).toBe('Price_List.pdf');
    expect(attachmentFileName('Price List.pdf', used)).toBe('2-Price_List.pdf');
    expect(attachmentFileName('../../etc/passwd', used)).toBe('etc_passwd');
    expect(attachmentFileName('', used)).toBe('attachment');
  });
});

describe('buildCampaignDoc', () => {
  const task = makeNode({
    cellId: '19',
    style: 'task',
    parent: '5',
    name: 'Not Satisfied Follow-Up',
    config: {
      initialized: '1',
      name: 'Not Satisfied Follow-Up',
      taskTitle: 'Call ~Contact.FirstName~',
      taskBody: 'Reach out to ~Contact.Email~',
      taskType: 'Call',
      taskPriority: '2',
      taskAssignToOwner: '1',
      taskAssignToBackup: '0L',
      taskDaysTillDue: '0',
      taskDueAt: '17:00',
    },
  });
  const emailStep = makeNode({
    cellId: '7',
    style: 'email',
    parent: '5',
    name: 'Welcome',
    config: { marketingEmailId: '2048L', ready: '1' },
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '2048' },
  });
  const campaign = makeCampaign({
    funnelId: '584',
    name: 'Satisfaction Survey',
    published: true,
    sequences: [
      makeSequence({
        cellId: '5',
        name: 'Follow up',
        steps: [
          { ...emailStep, position: 0 },
          { ...task, position: 1 },
        ],
      }),
    ],
    notes: [makeNode({ cellId: '78', style: 'notes', config: { notes: 'Owner: <b>Sam</b>' } })],
  });

  const doc = buildCampaignDoc({
    funnelId: '584',
    normalized: campaign,
    summary: {
      funnelId: '584',
      name: 'Satisfaction Survey',
      categories: ['Clients'],
      activeContacts: 3,
      publishedDate: null,
      publishedBy: null,
      published: true,
    },
    publishNodes: [emailStep, makeNode({ cellId: '44', style: 'email', parent: '5', name: 'Old' })],
    resolve: (key) =>
      key.id === '2048'
        ? { kind: key.kind, id: key.id, ref: 'emails/2048' }
        : { kind: key.kind, id: key.id, status: 'notFound' },
  });

  it('carries identity and status', () => {
    expect(doc).toMatchObject({
      formatVersion: 1,
      funnelId: '584',
      name: 'Satisfaction Survey',
      categories: ['Clients'],
      status: { liveNow: true, everPublished: true, hasUnpublishedChanges: false },
    });
  });

  it('orders steps and points content steps into the campaign folder', () => {
    const steps = doc.sequences[0]?.steps ?? [];
    expect(steps.map((s) => [s.position, s.type, s.version])).toEqual([
      [0, 'email', 'both'],
      [1, 'task', 'draft'],
    ]);
    expect(steps[0]?.content).toEqual([
      { kind: 'email', id: '2048', ref: 'emails/2048', version: 'both' },
    ]);
    expect(steps[0]?.settings).toEqual({ marketingEmailId: '2048L' });
  });

  it('writes tasks out in full', () => {
    expect(doc.sequences[0]?.steps[1]?.task).toEqual({
      title: 'Call ~Contact.FirstName~',
      body: 'Reach out to ~Contact.Email~',
      type: 'Call',
      priority: '2',
      daysTillDue: '0',
      dueAt: '17:00',
      assignToOwner: true,
      assignToUserId: null,
      assignToBackup: null,
      notifyOwner: null,
      reminder: null,
    });
  });

  it('keeps published-only steps and canvas notes', () => {
    expect(doc.publishedOnly.map((s) => [s.cellId, s.version])).toEqual([['44', 'published']]);
    expect(doc.canvasNotes).toEqual([{ cellId: '78', text: 'Owner: Sam' }]);
  });

  it('lists the merge fields its own text uses', () => {
    expect(doc.mergeFields).toEqual(['~Contact.Email~', '~Contact.FirstName~']);
  });

  it('exposes every draft node for reference collection', () => {
    expect(draftNodesOf(campaign).map((n) => n.cellId)).toEqual(['5', '7', '19', '78']);
  });
});

describe('buildCampaignDoc across draft and published', () => {
  const email = (cellId: string, id: string) =>
    makeNode({
      cellId,
      style: 'email',
      parent: '5',
      config: { marketingEmailId: `${id}L` },
      references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
    });
  const applyNote = (cellId: string, noteId: string) =>
    makeNode({
      cellId,
      style: 'note',
      parent: '5',
      name: 'Apply note',
      config: { marketingNoteId: `${noteId}L` },
      references: { tagIds: [], tagCategoryIds: [], marketingNoteId: noteId },
    });
  const resolve = (key: ContentItemKey) => ({ kind: key.kind, id: key.id, ref: `${key.kind}/${key.id}` });

  const draftNote = applyNote('12', '300');
  const campaign = makeCampaign({
    funnelId: '11085',
    published: true,
    hasUnpublishedChanges: true,
    sequences: [
      makeSequence({
        cellId: '5',
        steps: [
          { ...email('8', '1'), position: 0 },
          { ...email('9', '7'), position: 1 },
          { ...draftNote, position: 2 },
        ],
      }),
    ],
    // Normalize files Apply Note steps under notes as well as their sequence.
    notes: [makeNode({ cellId: '78', style: 'notes', config: { notes: 'Canvas text' } }), draftNote],
  });
  const doc = buildCampaignDoc({
    funnelId: '11085',
    normalized: campaign,
    summary: null,
    publishNodes: [
      email('8', '2'),
      email('9', '7'),
      draftNote,
      applyNote('40', '301'),
      makeNode({ cellId: '79', style: 'notes', config: { notes: 'Old canvas text' } }),
    ],
    resolve,
  });
  const steps = doc.sequences[0]?.steps ?? [];

  it('shows content a cell publishes that its draft no longer points at', () => {
    expect(steps[0]?.content).toEqual([
      { kind: 'email', id: '1', ref: 'email/1', version: 'draft' },
      { kind: 'email', id: '2', ref: 'email/2', version: 'published' },
    ]);
  });

  it('tags content unchanged between versions as both', () => {
    expect(steps[1]?.content).toEqual([{ kind: 'email', id: '7', ref: 'email/7', version: 'both' }]);
  });

  it('keeps Apply Note steps out of the canvas notes', () => {
    expect(doc.canvasNotes).toEqual([{ cellId: '78', text: 'Canvas text' }]);
  });

  it('keeps a published-only Apply Note step, but not a published-only canvas note', () => {
    expect(doc.publishedOnly.map((s) => [s.cellId, s.type, s.content])).toEqual([
      ['40', 'note', [{ kind: 'note', id: '301', ref: 'note/301', version: 'published' }]],
    ]);
  });

  it('lists an Apply Note step once for reference collection', () => {
    expect(draftNodesOf(campaign).map((n) => n.cellId)).toEqual(['5', '8', '9', '12', '78']);
  });
});

describe('buildCampaignDoc settings', () => {
  it('redacts settings whose names look like credentials', () => {
    const goal = makeNode({
      cellId: '3',
      style: 'http',
      config: { apiKey: 'live-123', postUrl: 'https://hooks.example.com/x', ready: '1' },
    });
    const doc = buildCampaignDoc({
      funnelId: '1',
      normalized: makeCampaign({ goals: [goal] }),
      summary: null,
      publishNodes: [],
      resolve: (key) => ({ kind: key.kind, id: key.id, status: 'notFetched' }),
    });
    expect(doc.goals[0]?.settings).toEqual({
      apiKey: REDACTED,
      postUrl: 'https://hooks.example.com/x',
    });
  });
});
