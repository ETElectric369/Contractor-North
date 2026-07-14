-- LIFECYCLE REWORK step 1/2 (Erik's yellow pad, 2026-07): a job fresh off an approved
-- estimate is "to be scheduled" — a real waiting-room status, not "estimate" (estimates
-- live at /quotes and file away on accept). This ONLY adds the enum value; the data
-- migration (0127) runs separately because Postgres refuses to USE a new enum value in
-- the same transaction that added it.
alter type job_status add value if not exists 'to_be_scheduled' before 'scheduled';
