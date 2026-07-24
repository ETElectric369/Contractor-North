-- Erik 7/24: "add Contractor to the list of contact options" — ET works FOR general
-- contractors (Tahoe Deck et al), which is neither 'subcontractor' (that's who works
-- for ET) nor 'commercial'.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so this was
-- applied directly (2026-07-24), not via run-one-migration.mjs. Kept for the record.
alter type customer_type add value if not exists 'contractor';
