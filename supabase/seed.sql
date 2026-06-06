-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — seed data
--
-- As of migration 0004 (multi-tenancy), job codes and the starter safety form
-- are seeded PER ORGANIZATION automatically when you create your company during
-- onboarding (see the create_organization() function). There is therefore no
-- global seed data to load — every org gets its own copy.
--
-- This file is intentionally a no-op now. It remains so older docs that say
-- "run seed.sql" don't error.
-- ═══════════════════════════════════════════════════════════════════════════

select 'Contractor North: nothing to seed — orgs are seeded on onboarding.' as note;
