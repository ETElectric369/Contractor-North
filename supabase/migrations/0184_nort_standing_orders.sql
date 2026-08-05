-- 0184: STANDING ORDERS — the durable home for "keep it short" (2026-08-05)
--
-- Erik: "check nort's memory there might be a problem because hes not remembering to shut the
-- fuck up."
--
-- He was right, and it was structural, not a bug: a correction said in chat ("keep it short",
-- "stop reading everything back") lived ONLY in conversation history. History recall is capped at
-- the last 6 conversations / ~3000 chars and is framed "for CONTINUITY only" — so a standing
-- instruction rolled off the end within days and Nort genuinely no longer knew it had ever been
-- told. The tone dial (0183) covers humour and swearing; it never covered "how I want you to
-- work".
--
-- One text column on the person's own row. Nort writes it through a tool when the user gives a
-- durable instruction; it is injected into every session as standing orders; and it is visible
-- and editable in Settings → You — a standing control the user can see and clear beats a hidden
-- one every time (the token-portal law: everything standing needs an off switch and a UI).
--
-- Small ON PURPOSE. 2000 chars is a page of standing orders; beyond that it is not orders any
-- more, it is a second prompt, and the right place for a growing pile of facts is the
-- conversation history that already exists.
alter table public.profiles
  add column if not exists nort_notes text
  check (nort_notes is null or char_length(nort_notes) <= 2000);
