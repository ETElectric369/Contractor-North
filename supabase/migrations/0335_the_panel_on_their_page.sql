-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0335: the panel on their page (Panel tab plan, phase 5)
--
-- Erik, 2026-09-25: "instead of a .pdf it can just be there". Andrew Cohen's live portal page for
-- J-011 (13897 Herringbone) gets a "Your Panel" section: the panel's name and size, then one line per
-- circuit in space order ("7 · Entry Lights · feeds Kitchen And Living · 15A"). It is live: what the
-- office or crew keeps shows on his next page load. There is no publish step.
--
-- OFF UNTIL THE OFFICE TURNS IT ON (Erik's decision 2). job_panels.shown_on_portal (0333) is false
-- by default, and only the office can change it (0333's guard: 42501 for anyone else). This reads a
-- panel only while that flag is on, so a half-finished rough-in list never shows up by itself.
--
-- WHAT THE CUSTOMER GETS, AND NOTHING ELSE. For each shown, live panel: name, main_amps, spaces, and
-- its circuits. For each circuit: space, half, poles, amps, kind (AFCI / GFCI / ...), room, label
-- (what the door says, else what it feeds), feeds (what it feeds, only when that differs from the
-- door label), is_new. Only KEPT circuits, never one taken off (removed_at) or coming out
-- (work = 'removed'). Never a wire tag, a note, progress, a source or source row, a suggestion, a
-- panel's notes, No Stab spaces, a photo, or who changed or verified anything; job_circuits has no
-- price, part number or supplier to leak (0333 refused those columns). The self-check below refuses
-- the migration if the block names any other key. The app's normalizer
-- (src/lib/panel/directory.ts normalizePortalPanels) builds the page field by field from this, the
-- last door.
--
-- HOW: portal_job_view is rewritten FROM ITS LIVE DEFINITION by replacing exactly ONE block (the
-- 0315 / 0326 technique): the 0326 'documents' block is kept byte for byte and the new 'panels'
-- block is appended after it. Whatever else is in the function stays as it is, and the rewrite
-- refuses unless that block appears exactly once.
--
-- LIVE BODY THIS STARTS FROM: pg_get_functiondef('public.portal_job_view(text, uuid)') in
-- production, 2026-09-25 (after 0326; it carries 0301, 0315's customer_line_words, the picks and
-- 0326's photos/documents through job_share_shows). The block below was copied from that body.
--
-- SELF-CHECK: every portal job page that opens today is read before and after. The only change
-- allowed is the new 'panels' key, which must be an array (empty today: production has no panel
-- shown). Grants unchanged: service role only.
--
-- ORDER: after 0333 (job_panels / job_circuits, applied) and 0326 (applied). Independent of 0334.
-- Deploy-safe either way: the app reads `panels` only when it is there (no section until then).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. the ground this stands on ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.job_panels') is null or to_regclass('public.job_circuits') is null then
    raise exception '0335: job_panels / job_circuits (0333) are not on this database. Apply 0333 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.job_share_shows(uuid, uuid, uuid)') is null then
    raise exception '0335: portal_job_view does not read the shared papers yet (0326). Apply 0326 first. Nothing was changed.';
  end if;
end $$;

-- Every portal job page as it reads TODAY, for the self-check at the end.
create temp table _0335_before as
select a.token, jb.id as job_id, public.portal_job_view(a.token, jb.id)::jsonb as j
  from public.customer_portal_access a
  join public.jobs jb on jb.customer_id = a.customer_id and jb.org_id = a.org_id
 where a.enabled;

-- ── 1. the portal reads the panel ──────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$
    -- 0326: the plans, permits, circuit maps, drawings, renderings and scans. The newest of each
    -- chain only (job_share_shows). The office's title, never the document's name; the file the
    -- office shared, for the server to sign; never who shared it.
    'documents', coalesce((select json_agg(json_build_object(
        'id', d.id, 'kind', s.kind, 'title', s.title, 'file_path', d.file_url,
        'added_at', d.created_at, 'shown_at', s.shared_at,
        'is_update', s.replaces_document_id is not null)
        order by s.shared_at desc, d.id)
      from public.job_shared_documents s
      join public.documents d on d.id = s.document_id
     where s.job_id = j.id and s.org_id = a.org_id and s.kind <> 'photo'
       and public.job_share_shows(s.document_id, a.org_id, j.id)), '[]'::json)$old$;
  v_panels text := $new$,
    -- 0335: the panel, once the office turns it on for this job (job_panels.shown_on_portal, OFF
    -- until then; Erik's decision 2). Kept circuits only, never one taken off or coming out, and
    -- only these fields: where it sits, what the door says (else what it feeds), what it feeds
    -- when that differs, its size and type, its room, and whether it is new work. Never a wire
    -- tag, a note, progress, a source, a suggestion, or who changed or verified anything.
    'panels', coalesce((select json_agg(json_build_object(
        'name', p.name, 'main_amps', p.main_amps, 'spaces', p.spaces,
        'circuits', coalesce((select json_agg(json_build_object(
            'space', c.space, 'half', c.half, 'poles', c.poles, 'amps', c.amps, 'kind', c.kind,
            'room', nullif(btrim(c.room), ''),
            'label', coalesce(nullif(btrim(c.panel_label), ''), nullif(btrim(c.description), '')),
            'feeds', case when nullif(btrim(c.panel_label), '') is not null and nullif(btrim(c.description), '') is not null
                           and lower(regexp_replace(c.panel_label, '[^a-zA-Z0-9]+', '', 'g'))
                               <> lower(regexp_replace(c.description, '[^a-zA-Z0-9]+', '', 'g'))
                          then btrim(c.description) end,
            'is_new', c.work = 'new')
            order by c.space nulls last, c.half nulls first, c.sort_order, c.created_at, c.id)
          from public.job_circuits c
         where c.panel_id = p.id and c.job_id = j.id and c.org_id = a.org_id
           and c.state = 'kept' and c.removed_at is null and c.work <> 'removed'), '[]'::json))
        order by p.created_at, p.id)
      from public.job_panels p
     where p.job_id = j.id and p.org_id = a.org_id and p.removed_at is null and p.shown_on_portal), '[]'::json)$new$;
  v_keys text[];
  v_allowed text[] := array['panels', 'name', 'main_amps', 'spaces', 'circuits', 'space', 'half', 'poles', 'amps', 'kind', 'room', 'label', 'feeds', 'is_new'];
begin
  -- What the new block hands over, key by key: nothing outside the allow-list, ever.
  select array_agg(distinct m[1]) into v_keys from regexp_matches(v_panels, '''([a-z_]+)'', ', 'g') m;
  if exists (select 1 from unnest(v_keys) k where k <> all (v_allowed)) then
    raise exception '0335: the panel block would hand the customer a key outside the allow-list (%). Nothing was changed.',
      (select string_agg(k, ', ') from unnest(v_keys) k where k <> all (v_allowed));
  end if;

  v_def := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  if position('job_panels' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0335: portal_job_view''s documents block appears % time(s), not once, so someone changed it since 0326. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_old || v_panels);
  end if;
end $$;
comment on function public.portal_job_view(text, uuid) is
  'The customer portal''s job page (0301; 0315 scrubs supplier names; 0326 adds the shared papers through job_share_shows; 0335 adds the panel once the office shows it: kept circuits, customer-safe fields only). Service role only; the gate (link on, job is this customer''s in this org, customer-facing status) is inside. Returns building blocks the server turns into the allowlisted page payload (src/lib/portal/job-view-shape.ts).';

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
  v_def text := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
begin
  if position('job_panels' in v_def) = 0 or position('shown_on_portal' in v_def) = 0 then
    raise exception '0335: portal_job_view does not read the panel behind the office''s switch. Nothing was changed.';
  end if;
  if position('job_share_shows' in v_def) = 0 then
    raise exception '0335: portal_job_view lost 0326''s shared papers. Nothing was changed.';
  end if;
  -- Nothing on any page that opens today changed, except the new panels block (an array).
  select count(*) into v_bad
    from _0335_before b
   where (b.j - 'panels') is distinct from (public.portal_job_view(b.token, b.job_id)::jsonb - 'panels')
      or (b.j is not null and (b.j ? 'scope')
          and jsonb_typeof(public.portal_job_view(b.token, b.job_id)::jsonb -> 'panels') is distinct from 'array');
  if v_bad > 0 then
    raise exception '0335: % customer job page(s) would read differently. Nothing was changed.', v_bad;
  end if;
  -- And what any page carries under panels today is only allow-listed keys.
  if exists (
    select 1
      from _0335_before b
     cross join lateral jsonb_array_elements(coalesce(public.portal_job_view(b.token, b.job_id)::jsonb -> 'panels', '[]'::jsonb)) p
     where exists (select 1 from jsonb_object_keys(p) k where k not in ('name', 'main_amps', 'spaces', 'circuits'))
        or exists (select 1 from jsonb_array_elements(p -> 'circuits') c cross join lateral jsonb_object_keys(c) k
                    where k not in ('space', 'half', 'poles', 'amps', 'kind', 'room', 'label', 'feeds', 'is_new'))
  ) then
    raise exception '0335: a customer''s panel carries a key outside the allow-list. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute') then
    raise exception '0335: the portal door became callable without the service role. Nothing was changed.';
  end if;
end $$;
drop table _0335_before;
