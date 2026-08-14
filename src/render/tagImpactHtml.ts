import type { TagImpactReport } from '../analyze/tagImpact.js';

/**
 * The tag impact report as one navigable page.
 *
 * The Markdown view is 5,800 lines and nobody reads it top to bottom. Same
 * data, same refusals — no "safe", the caveat is the first thing on the page —
 * but filterable, so the question "does deleting tag 13269 break anything live"
 * takes one search instead of a scroll.
 *
 * Self-contained by construction: the data is embedded, there are no network
 * requests, and it opens from a file:// URL on any machine.
 */

/**
 * Embeds JSON inside a <script> without letting the data close the tag.
 *
 * Campaign and tag names are client-authored text. `</script>` inside one would
 * end the block and put the rest of the account on the page as markup.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // U+2028/9 terminate a line to a JS parser but not to JSON.parse.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escapes text going into the static shell. Everything else is set as textContent. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --ink: #16191d;
  --muted: #5b6470;
  --line: #dde1e7;
  --accent: #1f6feb;
  --live: #b42318;
  --live-bg: #fef3f2;
  --stopped: #925c00;
  --stopped-bg: #fffaeb;
  --never: #545b64;
  --never-bg: #f2f4f7;
  --trigger: #b42318;
  --decision: #6941c6;
  --step: #0f766e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --panel: #1c2024;
    --ink: #e6e9ee;
    --muted: #98a2b3;
    --line: #2c3239;
    --accent: #6ea8ff;
    --live: #ff9b8f;
    --live-bg: #34211f;
    --stopped: #f2c94c;
    --stopped-bg: #302816;
    --never: #98a2b3;
    --never-bg: #23282e;
    --trigger: #ff9b8f;
    --decision: #c3a6ff;
    --step: #5eead4;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 0 20px 80px; }
header.top { padding: 28px 0 12px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 13px; }
.caveat {
  margin: 16px 0;
  padding: 12px 14px;
  border-left: 3px solid var(--accent);
  background: var(--panel);
  border-radius: 0 6px 6px 0;
  font-size: 13px;
  color: var(--muted);
}
.caveat strong { color: var(--ink); }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.card {
  flex: 1 1 150px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
}
.card .n { font-size: 22px; font-weight: 600; }
.card .k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.card.live .n { color: var(--live); }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-top: 20px; }
.tab {
  padding: 8px 14px; border: 0; background: none; color: var(--muted);
  font: inherit; font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent;
}
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.toolbar {
  position: sticky; top: 0; z-index: 5;
  background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line);
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
}
input[type="search"] {
  flex: 1 1 260px; min-width: 200px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--panel); color: var(--ink); font: inherit;
}
select { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: inherit; }
.chip {
  border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer;
}
.chip[aria-pressed="true"] { border-color: var(--accent); color: var(--ink); font-weight: 600; }
.chip.live[aria-pressed="true"] { border-color: var(--live); color: var(--live); }
.count { color: var(--muted); font-size: 13px; padding: 10px 0; }
.count b { color: var(--ink); }
details.campaign {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; margin-bottom: 8px;
}
details.campaign[open] { border-color: var(--accent); }
summary { padding: 12px 14px; cursor: pointer; list-style: none; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸"; color: var(--muted); margin-right: 4px; }
details[open] > summary::before { content: "▾"; }
.cname { font-weight: 600; }
.cid { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; }
.pill.live { color: var(--live); background: var(--live-bg); }
.pill.stopped { color: var(--stopped); background: var(--stopped-bg); }
.pill.never-published, .pill.unknown { color: var(--never); background: var(--never-bg); }
.meta { color: var(--muted); font-size: 12px; margin-left: auto; white-space: nowrap; }
.body { padding: 0 14px 14px; border-top: 1px solid var(--line); }
.warn {
  margin: 10px 0; padding: 8px 10px; font-size: 13px;
  background: var(--stopped-bg); color: var(--stopped); border-radius: 6px;
}
h3.kind { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 6px; }
h3.kind.trigger { color: var(--trigger); }
h3.kind.decision { color: var(--decision); }
h3.kind.step { color: var(--step); }
ul.locs { list-style: none; margin: 0; padding: 0; }
ul.locs li { padding: 5px 0 5px 12px; border-left: 2px solid var(--line); font-size: 14px; }
ul.locs li + li { margin-top: 2px; }
.tag { font-weight: 600; }
.tagid { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.where { color: var(--muted); }
mark { background: #ffe58a; color: #000; border-radius: 2px; padding: 0 1px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--never-bg); }
.linky { color: var(--accent); cursor: pointer; text-decoration: underline; white-space: nowrap; }
.empty { padding: 40px; text-align: center; color: var(--muted); }
.hidden { display: none !important; }
footer { color: var(--muted); font-size: 12px; padding: 30px 0; border-top: 1px solid var(--line); margin-top: 30px; }
`;

const SCRIPT = String.raw`
const DATA = JSON.parse(document.getElementById('report-data').textContent);
const KIND_LABEL = { trigger: 'Triggers', decision: 'Decisions', step: 'Sequence steps' };
const STATUS_LABEL = {
  live: 'Live',
  stopped: 'Stopped',
  'never-published': 'Never published',
  unknown: 'Status unknown',
};

const state = {
  view: 'campaigns',
  q: '',
  statuses: new Set(['live', 'stopped', 'never-published', 'unknown']),
  kinds: new Set(['trigger', 'decision', 'step']),
  sort: 'default',
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Highlights the query inside a name without ever building HTML from data. */
function withMatch(text, query) {
  const span = el('span');
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) {
    span.textContent = text;
    return span;
  }
  span.append(
    text.slice(0, at),
    el('mark', null, text.slice(at, at + query.length)),
    text.slice(at + query.length),
  );
  return span;
}

/**
 * A "tag:739" query means that tag and no other.
 *
 * Free text matches substrings, so a bare "739" also matches tag 17390 — which
 * turned one tag's 9 campaigns into 12 on the way from the tag table to the
 * campaign list. Anything arriving from a click uses the exact form.
 */
function parseQuery(raw) {
  const q = raw.trim().toLowerCase();
  if (q.startsWith('tag:')) return { exactTagId: q.slice(4).trim(), text: '' };
  return { exactTagId: null, text: q };
}

const locationMatches = (loc, query) => {
  if (query.exactTagId !== null) return loc.tagId === query.exactTagId;
  const q = query.text;
  return (
    !q ||
    loc.tagName.toLowerCase().includes(q) ||
    loc.tagId.includes(q) ||
    (loc.sequenceName ?? '').toLowerCase().includes(q) ||
    (loc.nodeName ?? '').toLowerCase().includes(q) ||
    (loc.after ?? '').toLowerCase().includes(q)
  );
};

/**
 * A campaign survives if it still has a location after filtering, or if the
 * query matched the campaign itself — searching a campaign name should show
 * all of its locations, not none.
 */
function filtered() {
  const query = parseQuery(state.q);
  const q = query.text;
  const rows = [];
  for (const campaign of DATA.campaigns) {
    if (!state.statuses.has(campaign.status)) continue;
    // A campaign name match shows all of that campaign's locations, not none.
    const nameHit =
      !!q && ((campaign.campaignName ?? '').toLowerCase().includes(q) || campaign.campaignId.includes(q));
    const locations = campaign.locations.filter(
      (loc) => state.kinds.has(loc.kind) && (nameHit || locationMatches(loc, query)),
    );
    if (locations.length === 0) continue;
    rows.push({ campaign, locations });
  }
  if (state.sort === 'locations') rows.sort((a, b) => b.locations.length - a.locations.length);
  else if (state.sort === 'contacts')
    rows.sort((a, b) => (b.campaign.activeContacts ?? -1) - (a.campaign.activeContacts ?? -1));
  else if (state.sort === 'name')
    rows.sort((a, b) => (a.campaign.campaignName ?? '').localeCompare(b.campaign.campaignName ?? ''));
  return rows;
}

function describe(loc) {
  const line = el('span');
  if (loc.kind === 'trigger') {
    line.append('Goal ', el('span', 'where', quoted(loc.nodeName) || 'cell ' + loc.cellId), ' starts the campaign when ');
  } else if (loc.kind === 'decision') {
    const which = loc.nodeName
      ? quoted(loc.nodeName)
      : loc.after
        ? 'the decision after ' + quoted(loc.after) + ' (cell ' + loc.cellId + ')'
        : 'cell ' + loc.cellId;
    line.append(el('span', 'where', which), ' routes on ');
  } else {
    const where =
      (loc.sequenceName ? quoted(loc.sequenceName) : 'an unnamed sequence') +
      (loc.stepPosition ? ' step ' + loc.stepPosition : '');
    line.append(el('span', 'where', where), loc.edgeKind === 'removes' ? ' removes ' : ' applies ');
  }
  line.append(el('span', 'tagid', loc.tagId), ' ');
  const tag = withMatch(loc.tagName, parseQuery(state.q).text);
  tag.className = 'tag';
  line.append(tag);
  if (loc.group) line.append(el('span', 'where', ' · merge group ' + loc.group));
  return line;
}

const quoted = (text) => (text ? '“' + text + '”' : '');

function campaignCard(row) {
  const { campaign, locations } = row;
  const details = el('details', 'campaign');
  details.id = 'c' + campaign.campaignId;

  const summary = el('summary');
  const name = withMatch(
    campaign.campaignName ?? 'Campaign ' + campaign.campaignId,
    parseQuery(state.q).text,
  );
  name.className = 'cname';
  summary.append(name, el('span', 'cid', '#' + campaign.campaignId));
  summary.append(el('span', 'pill ' + campaign.status, STATUS_LABEL[campaign.status] ?? campaign.status));

  const bits = [];
  if (campaign.activeContacts !== null) bits.push(campaign.activeContacts.toLocaleString() + ' active');
  if (campaign.publishedDate) bits.push(campaign.publishedDate);
  const counts = { trigger: 0, decision: 0, step: 0 };
  for (const loc of locations) counts[loc.kind]++;
  const parts = [];
  if (counts.trigger) parts.push(counts.trigger + ' trigger');
  if (counts.decision) parts.push(counts.decision + ' decision');
  if (counts.step) parts.push(counts.step + ' step');
  bits.push(parts.join(', '));
  summary.append(el('span', 'meta', bits.join(' · ')));
  details.append(summary);

  // Locations are built only when the card is opened: 229 cards of eager DOM
  // would be 1,576 rows nobody has asked to see yet.
  let built = false;
  details.addEventListener('toggle', () => {
    if (!details.open || built) return;
    built = true;
    const body = el('div', 'body');
    for (const kind of ['trigger', 'decision', 'step']) {
      const group = locations.filter((l) => l.kind === kind);
      if (group.length === 0) continue;
      body.append(el('h3', 'kind ' + kind, KIND_LABEL[kind] + ' (' + group.length + ')'));
      const ul = el('ul', 'locs');
      for (const loc of group) {
        const li = el('li');
        li.append(describe(loc));
        ul.append(li);
      }
      body.append(ul);
    }
    details.append(body);
  });
  return details;
}

/** The tag view is derived from the same locations — no second copy of the data. */
function tagRows() {
  const query = parseQuery(state.q);
  const byTag = new Map();
  for (const campaign of DATA.campaigns) {
    if (!state.statuses.has(campaign.status)) continue;
    for (const loc of campaign.locations) {
      if (!state.kinds.has(loc.kind)) continue;
      let row = byTag.get(loc.tagId);
      if (!row) {
        row = { tagId: loc.tagId, tagName: loc.tagName, group: loc.group, campaigns: new Set(), live: new Set(), kinds: { trigger: 0, decision: 0, step: 0 } };
        byTag.set(loc.tagId, row);
      }
      row.campaigns.add(loc.campaignId);
      if (campaign.status === 'live') row.live.add(loc.campaignId);
      row.kinds[loc.kind]++;
    }
  }
  return [...byTag.values()]
    .filter((row) =>
      query.exactTagId !== null
        ? row.tagId === query.exactTagId
        : !query.text || row.tagName.toLowerCase().includes(query.text) || row.tagId.includes(query.text),
    )
    .sort((a, b) => b.live.size - a.live.size || b.campaigns.size - a.campaigns.size);
}

function render() {
  const campaignsView = document.getElementById('campaigns');
  const tagsView = document.getElementById('tags');
  const countLine = document.getElementById('count');
  campaignsView.classList.toggle('hidden', state.view !== 'campaigns');
  tagsView.classList.toggle('hidden', state.view !== 'tags');
  // The sort applies to campaign cards; the tag table has its own order.
  document.getElementById('sort').classList.toggle('hidden', state.view !== 'campaigns');

  if (state.view === 'campaigns') {
    const rows = filtered();
    campaignsView.replaceChildren();
    const locations = rows.reduce((n, r) => n + r.locations.length, 0);
    const live = rows.filter((r) => r.campaign.status === 'live').length;
    countLine.replaceChildren();
    countLine.append(
      'Showing ',
      el('b', null, String(rows.length)),
      ' of ' + DATA.campaigns.length + ' campaigns (',
      el('b', null, String(live)),
      ' live) · ' + locations.toLocaleString() + ' locations',
    );
    if (rows.length === 0) {
      campaignsView.append(el('div', 'empty', 'Nothing matches those filters.'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.append(campaignCard(row));
    campaignsView.append(frag);
    return;
  }

  const rows = tagRows();
  const body = tagsView.querySelector('tbody');
  body.replaceChildren();
  countLine.replaceChildren();
  countLine.append('Showing ', el('b', null, String(rows.length)), ' referenced tags');
  const q = parseQuery(state.q).text;
  for (const row of rows) {
    const tr = el('tr');
    const idCell = el('td');
    idCell.append(el('span', 'tagid', row.tagId));
    tr.append(idCell);
    const nameCell = el('td');
    nameCell.append(withMatch(row.tagName, q));
    if (row.group) nameCell.append(el('span', 'where', ' · ' + row.group));
    tr.append(nameCell);
    tr.append(el('td', 'num', String(row.campaigns.size)));
    const liveCell = el('td', 'num', String(row.live.size));
    if (row.live.size > 0) liveCell.style.color = 'var(--live)';
    tr.append(liveCell);
    tr.append(el('td', 'num', String(row.kinds.trigger)));
    tr.append(el('td', 'num', String(row.kinds.decision)));
    tr.append(el('td', 'num', String(row.kinds.step)));
    const find = el('td');
    const link = el('span', 'linky', 'show campaigns');
    link.addEventListener('click', () => {
      const exact = 'tag:' + row.tagId;
      document.getElementById('q').value = exact;
      state.q = exact;
      setView('campaigns');
    });
    find.append(link);
    tr.append(find);
    body.append(tr);
  }
}

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  render();
}

document.getElementById('q').addEventListener('input', (event) => {
  state.q = event.target.value;
  render();
});
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    const set = chip.dataset.status ? state.statuses : state.kinds;
    const key = chip.dataset.status ?? chip.dataset.kind;
    if (set.has(key)) set.delete(key);
    else set.add(key);
    chip.setAttribute('aria-pressed', String(set.has(key)));
    render();
  });
}
document.getElementById('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && event.target.tagName !== 'INPUT') {
    event.preventDefault();
    document.getElementById('q').focus();
  }
  if (event.key === 'Escape' && event.target.id === 'q') {
    event.target.value = '';
    state.q = '';
    render();
  }
});

render();
`;

export function renderTagImpactHtml(report: TagImpactReport): string {
  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);
  const referenced = report.tags.filter((t) => t.locations.length > 0).length;
  const live = report.campaigns.filter((c) => c.status === 'live');
  const liveContacts = live.reduce((n, c) => n + (c.activeContacts ?? 0), 0);

  // The tags[] array repeats every location already on a campaign, and tripled
  // the page for nothing. The tag view is derived from the campaigns instead.
  const payload = {
    appName: report.appName,
    analyzedAt: report.analyzedAt,
    campaigns: report.campaigns,
    warnings: report.warnings,
  };

  const stat = (n: number | string, k: string, cls = '') =>
    `<div class="card ${cls}"><div class="n">${escapeHtml(String(n))}</div><div class="k">${escapeHtml(k)}</div></div>`;

  const chip = (label: string, attr: string, value: string, cls = '') =>
    `<button class="chip ${cls}" ${attr}="${value}" aria-pressed="true">${escapeHtml(label)}</button>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tag Impact — ${escapeHtml(report.appName)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <h1>Tag impact — ${escapeHtml(report.appName)}</h1>
  <div class="sub">${report.tags.length.toLocaleString()} tags analyzed · generated ${escapeHtml(report.analyzedAt)}</div>
  <div class="caveat">
    <strong>This analysis sees campaign usage only.</strong> Tags are also used in saved searches,
    broadcasts, manual application, internal forms and integrations, none of which is visible to this
    tool. A tag with no campaign references may still be in use elsewhere.
  </div>
  <div class="cards">
    ${stat(report.campaigns.length, 'campaigns affected')}
    ${stat(live.length, 'of them live', 'live')}
    ${stat(liveContacts.toLocaleString(), 'contacts in live campaigns', 'live')}
    ${stat(locations.toLocaleString(), 'affected locations')}
    ${stat(referenced.toLocaleString(), 'tags referenced')}
    ${stat(report.noCampaignReferences.length.toLocaleString(), 'no campaign references')}
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-view="campaigns" aria-selected="true">By campaign</button>
    <button class="tab" role="tab" data-view="tags" aria-selected="false">By tag</button>
  </div>
</header>

<div class="toolbar">
  <input id="q" type="search" placeholder="Search campaign, tag, sequence or id …  (press /)" autocomplete="off">
  ${chip('Live', 'data-status', 'live', 'live')}
  ${chip('Stopped', 'data-status', 'stopped')}
  ${chip('Never published', 'data-status', 'never-published')}
  ${chip('Unknown', 'data-status', 'unknown')}
  ${chip('Triggers', 'data-kind', 'trigger')}
  ${chip('Decisions', 'data-kind', 'decision')}
  ${chip('Steps', 'data-kind', 'step')}
  <select id="sort" aria-label="Sort">
    <option value="default">Live first</option>
    <option value="locations">Most locations</option>
    <option value="contacts">Most active contacts</option>
    <option value="name">Name</option>
  </select>
</div>

<div class="count" id="count"></div>
<div id="campaigns"></div>
<div id="tags" class="hidden">
  <table>
    <thead><tr>
      <th>Tag</th><th>Name</th><th class="num">Campaigns</th><th class="num">Live</th>
      <th class="num">Trig</th><th class="num">Dec</th><th class="num">Step</th><th></th>
    </tr></thead>
    <tbody></tbody>
  </table>
</div>

<footer>
  ${report.warnings.length} warning(s) recorded in tag-impact.json.
  This page reports where campaigns reference a tag. It does not recommend deletions, and it cannot
  see any use of a tag outside a campaign.
</footer>
</div>
<script id="report-data" type="application/json">${embedJson(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
