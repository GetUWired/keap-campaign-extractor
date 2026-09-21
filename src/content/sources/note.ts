import { load } from 'cheerio';
import { stripLongSuffix } from '../../parse/cells.js';
import { decodeEntities } from '../../render/text.js';
import type { ContentSource, NoteContent } from '../types.js';
import { appGet } from './appGet.js';

export function notePath(id: string): string {
  return `/app/noteFunnel/edit?marketingNoteId=${encodeURIComponent(id)}&mayPickUser=false`;
}

/**
 * Keap's own template comment: values "may or may not be HTML encoded already in
 * the database". cheerio decodes the markup once; this decodes the stored layer.
 */
const clean = (value: string): string => decodeEntities(value).trim();

/** The Apply Note editor form, or null when the page is anything else. */
export function parseNoteEditor(html: string): NoteContent | null {
  const $ = load(html);
  if ($('#actionDescription').length === 0 || $('#creationNotes').length === 0) return null;

  const selectedType = $('#actionType option[selected]').first();
  const typeText = clean(selectedType.text());
  const typeValue = selectedType.attr('value');
  const type = selectedType.length === 0 || typeValue === '' || typeText === '' ? null : typeText;

  const subject = clean($('#actionDescription').attr('value') ?? '') || null;
  const body = clean($('#creationNotes').text());

  const notifyUsers = $('#notifyUsers option[selected]')
    .toArray()
    .map((option) => {
      const raw = $(option).attr('value') ?? '';
      return { id: stripLongSuffix(raw) ?? raw, name: clean($(option).text()) };
    });

  const assignTo = $('#assignmentUserId').attr('value') || null;

  return { kind: 'note', name: subject, type, subject, body, notifyUsers, assignTo };
}

export const noteSource: ContentSource = {
  kind: 'note',
  attributes: ['marketingNoteId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, notePath(key.id));
    const record = parseNoteEditor(response.body);
    if (record === null) {
      throw new Error(`${notePath(key.id)} returned something that is not the note editor`);
    }
    return { record, files: [], evidence: [{ name: 'editor.html', body: response.body }], assetUrls: [] };
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'editor.html');
    return parseNoteEditor(String(evidence?.body ?? '')) === null ? 'response is not the note editor' : null;
  },
};
