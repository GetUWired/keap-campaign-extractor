/**
 * The chrome both HTML reports share: safe embedding, escaping and styles.
 *
 * Extracted when the broken-references report arrived rather than copied, so a
 * fix to the script-tag escaping cannot apply to one page and miss the other.
 */
/**
 * Embeds JSON inside a <script> without letting the data close the tag.
 *
 * Campaign and tag names are client-authored text. `</script>` inside one would
 * end the block and put the rest of the account on the page as markup.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // U+2028/9 terminate a line to a JS parser but not to JSON.parse.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escapes text going into the static shell. Everything else is set as textContent. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const STYLES = `
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
  --del: #8a4b00;
  --del-bg: #fff4e5;
  --mrg: #175cd3;
  --mrg-bg: #eff6ff;
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
    --del: #f5b26b;
    --del-bg: #33261a;
    --mrg: #8ab4ff;
    --mrg-bg: #1b2740;
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
.strong-caveat { border-left-color: var(--live); margin-top: 14px; }
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
/* The two chip sets answer different questions and were read as one row. */
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; width: 100%; }
.group {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 10px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
}
.glabel {
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted); white-space: nowrap; padding-right: 2px;
  border-right: 1px solid var(--line); margin-right: 2px; padding-right: 10px;
}
.group .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.reset {
  border: 0; background: none; color: var(--accent); font: inherit; font-size: 13px;
  cursor: pointer; text-decoration: underline; align-self: center; padding: 0 4px;
}
@media (max-width: 640px) {
  .group { width: 100%; align-items: flex-start; flex-direction: column; gap: 6px; }
  .glabel { border-right: 0; border-bottom: 1px solid var(--line); width: 100%; padding: 0 0 5px; margin: 0; }
}
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
.pill.deleting { color: var(--del); background: var(--del-bg); }
/* Its breakage is moot, so it should not compete with campaigns that matter. */
details.campaign.deleting summary .cname { opacity: .65; text-decoration: line-through; }
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
.badge {
  font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; margin-left: 6px; white-space: nowrap;
}
.badge.delete { color: var(--del); background: var(--del-bg); }
.badge.merge { color: var(--mrg); background: var(--mrg-bg); }
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

