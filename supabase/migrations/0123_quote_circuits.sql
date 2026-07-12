-- A quote/estimate can carry a CIRCUIT SCHEDULE — the panel layout behind the price (which
-- breaker feeds what, on which wire). Stored as a JSON array of rows so it prints as a second
-- page on the estimate without a whole child table. NULL/empty = no schedule page.
--   [{ "ckt": "1", "description": "Kitchen small-appliance", "wire": "12/2", "breaker": "20A", "load": "…" }, …]
alter table quotes add column if not exists circuits jsonb;

comment on column quotes.circuits is
  'Optional circuit schedule (JSON array of {ckt, description, wire, breaker, load}) — prints as a second page on the estimate.';
