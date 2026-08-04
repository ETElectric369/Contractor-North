-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0183: how Nort talks, per person
--
-- Erik, after saying "Hello. That works. What's next?" into the tour and getting back
-- "I couldn't turn that into an answer for this one":
--
--   "it was an attempt at humor, which leads me to the question is there a humor setting we can
--    put at like 55% and a swear word allowance we can match the user (good industry form and
--    mental health)"
--
-- Both halves are real, and the second one more than the first. A crew talks like a crew. An
-- assistant that stays prim while somebody swears at a seized breaker is not neutral — it is a
-- stranger in the room, and people stop talking to strangers. That is a PRODUCT problem here, not
-- a matter of taste: this whole build rests on a man being willing to say a whole job out loud to
-- it. He will not do that with something that sounds like a call centre.
--
-- PER PERSON, NOT PER ORG, and that is the whole reason these are profile columns. Register is
-- personal. Erik in a truck and Alexa at a desk want different things out of the same company, and
-- making either of them live with the other's setting is how you lose one of them.
--
-- WHAT THE DIAL CAN NEVER DO — enforced in lib/nort/tone.ts and asserted at every setting:
--   · never reach anything a customer sees (estimates, invoices, contracts, the public site)
--   · never lead — Nort matches the register he is spoken to in, and never swears first
--   · never aim at a person, theirs or anyone's
--   · never displace the answer
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists nort_humor    smallint not null default 55;
alter table public.profiles add column if not exists nort_register text     not null default 'match';

alter table public.profiles drop constraint if exists profiles_nort_humor_range;
alter table public.profiles add  constraint profiles_nort_humor_range check (nort_humor between 0 and 100);
alter table public.profiles drop constraint if exists profiles_nort_register_valid;
alter table public.profiles add  constraint profiles_nort_register_valid check (nort_register in ('match', 'clean'));

comment on column public.profiles.nort_humor is
  'How funny Nort is with THIS person, 0-100. 55 = "like somebody you''d actually work with" and is the default Erik picked. 0183.';
comment on column public.profiles.nort_register is
  '''match'' = mirror how they talk, swearing included, never first and never more than them. ''clean'' = never. Applies ONLY to Nort talking to the crew; anything a customer sees is always clean. 0183.';
