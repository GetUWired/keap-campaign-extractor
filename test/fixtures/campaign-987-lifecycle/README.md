# Campaign 987 — a publication lifecycle, captured live

Three states of the same campaign (`jordan` / funnelId 987, "WooConnection Beta Tester Application"),
captured on 2026-08-06 as a human made two deliberate changes in the Keap campaign builder between
extractions.

Nothing else in the corpus gives a known-good before/after for publication semantics. Every other
artifact is a single snapshot of whatever state a campaign happened to be in.

| Stage | File | draft | publish |
|---|---|---|---|
| 1. untouched | `../campaign-987-draft.xml` | 7,917 | *(not kept — identical to stage 2's)* |
| 2. sequences marked ready | `2-ready.draft.xml` | 7,954 | `2-ready.publish.xml` (4,900) |
| 3. published | `3-published.draft.xml` | 7,342 | `3-published.publish.xml` (7,342) |

Stage 1 lives one directory up because it predates this set and existing tests already reference it.

## What each transition proves

**Stage 1 → 2. A human ticked "ready" on the "Approved for Beta" and "Declined for Beta" sequences.**
Nothing else was touched, and the campaign was *not* published.

```diff
- <Object name="Approved for Beta" flowType="Stop" published="0" initialized="1" as="value"/>
+ <Object name="Approved for Beta" flowType="Stop" published="0" initialized="1" ready="1" broken="0" as="value"/>
```

- `ready` is **user-controlled** and independent of publication — `published="0"` is unchanged and
  `publish.xml` is byte-identical across the transition.
- Before the change the attribute was **absent entirely**, not `ready="0"`. `ready: null` therefore
  means "never marked", which is a distinct state from an explicit false. `boolOrNull` in
  `nodes.ts` preserves all three, which is why this was visible at all.
- `broken="0"` appears alongside: Keap evaluates and writes brokenness when readiness is set.

**Stage 2 → 3. The campaign was published.** To pass Keap's pre-publish validation the human had to
delete an unconfigured `task` step (cell 43, "Create Task", every field empty) and its inbound edge.

```diff
- <Object name="Approved" global="0" published="0" initialized="1" achievementType="any" ready="1" broken="0" as="value">
+ <Object name="Approved" global="0" published="1" initialized="1" achievementType="any" ready="1" as="value">
- <mxCell id="43" style="task" parent="40" vertex="1">
- <Object name="Create Task" taskType="" taskTitle="" taskBody="" taskAssignToOwner="0" … initialized="1" as="value">
- <mxCell id="44" style="edge" parent="40" source="42" target="43" edge="1">
```

- `published` flips `0` → `1` on every node that went live.
- **`broken` is removed entirely.** It is a transient pre-publish validation artifact, not a durable
  property — zero occurrences remain in stage 3. Any analysis treating it as lasting state is wrong.
- `draft.xml` and `publish.xml` become **byte-identical**, so `hasUnpublishedChanges` flips
  `true` → `false`. This is the only live validation that logic has had.
- **Keap refuses to publish a campaign containing an unconfigured step.** The realistic responses are
  to configure it or delete it; this human deleted it.

## Why that last point matters to the corpus

Every published campaign has been through that filter, so unconfigured steps survive mainly in
campaigns that were never published. "Never published" and "contains unfinished work" therefore
travel together, and references from those unfinished steps were never real entities.

That inverts the intuitive reading of the missing-entity data: the campaign is not missing entities
*because* it is unpublished — it is unpublished *because* it still contains steps nobody finished.

## Provenance

The stage-3 files are also the live state of campaign 987 in the `jordan` account as of
2026-08-06. Cell 43 was deleted in Keap and **exists nowhere else**: `npm run spike` overwrites
`artifacts/<app>/campaigns/<id>/` in place, so these fixtures are the only surviving record of it.

App build changed from `1.70.0.989251-sysarch-202608031100` (stage 1) to
`1.70.0.990820-hf-202608041714` (stages 2 and 3) — Keap shipped a hotfix between captures.
