-- Migration 0055: subtasks (self-referencing parent) + tags on tasks.
-- Additive + backward compatible (existing tasks have parent_id null, tags null).
alter table public.tasks
  add column if not exists parent_id uuid references public.tasks(id) on delete cascade,
  add column if not exists tags text[];
create index if not exists tasks_parent_idx on public.tasks(parent_id);
