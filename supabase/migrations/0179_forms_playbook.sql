-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0179: a form can hold a PLAYBOOK, not just a sheet
--
-- The resolver shipped in cn-v619 and the inspector started rendering from it in cn-v628.
-- Both still read `forms.schema`, converted on the way in — which works, and which caps
-- the whole thing at what a sheet can say. A sheet cannot say:
--
--   THE QUESTION ITSELF   a sheet has a `label`. Erik's says "Panel". That is a heading,
--                         not a question, which is why he typed 2 into it and then 2
--                         again into the next box. A need has an `ask`: a sentence.
--   TWO CONDITIONS        showIf is ONE key. "Fish it, or run surface?" depends on BOTH
--                         the wall finish and the permit, so with one key it could only
--                         ever be asked too early (meaningless) or never.
--   THE NEGATIVE          "ask me the outlet count ONLY if the room wasn't measured."
--                         Erik: "i dont necessarily want it to never ask me an outlet
--                         count, thats important and if it cant be resolved from the info
--                         then its an appropriate question." Derive it, or else ask it.
--   MORE THAN ONE ANSWER  his job was outlets AND lights. A single-valued router is why
--                         the sheet then asked him panel questions about a circuits job.
--   AN OPEN QUESTION      "where's the power coming from — which panel, how far, what's
--                         open in it?" has no control that can hold it, and the answer is
--                         the fork the entire price hangs off.
--   THE WHY               his own reason, in his own words. The fuel: what Nort reads to
--                         know when a question is worth asking and what a bad answer
--                         costs, and what shows under the question so it guides instead
--                         of interrogating.
--
-- ONE COLUMN, NOT A TABLE. A playbook is read whole, written whole, and belongs to
-- exactly one form — there is no query that wants half of one. Rows would buy ordering
-- and joins nobody needs and cost a migration every time a need grows a field.
--
-- NOTHING BREAKS. `schema` stays exactly where it is and keeps working: a form with a
-- null playbook is converted from its sheet on read, which is what every form does today.
-- The column is where a playbook goes once somebody writes one — from the starter
-- library, from the onboarding interview, or by hand.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.forms add column if not exists playbook jsonb;

comment on column public.forms.playbook is
  'A playbook: {needs:[...]} — what must end up KNOWN before this work can be priced, as opposed to `schema` which is a list of questions to ask. Null means "derive it from schema", which is what every form did before 0179. See lib/playbook/types.ts.';
