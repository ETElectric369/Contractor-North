-- OFFLINE PUNCHES ARE THEIR OWN SOURCE (determinism survey, Wave E — timeclock).
--
-- A punch made in a dead zone and delivered hours later is neither of the two things this enum
-- already knows about. It isn't 'app' — the server clock was NOT the authority for its time. And
-- it isn't 'manual' — nobody typed a time; they pressed the button when it actually happened.
--
-- The distinction matters because it is the ONLY honest guard available. Nothing can
-- cryptographically prove a punch was made live and delivered late rather than backdated after the
-- fact — the device asserts both. So instead of pretending to verify it, the entry says plainly
-- where its start time came from, and the office can see it on the timecard. A time record whose
-- provenance is visible is one somebody can question; one that silently claims to be a live punch
-- is not.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PG12+ as long as the new value isn't USED in the
-- same transaction. This migration only adds it, so the runner's begin/commit wrapper is fine.

alter type time_entry_source add value if not exists 'offline';
