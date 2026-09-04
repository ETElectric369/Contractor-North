-- 0242 — END MY SESSION (Phase 0 shell test, 2026-09-04): Sign Out on one device signed out EVERY device.
--
-- Two mechanisms, both real:
--   1. supabase-js signOut() defaults to scope "global" (fixed in the app at cn-v918: scope "local").
--   2. GoTrue's /logout?scope=local loads the session named in the JWT's session_id; when that session
--      cannot be found (already ended — e.g. the action ran twice), the handler FALLS THROUGH to
--      models.Logout(userID): a user-wide logout. Verified tonight: a fresh cn-v918 page, one Sign Out,
--      all three of Erik's sessions deleted.
--
-- So the user's own sign-out no longer goes through /logout at all. It ends exactly ONE session — the
-- caller's own, by id — and clears the cookies. Deactivation / offboarding keep the global kill on
-- purpose (settings/actions.ts admin.signOut(id, "global")).
create or replace function public.end_my_session(p_session uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  -- Only the caller's own session, ever. Cascades the session's refresh tokens (auth FK).
  delete from auth.sessions
   where id = p_session
     and user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;
-- Supabase's default privileges hand EXECUTE on new public functions to anon too; take it back.
-- (anon has no auth.uid(), so it could never delete a row — but it has no business calling this.)
revoke all on function public.end_my_session(uuid) from public, anon;
grant execute on function public.end_my_session(uuid) to authenticated;
comment on function public.end_my_session(uuid) is
  'Sign out THIS device: deletes one auth.sessions row (the caller''s own). Never touches other sessions.';
