-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0236: contacts stay in your pocket
--
-- Reverts 0235 same-day. Erik, on the CardDAV sync: "i dont think a sync like that is a realistic
-- solution for multi tenant user platform nor do i want to go through all that effort nor would
-- anyone else nor would i or anyone else want all of their contacts in their business folder."
--
-- He is right three times over: an app-specific-password ritual is a setup wall nobody climbs,
-- it was Apple-only in a multi-tenant product, and — the design error underneath — it copied the
-- WHOLE BOOK when the need is picking ONE person at the moment they text you. The doctrine that
-- replaces it: the system's own Contacts app IS the picker; North just accepts the card (native
-- picker API where it exists, the iOS keyboard flow, and drag-a-card-from-Contacts on the Mac).
-- Nothing personal is ever stored.
--
-- Tables were hours old and empty; nothing to migrate out.
-- ═══════════════════════════════════════════════════════════════════════════

drop table if exists public.phone_contacts;
drop table if exists public.carddav_accounts;
