-- 0197 — WHICH LESSONS THIS PERSON HAS BEEN OFFERED.
--
-- The onboarding split (Erik: "the onboarding is one thing but maybe it should just be onboarding
-- and something else better for training can come after"). Setup — the questions that WRITE — is
-- the tour; the teaching blocks become named LESSONS, each offered once, inline, on the surface it
-- explains. An offer is recorded whichever button is pressed ("Show me" or "No thanks"), or it
-- nags forever; replay lives behind the cap, so declining loses nothing.
--
-- Per PERSON, like onboarded_at (0180): the office manager and a tech learn different screens at
-- different times, and one person having seen a lesson says nothing about the next.

alter table public.profiles
  add column if not exists lessons_seen jsonb not null default '[]'::jsonb;

comment on column public.profiles.lessons_seen is
  'Lesson keys (text[] as jsonb) this person has been OFFERED — shown or declined both count (0197). The cap replays any; the inline offer shows only when the key is absent.';
