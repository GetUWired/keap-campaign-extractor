import type { BrokenRefsReport } from '../analyze/brokenRefs.js';
import { STYLES, embedJson, escapeHtml } from './pageShell.js';

/**
 * Broken references as one navigable page.
 *
 * Same shape as the tag impact page and deliberately so — an operator who has
 * read one can read this. What differs is the claim: this is not what a change
 * would break, it is what is broken now.
 */

const EXTRA_STYLES = `
.sev { font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; margin-left: 6px; white-space: nowrap; }
.sev.ready { color: var(--live); background: var(--live-bg); }
.sev.never-built { color: var(--never); background: var(--never-bg); }
.pill.noway { color: var(--live); background: var(--live-bg); }
.consequence { color: var(--muted); }
`;

const SCRIPT = String.raw`
const DATA = JSON.parse(document.getElementById('report-data').textContent);
const STATUS_LABEL = {
  live: 'Live',
  stopped: 'Stopped',
  'never-published': 'Never published',
  unknown: 'Status unknown',
};
const KIND_LABEL = {
  trigger: 'Triggers',
  decision: 'Decisions',
  step: 'Sequence steps',
  other: 'Other references',
};
const CONSEQUENCE = {
  trigger: 'nothing can enrol through this goal',
  decision: 'this branch tests something that no longer exists',
  step: 'this step acts on something that no longer exists',
  other: 'this node points at something that no longer exists',
};

const state = {
  view: 'campaigns',
  q: '',
  statuses: new Set(['live', 'stopped', 'never-published', 'unknown']),
  kinds: new Set(['trigger', 'decision', 'step', 'other']),
  severities: new Set(['ready', 'never-built']),
  onlyDead: false,
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

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

/** Severity lives on the entity, so a location borrows its entity's. */
const SEVERITY = new Map(DATA.references.map((r) => [r.entityId, r.severity]));
const NAMES = new Map(DATA.references.map((r) => [r.entityId, r.name]));
/** The location carries its own entity; a place can reference several. */
const entityIdOf = (loc) => loc.entityId;

function locationMatches(loc, q) {
  if (!state.kinds.has(loc.kind)) return false;
  const entityId = entityIdOf(loc);
  const severity = SEVERITY.get(entityId) ?? 'ready';
  if (!state.severities.has(severity)) return false;
  if (!q) return true;
  const name = NAMES.get(entityId) ?? '';
  return (
    (entityId ?? '').toLowerCase().includes(q) ||
    name.toLowerCase().includes(q) ||
    (loc.sequenceName ?? '').toLowerCase().includes(q) ||
    (loc.nodeName ?? '').toLowerCase().includes(q)
  );
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const rows = [];
  for (const campaign of DATA.campaigns) {
    if (!state.statuses.has(campaign.status)) continue;
    if (state.onlyDead && !campaign.allEntryPointsBroken) continue;
    const nameHit =
      !!q &&
      ((campaign.campaignName ?? '').toLowerCase().includes(q) || campaign.campaignId.includes(q));
    const locations = campaign.locations.filter(
      (loc) => locationMatches(loc, nameHit ? '' : q),
    );
    if (locations.length === 0) continue;
    rows.push({ campaign, locations });
  }
  return rows;
}

function describe(loc) {
  const line = el('span');
  const entityId = entityIdOf(loc);
  const name = NAMES.get(entityId);
  if (loc.kind === 'trigger') {
    line.append('Goal ', el('span', 'where', quoted(loc.nodeName) || 'cell ' + loc.cellId), ' — ');
  } else if (loc.kind === 'decision') {
    const which = loc.nodeName
      ? quoted(loc.nodeName)
      : loc.after
        ? 'the decision after ' + quoted(loc.after) + ' (cell ' + loc.cellId + ')'
        : 'cell ' + loc.cellId;
    line.append(el('span', 'where', which), ' — ');
  } else if (loc.kind === 'step') {
    const where =
      (loc.sequenceName ? quoted(loc.sequenceName) : 'an unnamed sequence') +
      (loc.stepPosition ? ' step ' + loc.stepPosition : '');
    line.append(el('span', 'where', where), ' (' + loc.edgeKind + ') — ');
  } else {
    line.append(el('span', 'where', loc.edgeKind + ' at cell ' + loc.cellId), ' — ');
  }
  line.append(el('span', 'consequence', CONSEQUENCE[loc.kind] ?? CONSEQUENCE.other));
  line.append(' ');
  line.append(el('span', 'tagid', entityId ?? ''));
  if (name) {
    line.append(' ');
    const named = withMatch(name, state.q.trim().toLowerCase());
    named.className = 'tag';
    line.append(named);
  }
  const severity = SEVERITY.get(entityId);
  if (severity) line.append(el('span', 'sev ' + severity, severity === 'ready' ? 'ready' : 'never built'));
  return line;
}

const quoted = (text) => (text ? '“' + text + '”' : '');

function campaignCard(row) {
  const { campaign, locations } = row;
  const details = el('details', 'campaign');
  const summary = el('summary');
  const name = withMatch(
    campaign.campaignName ?? 'Campaign ' + campaign.campaignId,
    state.q.trim().toLowerCase(),
  );
  name.className = 'cname';
  summary.append(name, el('span', 'cid', '#' + campaign.campaignId));
  summary.append(el('span', 'pill ' + campaign.status, STATUS_LABEL[campaign.status] ?? campaign.status));
  if (campaign.allEntryPointsBroken) summary.append(el('span', 'pill noway', 'no working way in'));
  const bits = [];
  if (campaign.activeContacts !== null) bits.push(campaign.activeContacts.toLocaleString() + ' active');
  bits.push(locations.length + ' broken');
  summary.append(el('span', 'meta', bits.join(' · ')));
  details.append(summary);

  let built = false;
  details.addEventListener('toggle', () => {
    if (!details.open || built) return;
    built = true;
    const body = el('div', 'body');
    for (const kind of ['trigger', 'decision', 'step', 'other']) {
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

function render() {
  const campaignsView = document.getElementById('campaigns');
  const entitiesView = document.getElementById('entities');
  const countLine = document.getElementById('count');
  campaignsView.classList.toggle('hidden', state.view !== 'campaigns');
  entitiesView.classList.toggle('hidden', state.view !== 'entities');
  for (const group of document.querySelectorAll('.group')) {
    const campaignScoped = group.querySelector('[data-status], [data-dead]') !== null;
    group.classList.toggle('hidden', campaignScoped && state.view === 'entities');
  }

  if (state.view === 'campaigns') {
    const rows = filtered();
    campaignsView.replaceChildren();
    const locations = rows.reduce((n, r) => n + r.locations.length, 0);
    const dead = rows.filter((r) => r.campaign.allEntryPointsBroken).length;
    countLine.replaceChildren();
    countLine.append(
      'Showing ',
      el('b', null, String(rows.length)),
      ' of ' + DATA.campaigns.length + ' campaigns · ' + locations + ' broken references · ',
      el('b', null, String(dead)),
      ' with no way in',
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

  const q = state.q.trim().toLowerCase();
  const rows = DATA.references.filter((r) => {
    if (!state.severities.has(r.severity)) return false;
    if (!q) return true;
    return r.entityId.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q);
  });
  const body = entitiesView.querySelector('tbody');
  body.replaceChildren();
  countLine.replaceChildren();
  countLine.append('Showing ', el('b', null, String(rows.length)), ' missing entities');
  for (const reference of rows) {
    const tr = el('tr');
    const idCell = el('td');
    idCell.append(el('span', 'tagid', reference.entityId));
    tr.append(idCell);
    const nameCell = el('td');
    if (reference.name) nameCell.append(withMatch(reference.name, q));
    else nameCell.append(el('span', 'where', 'name not recorded'));
    tr.append(nameCell);
    tr.append(el('td', null, reference.kind));
    const sev = el('td');
    sev.append(el('span', 'sev ' + reference.severity, reference.severity === 'ready' ? 'ready' : 'never built'));
    tr.append(sev);
    tr.append(el('td', 'num', String(reference.locations.length)));
    tr.append(el('td', 'num', String(new Set(reference.locations.map((l) => l.campaignId)).size)));
    const find = el('td');
    const link = el('span', 'linky', 'show campaigns');
    link.addEventListener('click', () => {
      document.getElementById('q').value = reference.entityId;
      state.q = reference.entityId;
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
    if (chip.dataset.dead !== undefined) {
      state.onlyDead = !state.onlyDead;
      chip.setAttribute('aria-pressed', String(state.onlyDead));
      render();
      return;
    }
    const set = chip.dataset.status
      ? state.statuses
      : chip.dataset.kind
        ? state.kinds
        : state.severities;
    const key = chip.dataset.status ?? chip.dataset.kind ?? chip.dataset.severity;
    if (set.has(key)) set.delete(key);
    else set.add(key);
    chip.setAttribute('aria-pressed', String(set.has(key)));
    render();
  });
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && event.target.tagName !== 'INPUT') {
    event.preventDefault();
    document.getElementById('q').focus();
  }
});

render();
`;

export function renderBrokenRefsHtml(report: BrokenRefsReport): string {
  const { counts } = report;
  const dead = report.campaigns.filter((c) => c.allEntryPointsBroken);
  const deadLive = dead.filter((c) => c.status === 'live').length;

  const stat = (n: number | string, k: string, cls = '') =>
    `<div class="card ${cls}"><div class="n">${escapeHtml(String(n))}</div><div class="k">${escapeHtml(k)}</div></div>`;
  const chip = (label: string, attr: string, value: string, pressed = true) =>
    `<button class="chip" ${attr}="${value}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;

  if (!report.catalogPresent) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Broken References — ${escapeHtml(report.appName)}</title>
<style>${STYLES}</style></head>
<body><div class="wrap"><header class="top">
  <h1>Broken references — ${escapeHtml(report.appName)}</h1>
  <div class="caveat strong-caveat">
    <strong>Nothing could be checked.</strong> The graph holds no comparison against the account's
    entity catalog, so no reference can be reported as missing — which is not the same as finding
    nothing broken. Run <code>npm run enrich</code> and then <code>npm run normalize</code>.
  </div>
</header></div></body></html>
`;
  }

  const payload = {
    appName: report.appName,
    references: report.references,
    campaigns: report.campaigns,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Broken References — ${escapeHtml(report.appName)}</title>
<style>${STYLES}${EXTRA_STYLES}</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <h1>Broken references — ${escapeHtml(report.appName)}</h1>
  <div class="sub">generated ${escapeHtml(report.analyzedAt)}</div>
  <div class="caveat">
    <strong>These are references campaigns still hold to entities the account no longer has.</strong>
    Nothing here is a planned change — it is what is already in place. The comparison is against the
    entity catalog as it was last fetched, so anything created since will look missing until
    <code>enrich</code> runs again.
  </div>
  <div class="cards">
    ${stat(counts.references, 'missing entities')}
    ${stat(counts.locations, 'broken locations')}
    ${stat(counts.campaigns, 'campaigns affected')}
    ${stat(counts.liveCampaigns, 'of them live', 'live')}
    ${stat(dead.length, 'with no working way in', 'live')}
    ${stat(deadLive, 'of those, live', 'live')}
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-view="campaigns" aria-selected="true">By campaign</button>
    <button class="tab" role="tab" data-view="entities" aria-selected="false">Missing entities (${counts.references})</button>
  </div>
</header>

<div class="toolbar">
  <input id="q" type="search" placeholder="Search campaign, entity id, sequence or name …  (press /)" autocomplete="off">
  <div class="filters">
    <div class="group" role="group" aria-label="Campaign status">
      <span class="glabel">Campaign status</span>
      <div class="chips">
        ${chip('Live', 'data-status', 'live')}
        ${chip('Stopped', 'data-status', 'stopped')}
        ${chip('Never published', 'data-status', 'never-published')}
        ${chip('Unknown', 'data-status', 'unknown')}
      </div>
    </div>
    <div class="group" role="group" aria-label="Where the reference sits">
      <span class="glabel">Reference sits in</span>
      <div class="chips">
        ${chip('Trigger', 'data-kind', 'trigger')}
        ${chip('Decision', 'data-kind', 'decision')}
        ${chip('Sequence step', 'data-kind', 'step')}
        ${chip('Other', 'data-kind', 'other')}
      </div>
    </div>
    <div class="group" role="group" aria-label="Severity">
      <span class="glabel">Was it finished</span>
      <div class="chips">
        ${chip('Ready step', 'data-severity', 'ready')}
        ${chip('Never built', 'data-severity', 'never-built')}
      </div>
    </div>
    <div class="group" role="group" aria-label="Entry points">
      <span class="glabel">Entry points</span>
      <div class="chips">${chip('Only campaigns with no way in', 'data-dead', 'yes', false)}</div>
    </div>
  </div>
</div>

<div class="count" id="count"></div>
<div id="campaigns"></div>
<div id="entities" class="hidden">
  <table>
    <thead><tr>
      <th>Entity</th><th>Name</th><th>Kind</th><th>Finished</th>
      <th class="num">Locations</th><th class="num">Campaigns</th><th></th>
    </tr></thead>
    <tbody></tbody>
  </table>
</div>

<footer>
  A reference is counted as broken when a campaign points at an id absent from the account's entity
  catalog. "Never built" means only steps nobody marked ready reference it — unfinished drafting
  rather than breakage. This page reports what campaigns hold; it does not change anything.
</footer>
</div>
<script id="report-data" type="application/json">${embedJson(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
