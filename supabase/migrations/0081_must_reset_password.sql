-- Force a password change on first login for accounts created with a handed-out temp
-- password (crew import / add-employee, where the password is the phone number or a temp).
-- The (app) layout redirects a profile with must_reset_password = true to /set-password
-- until they choose their own; updateMyPassword clears the flag. profiles_update_self
-- already lets a user update their own row.
alter table public.profiles add column if not exists must_reset_password boolean not null default false;
