import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign } from '../src/normalize/campaign.js';

/**
 * Three live states of campaign 987, captured while a human made two deliberate
 * changes in the Keap campaign builder. See the fixture README for the diffs.
 *
 * Every other artifact in the corpus is a single snapshot of whatever state a
 * campaign happened to be in, so this is the only place publication semantics
 * can be asserted rather than inferred.
 */
const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/campaign-987-lifecycle/${name}`, import.meta.url), 'utf8');

const stage1Draft = readFileSync(
  new URL('./fixtures/campaign-987-draft.xml', import.meta.url),
  'utf8',
);
const stage2Draft = read('2-ready.draft.xml');
const stage2Publish = read('2-ready.publish.xml');
const stage3Draft = read('3-published.draft.xml');
const stage3Publish = read('3-published.publish.xml');

const sequence = (xml: string, publishXml: string, name: string) =>
  normalizeCampaign(xml, publishXml, {}, null, '987').sequences.find((s) => s.name === name);

describe('campaign 987 — marking a sequence ready', () => {
  it('is user-controlled and moves ready from absent to true', () => {
    // Absent is a distinct state from an explicit false: before the human
    // ticked the box the attribute was not present at all.
    expect(sequence(stage1Draft, stage2Publish, 'Approved for Beta')?.ready).toBeNull();
    expect(sequence(stage2Draft, stage2Publish, 'Approved for Beta')?.ready).toBe(true);
    expect(sequence(stage2Draft, stage2Publish, 'Declined for Beta')?.ready).toBe(true);
  });

  it('does not publish anything', () => {
    const before = normalizeCampaign(stage1Draft, stage2Publish, {}, null, '987');
    const after = normalizeCampaign(stage2Draft, stage2Publish, {}, null, '987');
    expect(sequence(stage2Draft, stage2Publish, 'Approved for Beta')?.published).toBe(false);
    expect(after.hasUnpublishedChanges).toBe(true);
    expect(before.hasUnpublishedChanges).toBe(true);
  });

  it('leaves the published snapshot behind the draft', () => {
    // Readiness is a different axis from publication: the draft moved, the
    // published snapshot did not, so the two still differ.
    expect(stage2Draft).not.toBe(stage2Publish);
    const campaign = normalizeCampaign(stage2Draft, stage2Publish, {}, null, '987');
    expect(campaign.published).toBe(true);
    expect(campaign.hasUnpublishedChanges).toBe(true);
  });
});

describe('campaign 987 — publishing it', () => {
  const published = normalizeCampaign(stage3Draft, stage3Publish, {}, null, '987');

  it('makes draft and publish identical, clearing hasUnpublishedChanges', () => {
    expect(stage3Draft).toBe(stage3Publish);
    expect(published.hasUnpublishedChanges).toBe(false);
    expect(published.published).toBe(true);
  });

  it('flips every sequence and goal to published', () => {
    expect(published.sequences.every((s) => s.published === true)).toBe(true);
    expect(published.goals.every((g) => g.published === true)).toBe(true);
  });

  it('drops the unconfigured task step that blocked validation', () => {
    // Keap refuses to publish a campaign containing an unconfigured step. The
    // human deleted cell 43 ("Create Task", every field empty) rather than
    // configure it, taking its inbound edge 44 with it.
    const steps = (xml: string, pub: string) =>
      normalizeCampaign(xml, pub, {}, null, '987').sequences.flatMap((s) => s.steps);
    expect(steps(stage2Draft, stage2Publish).some((s) => s.cellId === '43')).toBe(true);
    expect(steps(stage3Draft, stage3Publish).some((s) => s.cellId === '43')).toBe(false);
    expect(steps(stage2Draft, stage2Publish)).toHaveLength(11);
    expect(steps(stage3Draft, stage3Publish)).toHaveLength(10);
  });

  it('removes the transient broken flag entirely', () => {
    // `broken` is a pre-publish validation artifact, not durable state. Any
    // analysis treating it as lasting would be reading unpublished-ness.
    expect(stage2Draft).toContain('broken=');
    expect(stage3Draft).not.toContain('broken=');
  });

  it('keeps ready set through publication', () => {
    expect(sequence(stage3Draft, stage3Publish, 'Approved for Beta')?.ready).toBe(true);
  });
});
