import { type CheerioAPI, load } from 'cheerio';

type Q = CheerioAPI;
type Selection = ReturnType<Q>;

export interface CampaignSummary {
  funnelId: string;
  name: string;
  categories: string[];
  activeContacts: number | null;
  /** Verbatim as rendered, e.g. "11/10/2020 8:31 AM". Never parsed — see below. */
  publishedDate: string | null;
  publishedBy: string | null;
  published: boolean;
}

export interface CampaignList {
  total: number | null;
  perPage: number | null;
  reportStateId: string | null;
  campaigns: CampaignSummary[];
  warnings: string[];
}

const COLUMNS = ['Id', 'Name', 'Categories', 'Active Contacts', 'Published Date', 'Published By'];

const NBSP = ' ';

function intOrNull(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const digits = raw.replace(/[^\d-]/g, '');
  if (digits === '') return null;
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? null : value;
}

function textOrNull(cell: Selection | undefined): string | null {
  if (!cell || cell.length === 0) return null;
  const text = cell.text().split(NBSP).join(' ').trim();
  return text === '' ? null : text;
}

/**
 * The report header row — the one whose own cells carry sortable column labels.
 *
 * The match is on direct `th` children. Testing with a recursive find() picks
 * up the outer wrapper row instead, since it contains the entire data table.
 */
function headerRowOf($: Q): Selection {
  return $('tr')
    .filter((_, el) => $(el).children('th').find('span.header-sort-name').length > 0)
    .first();
}

/**
 * Builds a column-label → index map from the header row.
 *
 * The report renders each label inside span.header-sort-name. Reading cells by
 * label rather than by fixed position means an added or reordered column cannot
 * silently shift every field — the failure that made the decision parser return
 * confident, empty results.
 *
 * `children('th')` rather than `find('th')`: direct children only, so a nested
 * table can never contribute a phantom column.
 */
function headerIndex($: Q, headerRow: Selection): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.children('th').each((position, th) => {
    const label = $(th).find('span.header-sort-name').first().text().trim();
    if (label !== '') index.set(label, position);
  });
  return index;
}

export function parseCampaignList(html: string): CampaignList {
  const $ = load(html);
  const warnings: string[] = [];

  const total = intOrNull($('#numberOfRecords').first().attr('value'));
  const perPage = intOrNull($('#perPage').first().attr('value'));
  const reportStateId = $('#reportStateId').first().attr('value') ?? null;

  const headerRow = headerRowOf($);
  const columns = headerIndex($, headerRow);
  if (columns.size === 0) {
    warnings.push('no report header row found — this may not be the automations list page');
  }
  for (const expected of COLUMNS) {
    if (!columns.has(expected)) {
      warnings.push(`column "${expected}" is missing from the report header`);
    }
  }

  function cellAt(cells: Selection, label: string): Selection | undefined {
    const position = columns.get(label);
    return position === undefined ? undefined : cells.eq(position);
  }

  const campaigns: CampaignSummary[] = [];

  // Rows are scoped to the header's own table. The data table sits nested one
  // row deep inside an outer grid-table, and that wrapper row contains the
  // whole table — so a global $('tr') scan matches it too, and because find()
  // is recursive it reports every descendant cell plus the first data row's
  // link. Live, that produced a phantom 171st campaign whose every column was
  // shifted by one, with a campaign name landing in the categories tally.
  const dataTable = headerRow.closest('table');
  const rowScope = dataTable.length > 0 ? dataTable : $.root();

  rowScope.find('tr').each((_, row) => {
    const $row = $(row);
    // Belt and braces: a genuine data row never wraps another table.
    if ($row.find('table').length > 0) return;

    const link = $row.find('a[href*="funnelEditor?funnelId="]').first();
    if (link.length === 0) return;

    const funnelId = /funnelId=(\d+)/.exec(link.attr('href') ?? '')?.[1];
    if (funnelId === undefined) return;

    // Direct children only, so cell indices always line up with the header.
    const cells = $row.children('td');
    const publishedDate = textOrNull(cellAt(cells, 'Published Date'));
    const categoryText = textOrNull(cellAt(cells, 'Categories'));

    campaigns.push({
      funnelId,
      // Taken from the link rather than the cell: the cell wraps it in a span
      // with layout whitespace.
      name: link.text().trim(),
      categories:
        categoryText === null
          ? []
          : categoryText
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== ''),
      activeContacts: intOrNull(textOrNull(cellAt(cells, 'Active Contacts'))),
      publishedDate,
      publishedBy: textOrNull(cellAt(cells, 'Published By')),
      // Presence of a date is the signal, which needs no parsing. The account
      // renders dates in its own timezone and the handoff records an unresolved
      // timezone discrepancy on timer fields, so no value here is interpreted.
      published: publishedDate !== null,
    });
  });

  if (campaigns.length === 0) {
    warnings.push('no campaign rows found — no link matched funnelEditor?funnelId=');
  }

  return { total, perPage, reportStateId, campaigns, warnings };
}
