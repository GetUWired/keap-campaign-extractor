import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { noteSource, parseNoteEditor } from '../src/content/sources/note.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext } from '../src/content/types.js';
import { isSessionExpired } from '../src/errors.js';

const SIGN_IN_PAGE = '<form><input id="username"><input type="password"></form><h1>Sign in</h1>';

const blankEditor = editorFixture();

function editorFixture(): string {
  const base = readFileSync('test/fixtures/content/note-editor.html', 'utf8');
  return base
    .replace('<option selected="selected">UPDATE</option>', '<option>UPDATE</option>')
    .replace('value="Purchased - Example Trip Kickoff"', 'value=""')
    .replace(
      '<textarea class="textAreaWidth" id="creationNotes">Call ~Contact.FirstName~ about the deposit &amp; flights.</textarea>',
      '<textarea class="textAreaWidth" id="creationNotes"></textarea>',
    );
}

const editor = readFileSync('test/fixtures/content/note-editor.html', 'utf8');

function ctxServing(body: string) {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html;charset=UTF-8' }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'note', attribute: 'marketingNoteId', id });

describe('parseNoteEditor', () => {
  it('reads type, title, body, notified users and assignment', () => {
    expect(parseNoteEditor(editor)).toEqual({
      kind: 'note',
      name: 'Purchased - Example Trip Kickoff',
      type: 'UPDATE',
      subject: 'Purchased - Example Trip Kickoff',
      body: 'Call ~Contact.FirstName~ about the deposit & flights.',
      notifyUsers: [
        { id: '336317', name: 'User 13' },
        { id: '504756', name: 'User 14' },
      ],
      assignTo: 'systemUserId',
    });
  });

  it('treats "Please select one" as no type', () => {
    const unselected = editor.replace('<option selected="selected">UPDATE</option>', '<option>UPDATE</option>');
    expect(parseNoteEditor(unselected)?.type).toBeNull();
  });

  it('returns null for anything that is not the note editor', () => {
    expect(parseNoteEditor('<div id="wrapper_note"></div>')).toBeNull();
    expect(parseNoteEditor('<html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('noteSource', () => {
  it('declares what it needs', () => {
    expect(noteSource).toMatchObject({
      kind: 'note',
      attributes: ['marketingNoteId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('fetches the editor and keeps it as evidence', async () => {
    const { ctx, urls } = ctxServing(editor);
    const fetched = await noteSource.fetch(key('35421'), ctx);
    expect(urls).toEqual([
      'https://se232.infusionsoft.com/app/noteFunnel/edit?marketingNoteId=35421&mayPickUser=false',
    ]);
    expect(fetched.record).toMatchObject({ kind: 'note', type: 'UPDATE' });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['editor.html']);
    expect(noteSource.validate(fetched)).toBeNull();
  });

  it('refuses an empty shell', async () => {
    const { ctx } = ctxServing('<div id="wrapper_note"></div>');
    await expect(noteSource.fetch(key('1'), ctx)).rejects.toThrow(/not the note editor/);
  });

  it('treats a sign-in page served in place of the editor as an expired session', async () => {
    const { ctx } = ctxServing(SIGN_IN_PAGE);
    const error = await noteSource.fetch(key('1'), ctx).catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });

  it('reports a blank editor — no type, no title, no body — as not found', async () => {
    expect(parseNoteEditor(blankEditor)).toMatchObject({ kind: 'note', type: null, subject: null, body: '' });
    const { ctx } = ctxServing(blankEditor);
    const error = await noteSource.fetch(key('1'), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContentNotFoundError);
    expect((error as Error).message).toBe('note template 1 is blank — deleted, or never filled in');
  });

  it('still parses the normal fixture as genuine, not blank', async () => {
    const { ctx } = ctxServing(editor);
    await expect(noteSource.fetch(key('35421'), ctx)).resolves.toMatchObject({
      record: { kind: 'note', type: 'UPDATE' },
    });
  });
});
