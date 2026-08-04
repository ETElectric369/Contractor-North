-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0180: being SET UP is not the same as being SHOWN
--
-- Erik, correcting me twice in a row and both times on the same point:
--
--   "His onboarding isn't complete if he hasn't been guided through the training and why lines"
--   "everyone should go through it even if they have a lot of it setup to learn the system"
--
-- I had "done" as a DERIVED fact: trade filled, town filled, rate filled → nothing left to ask →
-- the interview disappears. Andrew filled Vivian Builders' settings in and the interview decided
-- he was finished. He had never seen a why line. He had never been shown where the questions his
-- own inspector asks live, or that he can change them.
--
-- A populated settings row is evidence that somebody typed, not evidence that anybody LEARNED.
-- So completion stops being derived and becomes a fact somebody records by reaching the end.
--
-- PER PERSON, NOT PER ORG, and that is the whole reason it is a profiles column. The company
-- facts (trade, town, rate) are shared and belong on the org. Being walked through the system is
-- something that happens to a HUMAN: Erik has had ET Electric configured for two months and still
-- needs to take the tour, an office manager joining a set-up company needs it on day one, and
-- Andrew running Justin's org needs it even though the boxes are full.
--
-- NOT A GATE, ever. Null just means the door in the top bar keeps a badge on it. Nothing is
-- blocked, nothing is nagged more than once a screen, and it can be re-taken any time — which is
-- the point of it living in the top bar rather than on a page you finish and lose.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists onboarded_at timestamptz;

comment on column public.profiles.onboarded_at is
  'When THIS PERSON reached the end of the guided walk-through — not when their org''s settings got filled in. Null = the top-bar interview still wears a badge. Never a gate. 0180.';
