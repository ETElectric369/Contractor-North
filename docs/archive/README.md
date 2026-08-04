# Archive

Work that was written, worked, and was superseded before it shipped. Kept because the THINKING is
reusable even when the code isn't — Erik: "If any setup file could help us in the future then
archive it."

## READ THIS BEFORE TAKING ANYTHING

**"Worth stealing" means AN IDEA, for building something NEW. It never means restoring a file.**

Nothing in here is maintained. It was correct against an app that no longer exists, and every day
it drifts further. Copying a function out of here into `src/` is how a fixed bug comes back — see
the regressions law: *a regression is never just an instance, it is a mechanism.* Re-introducing
retired code IS the mechanism.

**So: read it, take the reasoning, and write fresh code against whatever the app looks like today.**

Four things keep this directory inert, and all four are verified:

1. **Nothing imports it.** Not from `src/`, not from `tests/`.
2. **The `@/*` alias cannot reach it** — it maps to `./src/*` only, so `@/lib/onboarding/setup-steps`
   no longer resolves to anything.
3. **It is never bundled.** Next builds from the import graph rooted in `src/app`; unreferenced
   files outside it are not compiled into anything that ships.
4. **Its tests never run.** Vitest's `include` is `src/**/*.test.ts` and `tests/**/*.test.ts`.

And a fifth, added when this was written: `tsconfig.json` now **excludes `docs`**. Its `include` was
`**/*.ts`, which reached in here — so a type this archive mentions changing shape would have failed
`tsc` and broken CI over deliberately dead code. That pressure is exactly what makes somebody
either delete the archive or, worse, "fix" it until it compiles — quietly turning a historical
record into a maintained file nobody is testing.

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
