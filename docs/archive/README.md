# Archive

Work that was written, worked, and was superseded before it shipped. Kept because the THINKING is
reusable even when the code isn't — Erik: "If any setup file could help us in the future then
archive it."

Nothing in here is compiled, imported, or tested. It is reference material. If you take something
out of here, take the reasoning and rewrite the code against whatever the app looks like now.

## setup-steps.ts / setup-steps.test.ts

The first shape of onboarding: a pure, tested checklist (`SetupStep[]`) answering "what is still
missing, and what is the single next thing to SAY out loud?" — ordered by what unblocks the most,
with the words to say rather than a field to fill. 12 passing tests when it was archived.

**Superseded by** `src/lib/onboarding/setup-playbook.ts` (cn-v632), which expresses the same idea
as a PLAYBOOK — the same `Need` shape the inspector renders — so setup and a job walk-through share
one resolver, one extraction and one component instead of two engines that drift.

**What is still worth stealing from it:**

- `SetupFacts` — the counts-not-rows idea. It stayed cheap and pure by taking `inspectionSheets:
  number` rather than the rows, which is why it could be tested at all.
- **The ordering rule**, which the playbook inherited: trade first, because one answer lights three
  dead surfaces (job codes, the walk-through's questions, what the estimator thinks it prices).
- `first_customer` as a step — the one thing the playbook version DROPPED, because it isn't an org
  setting and had nowhere to be stored. "The app has nothing to show you until there's one real job
  in it" is still true, and a first-job nudge probably belongs somewhere. That is the live idea in
  here.
- `SETUP_OPENER` — "Press Talk and tell me your name and your trade." Erik's own words, and the
  direct ancestor of the tour's first step.
