-- 0189 — A LEAD HAS TWO ADDRESSES: where the person is, and where the work is.
--
-- Andrew (Vivian Builders, beta), via Nort on 2026-08-10: "In the embedded HTML code for the
-- playbook, I noticed that the first questions to the client are their name, email address, et
-- cetera. But I'd like to have the title of their address… replace the title of the address field
-- to say home address and not project address."
--
-- Erik, resolving it: "he wants the top box with the customer info that is fixed to say home
-- address then the project is the project" — and then, about his own org: "if the customer has an
-- address on file then i noticed there is another job address now so maybe i just need
-- clarification where is what."
--
-- ── WHY A RENAME WAS NOT THE FIX ────────────────────────────────────────────────────────────
--
-- The intake door's fixed contact block writes `inquiries.address`, and that column is THE JOB
-- SITE: leads/actions.ts stamps it onto the new job on conversion, jobs.address is what pickSite
-- renders on every document, and the job name is derived from it. Relabelling that box "Home
-- address" would have left the label saying one thing and the data meaning another — a customer
-- types where they live and it becomes the address on the estimate, silently.
--
-- A general contractor is exactly the case that breaks the one-address assumption. Andrew's leads
-- live in a house that already exists and are building on a lot that does not. For a residential
-- service call the two are usually the same, which is why nobody hit this for a year.
--
-- ── WHY `address` KEEPS ITS MEANING ─────────────────────────────────────────────────────────
--
-- The obvious shape is `address` = the person, plus new `site_*` columns. It is the wrong way
-- round: every existing row's `address` was captured as the site and is already copied onto jobs,
-- so redefining it would silently reinterpret live data. Instead `address` stays THE SITE and the
-- new columns carry the CONTACT. Every row written before today reads exactly as it did, and the
-- conversion falls back to `address` when `contact_address` is null — so nothing changes for a
-- tenant that only ever captures one.
--
-- No index: these are never filtered on, only read alongside the row they belong to.

alter table public.inquiries
  add column if not exists contact_address text,
  add column if not exists contact_unit    text,
  add column if not exists contact_city    text,
  add column if not exists contact_state   text,
  add column if not exists contact_zip     text;

comment on column public.inquiries.address is
  'THE JOB SITE — where the work happens. Copied to jobs.address on conversion and rendered on every document by pickSite. NOT the person''s address: that is contact_address (0189).';

comment on column public.inquiries.contact_address is
  'Where the PERSON is — their home or office. Fills customers.address on conversion. Null on every row written before 0189, and the conversion falls back to `address` for those, which is exactly the old behaviour.';
