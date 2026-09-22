import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client.js';
import type { AssetFetcher, AssetResponse } from '../src/content/assets/download.js';
import { WEBFORMS_PATH, createWebformSource, defaultFetchPage, parseWebformPage } from '../src/content/sources/webform.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext, type FormField } from '../src/content/types.js';

const list = (JSON.parse(readFileSync('test/fixtures/content/webforms-list.json', 'utf8')) as {
  webforms: unknown[];
}).webforms;

const pageHtml = readFileSync('test/fixtures/content/webform-page.html', 'utf8');
const errorPageHtml = readFileSync('test/fixtures/content/webform-page-error.html', 'utf8');

/** The seven fields on the real, scrubbed FUNNEL form page, in page order. */
const realPageFields: FormField[] = [
  {
    name: 'inf_custom_2ndTravelersFIRSTNAME',
    label: "2nd Traveler's FIRST NAME",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_custom_2ndTravelersLASTNAME',
    label: "2nd Traveler's LAST NAME",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_custom_2ndTravelersEMAILADDRESS',
    label: "2nd Traveler's EMAIL ADDRESS",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_custom_2ndTravelersBIRTHDATE',
    label: "2nd Traveler's BIRTH DATE",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_custom_2ndTravelersCELLPHONENUMBER',
    label: "2nd Traveler's CELL PHONE NUMBER",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_custom_2ndTravelersSHIPPINGADDRESS',
    label: "2nd Traveler's SHIPPING ADDRESS",
    type: 'text',
    required: true,
    hidden: false,
    defaultValue: null,
  },
  {
    name: 'inf_field_Email',
    label: 'Your Email with Example Co®',
    type: 'email',
    required: true,
    hidden: false,
    defaultValue: null,
  },
];

function ctxWith(getAll: ApiClient['getAll']) {
  const api: ApiClient = {
    get: async () => {
      throw new Error('not used');
    },
    getAll,
  };
  const ctx: FetchContext = { app: 'jordan', baseUrl: 'https://jordan.infusionsoft.com', browser: null, api };
  return ctx;
}

const key = (id: string): ContentItemKey => ({ kind: 'form', attribute: 'webformId', id });

/** No test in this file may touch the network — every fetch goes through an injected stub. */
const rejectingFetchPage = async (): Promise<never> => {
  throw new Error('network not available in tests');
};

describe('parseWebformPage', () => {
  it('reads the real form fields, in page order', () => {
    expect(parseWebformPage(pageHtml)?.fields).toEqual(realPageFields);
  });

  it('returns null for a page with no form', () => {
    expect(parseWebformPage(errorPageHtml)).toBeNull();
  });

  it('reads a select as one field with its non-blank options', () => {
    const html = `<form>
      <label for="inf_field_State">State</label>
      <select id="inf_field_State" name="inf_field_State">
        <option value="">Please select</option>
        <option value="CA">California</option>
        <option value="NY">New York</option>
      </select>
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_field_State',
        label: 'State',
        type: 'select',
        required: false,
        hidden: false,
        defaultValue: null,
        options: ['CA', 'NY'],
        optionLabels: ['California', 'New York'],
      },
    ]);
  });

  it('reads select options from their text when they carry no value attribute', () => {
    const html = `<form>
      <select name="inf_field_State">
        <option>California</option>
        <option>New York</option>
      </select>
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_field_State',
        label: null,
        type: 'select',
        required: false,
        hidden: false,
        defaultValue: null,
        options: ['California', 'New York'],
        optionLabels: ['California', 'New York'],
      },
    ]);
  });

  it('groups radio inputs sharing a name into one field', () => {
    const html = `<form>
      <input type="radio" name="inf_option_Size" value="S" />
      <input type="radio" name="inf_option_Size" value="M" />
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_option_Size',
        label: null,
        type: 'radio',
        required: false,
        hidden: false,
        defaultValue: null,
        options: ['S', 'M'],
        optionLabels: ['S', 'M'],
      },
    ]);
  });

  it('takes the group label from <label for="<name>">, with its own trailing * and option labels', () => {
    const html = `<form>
      <label for="inf_option_Size">Size *</label>
      <input id="inf_option_Size_1" name="inf_option_Size" type="radio" value="101"><label for="inf_option_Size_1">Small</label>
      <input id="inf_option_Size_2" name="inf_option_Size" type="radio" value="102"><label for="inf_option_Size_2">Medium</label>
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_option_Size',
        label: 'Size',
        type: 'radio',
        required: true,
        options: ['101', '102'],
        optionLabels: ['Small', 'Medium'],
        hidden: false,
        defaultValue: null,
      },
    ]);
  });

  it('takes the group label from <label for="<name>"> for a checkbox group too', () => {
    const html = `<form>
      <label for="inf_option_Interests">Interests</label>
      <input id="inf_option_Interests_1" name="inf_option_Interests" type="checkbox" value="Beach"><label for="inf_option_Interests_1">Beach</label>
      <input id="inf_option_Interests_2" name="inf_option_Interests" type="checkbox" value="City"><label for="inf_option_Interests_2">City</label>
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_option_Interests',
        label: 'Interests',
        type: 'checkbox',
        required: false,
        options: ['Beach', 'City'],
        optionLabels: ['Beach', 'City'],
        hidden: false,
        defaultValue: null,
      },
    ]);
  });

  it('falls back to the first option label when the group has no <label for="<name>">', () => {
    const html = `<form>
      <input id="inf_option_Size_1" name="inf_option_Size" type="radio" value="101"><label for="inf_option_Size_1">Small</label>
      <input id="inf_option_Size_2" name="inf_option_Size" type="radio" value="102"><label for="inf_option_Size_2">Medium</label>
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_option_Size',
        label: 'Small',
        type: 'radio',
        required: false,
        options: ['101', '102'],
        optionLabels: ['Small', 'Medium'],
        hidden: false,
        defaultValue: null,
      },
    ]);
  });

  it('only searches for labels within the form, not the whole page', () => {
    const html = `
      <label for="inf_field_Email">Outside Email *</label>
      <form><input id="inf_field_Email" name="inf_field_Email" type="email" /></form>
    `;
    expect(parseWebformPage(html)?.fields).toEqual([
      { name: 'inf_field_Email', label: null, type: 'email', required: false, hidden: false, defaultValue: null },
    ]);
  });

  it('reads a hidden field as hidden, with its preset value and no label', () => {
    const html = `<form><input type="hidden" name="inf_field_LeadSource" value="Webinar" /></form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_field_LeadSource',
        label: null,
        type: 'hidden',
        required: false,
        hidden: true,
        defaultValue: 'Webinar',
      },
    ]);
  });

  it('reads a textarea', () => {
    const html = `<form><textarea name="inf_custom_Notes"></textarea></form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      { name: 'inf_custom_Notes', label: null, type: 'textarea', required: false, hidden: false, defaultValue: null },
    ]);
  });

  it('reads a checkbox', () => {
    const html = `<form><input type="checkbox" name="inf_option_Consent" value="yes" /></form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      { name: 'inf_option_Consent', label: null, type: 'checkbox', required: false, hidden: false, defaultValue: null },
    ]);
  });

  it('groups checkboxes sharing a name into one field, like radios', () => {
    const html = `<form>
      <input type="checkbox" name="inf_option_Interests" value="Beach" />
      <input type="checkbox" name="inf_option_Interests" value="City" />
      <input type="checkbox" name="inf_option_Interests" value="Cruise" />
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      {
        name: 'inf_option_Interests',
        label: null,
        type: 'checkbox',
        required: false,
        hidden: false,
        defaultValue: null,
        options: ['Beach', 'City', 'Cruise'],
        optionLabels: ['Beach', 'City', 'Cruise'],
      },
    ]);
  });

  it('marks a field required from a required attribute even without a trailing * label', () => {
    const html = `<form>
      <label for="inf_field_Phone">Phone</label>
      <input id="inf_field_Phone" name="inf_field_Phone" required type="text" />
    </form>`;
    expect(parseWebformPage(html)?.fields).toEqual([
      { name: 'inf_field_Phone', label: 'Phone', type: 'text', required: true, hidden: false, defaultValue: null },
    ]);
  });

  it('excludes Keap plumbing and anti-spam inputs, keeping only inf_(field|custom|option|other)_*', () => {
    const html = `<form>
      <input name="inf_form_xid" type="hidden" value="x" />
      <input name="inf_form_name" type="hidden" value="Form" />
      <input name="infusionsoft_version" type="hidden" value="1" />
      <input type="text" name="inf_qhcSMNC9AnJYJcEz" />
      <input type="text" name="inf-sbt" />
      <input id="inf_field_Email" name="inf_field_Email" type="email" />
    </form>`;
    expect(parseWebformPage(html)?.fields.map((f) => f.name)).toEqual(['inf_field_Email']);
  });
});

describe('createWebformSource', () => {
  it('declares what it needs', () => {
    expect(createWebformSource()).toMatchObject({
      kind: 'form',
      attributes: ['webformId'],
      needsApiKey: true,
      needsBrowser: false,
    });
  });

  it('fetches the public page and reads its fields', async () => {
    const requestedUrls: string[] = [];
    const source = createWebformSource({
      fetchPage: async (url) => {
        requestedUrls.push(url);
        return { status: 200, body: pageHtml, finalUrl: url };
      },
    });
    const fetched = await source.fetch(key('5'), ctxWith(async () => list));

    expect(requestedUrls).toEqual(['https://example.infusionsoft.com/app/form/933be0bce44888029d76a647dbd42673']);
    expect(fetched.record).toEqual({
      kind: 'form',
      name: 'Test Form',
      fields: realPageFields,
      fieldsAvailable: true,
      thankYou: { type: 'redirect', value: 'https://example.com/thanks' },
      publicUrl: 'https://example.infusionsoft.com/app/form/933be0bce44888029d76a647dbd42673',
      formType: 'LEGACY',
    });
    expect(fetched.files).toEqual([{ name: 'form.html', body: pageHtml }]);
    expect(fetched.assetUrls).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['webform.json', 'page.html']);
    expect(source.validate(fetched)).toBeNull();
  });

  it('records a page with no form as fields not available, without writing form.html', async () => {
    const source = createWebformSource({
      fetchPage: async (url) => ({ status: 200, body: errorPageHtml, finalUrl: url }),
    });
    const fetched = await source.fetch(key('5'), ctxWith(async () => list));

    expect(fetched.record).toMatchObject({
      fields: [],
      fieldsAvailable: false,
      pageError: 'no form on the public page',
    });
    expect(fetched.files).toEqual([]);
  });

  it('keeps the list metadata when the page fetch fails — a form page failing must not lose the form', async () => {
    const source = createWebformSource({
      fetchPage: async () => {
        throw new Error('HTTP 500');
      },
    });
    const fetched = await source.fetch(key('5'), ctxWith(async () => list));

    expect(fetched.record).toEqual({
      kind: 'form',
      name: 'Test Form',
      fields: [],
      fieldsAvailable: false,
      thankYou: { type: 'redirect', value: 'https://example.com/thanks' },
      publicUrl: 'https://example.infusionsoft.com/app/form/933be0bce44888029d76a647dbd42673',
      formType: 'LEGACY',
      pageError: 'HTTP 500',
    });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['webform.json']);
  });

  it('does not fetch a page when the form has no public URL', async () => {
    const source = createWebformSource({ fetchPage: rejectingFetchPage });
    const testEntry: unknown[] = [{ id: '77', name: 'No URL Form', exit_option: 'MESSAGE' }];
    const fetched = await source.fetch(key('77'), ctxWith(async () => testEntry));

    expect(fetched.record).toMatchObject({ fieldsAvailable: false, fields: [], pageError: 'no public URL' });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['webform.json']);
  });

  it('maps a message exit with no thank-you URL', async () => {
    const fetched = await createWebformSource({ fetchPage: rejectingFetchPage }).fetch(
      key('3'),
      ctxWith(async () => list),
    );
    expect(fetched.record).toMatchObject({ thankYou: { type: 'message', value: null } });
  });

  it('maps an AUTHORING_MESSAGE exit to message type with null value', async () => {
    const source = createWebformSource();
    const testEntry: unknown[] = [
      {
        id: '99',
        name: 'Funnel Form',
        thank_you_page_url: 'http://www.example.com',
        exit_option: 'AUTHORING_MESSAGE',
      },
    ];
    const fetched = await source.fetch(key('99'), ctxWith(async () => testEntry));
    expect(fetched.record).toMatchObject({ thankYou: { type: 'message', value: null } });
  });

  it('reads the list once per run', async () => {
    let calls = 0;
    const paths: string[] = [];
    const source = createWebformSource({ fetchPage: rejectingFetchPage });
    const ctx = ctxWith(async (path) => {
      calls++;
      paths.push(path);
      return list;
    });
    await source.fetch(key('3'), ctx);
    await source.fetch(key('5'), ctx);
    expect(calls).toBe(1);
    expect(paths).toEqual([WEBFORMS_PATH]);
  });

  it('retries the list after a failed read', async () => {
    let calls = 0;
    const source = createWebformSource({ fetchPage: rejectingFetchPage });
    const ctx = ctxWith(async () => {
      calls++;
      if (calls === 1) throw new Error('rate limited');
      return list;
    });
    await expect(source.fetch(key('3'), ctx)).rejects.toThrow(/rate limited/);
    await expect(source.fetch(key('3'), ctx)).resolves.toMatchObject({ record: { name: 'E-mail Opt-Out Form' } });
  });

  it('reports a form missing from the list as a plain failure, not confirmed deleted', async () => {
    const source = createWebformSource();
    const error: unknown = await source.fetch(key('999'), ctxWith(async () => list)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ContentNotFoundError);
    expect((error as Error).message).toBe(
      'web form 999 is not listed by /crm/rest/v2/webforms — campaign forms appear there only once ' +
        'their campaign is published with the form goal ready; otherwise it may have been deleted. ' +
        'Rebuild it by hand from Keap if it is needed.',
    );
  });
});

describe('defaultFetchPage', () => {
  function respond(body: string, overrides: Partial<AssetResponse> = {}): AssetResponse {
    const bytes = Buffer.from(body);
    return {
      status: 200,
      contentType: 'text/html',
      contentLength: bytes.length,
      location: null,
      body: async () => bytes,
      ...overrides,
    };
  }

  function redirect(location: string | null, overrides: Partial<AssetResponse> = {}): AssetResponse {
    return {
      status: 302,
      contentType: null,
      contentLength: null,
      location,
      body: async () => Buffer.alloc(0),
      ...overrides,
    };
  }

  function stub(responses: AssetResponse[]): { fetcher: AssetFetcher; urls: string[] } {
    const urls: string[] = [];
    let i = 0;
    const fetcher: AssetFetcher = async (url) => {
      urls.push(url);
      const response = responses[i] ?? responses[responses.length - 1];
      i++;
      if (!response) throw new Error('no more stubbed responses');
      return response;
    };
    return { fetcher, urls };
  }

  it('throws with a privateHost reason for a redirect to a private address', async () => {
    const { fetcher } = stub([redirect('http://127.0.0.1/x')]);
    await expect(defaultFetchPage(fetcher)('https://example.infusionsoft.com/app/form/abc')).rejects.toThrow(
      /privateHost/,
    );
  });

  it('gives up after too many redirects', async () => {
    const { fetcher } = stub([
      redirect('https://example.infusionsoft.com/1'),
      redirect('https://example.infusionsoft.com/2'),
      redirect('https://example.infusionsoft.com/3'),
      redirect('https://example.infusionsoft.com/4'),
      redirect('https://example.infusionsoft.com/5'),
      redirect('https://example.infusionsoft.com/6'),
    ]);
    await expect(defaultFetchPage(fetcher)('https://example.infusionsoft.com/0')).rejects.toThrow(
      'too many redirects',
    );
  });

  it('throws for a 3xx with no Location header', async () => {
    const { fetcher } = stub([redirect(null)]);
    await expect(defaultFetchPage(fetcher)('https://example.infusionsoft.com/app/form/abc')).rejects.toThrow(
      'HTTP 302',
    );
  });

  it('follows chained redirects to a 200 and returns the body and final URL', async () => {
    const { fetcher, urls } = stub([
      redirect('https://example.infusionsoft.com/1'),
      redirect('https://example.infusionsoft.com/2'),
      redirect('https://example.infusionsoft.com/3'),
      redirect('https://example.infusionsoft.com/4'),
      respond('<form></form>'),
    ]);
    const result = await defaultFetchPage(fetcher)('https://example.infusionsoft.com/0');
    expect(result).toEqual({
      status: 200,
      body: '<form></form>',
      finalUrl: 'https://example.infusionsoft.com/4',
    });
    expect(urls).toEqual([
      'https://example.infusionsoft.com/0',
      'https://example.infusionsoft.com/1',
      'https://example.infusionsoft.com/2',
      'https://example.infusionsoft.com/3',
      'https://example.infusionsoft.com/4',
    ]);
  });
});
