-- THE TYPED INSPECTION SHEET (determinism survey, Wave C).
--
-- The inspection page is three free-text boxes with hardcoded ELECTRICIAN placeholders
-- ("Panel is a 100A Zinsco, attic access over the garage…"). Chris walks a deck and gets asked
-- about a Zinsco panel. Worse, every downstream step is then stuck: the estimator receives three
-- prose blobs and has to re-extract from them the same numbers the inspector was standing in front
-- of. Nothing downstream can be a formula while nothing upstream is a number.
--
-- WHY THIS REUSES `forms` RATHER THAN A NEW TABLE. The typed engine already ships: `forms.schema`
-- is a jsonb array of {key,label,type,options} with text/textarea/checkbox/number/select, an
-- editor at /forms, and org RLS. Building a parallel `inspection_templates` table would duplicate
-- all of it and then drift from it. A form is simply MARKED as the inspection sheet.
--
-- WHY THE ANSWERS LIVE ON THE APPOINTMENT rather than in form_submissions. The read path that
-- matters is "start an estimate from this inspection", which already loads the appointment row.
-- Answers on that row are one fetch; a submission row is a join on the hot path. It also keeps
-- them OUT of `capture` — capture is the prose-and-photos blob, and burying typed answers inside a
-- free-text bag is how they'd stop being typed.

alter table public.forms
  add column if not exists is_inspection boolean not null default false;

comment on column public.forms.is_inspection is
  'Marks this form as an inspection question sheet, selectable on an appointment. Per-trade content lives in the rows, not in code — that is what stops a deterministic estimator from needing a new module per trade.';

alter table public.appointments
  add column if not exists inspection_template_id uuid references public.forms(id) on delete set null,
  add column if not exists inspection_answers jsonb not null default '{}'::jsonb;

comment on column public.appointments.inspection_answers is
  'Typed answers keyed by forms.schema[].key. The estimator reads these as NUMBERS instead of re-extracting them from prose. The free-text capture stays alongside — a typed sheet only captures what someone thought to ask, and the sentence nobody anticipated is often the one that saves the job.';

-- The template picker lists only inspection sheets; keep that lookup cheap.
create index if not exists forms_is_inspection_idx
  on public.forms (org_id) where is_inspection;

-- "Which inspections used this template" (template deletion impact, and future reporting).
create index if not exists appointments_inspection_template_idx
  on public.appointments (inspection_template_id) where inspection_template_id is not null;

-- NOTE ON RLS: both tables already carry org policies from 0004; adding columns does not change
-- them, and the new FK is org-local because forms and appointments are both org-scoped. A template
-- from another org cannot be selected, because the picker reads through RLS.
