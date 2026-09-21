import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { noteSource, parseNoteEditor } from '../src/content/sources/note.js';
import type { ContentItemKey, FetchContext } from '../src/content/types.js';

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
});
