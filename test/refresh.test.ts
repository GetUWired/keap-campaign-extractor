import { describe, expect, it } from 'vitest';
import { planSteps } from '../src/cli/refresh.js';

const base = { app: 'se232', skipExtract: false, render: false };
const names = (o: Parameters<typeof planSteps>[0]) => planSteps(o).map((s) => s.name);

describe('planSteps', () => {
  it('runs the whole pipeline in the order that works', () => {
    expect(names(base)).toEqual([
      'enumerate',
      'extract-all',
      'enrich',
      'normalize',
      'tag-impact',
      'broken-refs',
    ]);
  });

  it('always forces the extract', () => {
    // Without --force every campaign is already "done" and the step is a no-op,
    // producing a report dated today from last month's campaigns.
    const extract = planSteps(base).find((s) => s.name === 'extract-all');
    expect(extract?.args).toContain('--force');
  });

  it('enriches before normalizing', () => {
    // The graph's comparison against the account is built during normalize.
    // Reversed, every reference looks present and nothing is reported broken.
    const order = names(base);
    expect(order.indexOf('enrich')).toBeLessThan(order.indexOf('normalize'));
  });

  it('never logs in, because that needs a human', () => {
    expect(names(base)).not.toContain('login');
  });

  it('audits every tag when no list is given', () => {
    const step = planSteps(base).find((s) => s.name === 'tag-impact');
    expect(step?.args).toContain('--all-tags');
  });

  it('uses a supplied tag list instead of auditing', () => {
    const step = planSteps({ ...base, tagsPath: './tags.csv' }).find((s) => s.name === 'tag-impact');
    expect(step?.args).toEqual(['--app', 'se232', '--tags', './tags.csv']);
    expect(step?.args).not.toContain('--all-tags');
  });

  it('skips the network steps on --skip-extract', () => {
    expect(names({ ...base, skipExtract: true })).toEqual([
      'normalize',
      'tag-impact',
      'broken-refs',
    ]);
  });

  it('only renders the per-campaign pages when asked', () => {
    expect(names(base)).not.toContain('render');
    expect(names({ ...base, render: true })).toContain('render');
  });

  it('passes the app to every step', () => {
    for (const step of planSteps({ ...base, render: true })) {
      expect(step.args.slice(0, 2)).toEqual(['--app', 'se232']);
    }
  });
});
