// Fragment-first name resolution — the SAFETY NET behind the "ids are uuids" prompt rule.
//
// Nort still occasionally passes a NAME ("John Chmura"), a fabricated slug ("c1a-first-rob"),
// or a placeholder token ("{{APACHE_JOB_ID}}") where a uuid belongs, and the old handlers
// error out with a raw Postgres "invalid input syntax for type uuid". Instead of erroring,
// the entity handlers run every customer/job/person value through resolveEntityId first:
//  · a real uuid passes straight through UNCHANGED (today's behavior — the handler still
//    validates existence via its own RLS-scoped lookup, so nothing regresses);
//  · a placeholder token is refused with a "look it up first" nudge (never a DB round-trip);
//  · a plain name is resolved to its id against the caller's RLS-scoped table, but ONLY on a
//    SINGLE match — zero or several matches ASK rather than guess. Attaching the wrong
//    customer to a quote (or the wrong job to a cost) is a real, money-adjacent error, so the
//    resolver NEVER picks among candidates.
//
// This is a lookup, not a money inference: resolving a customer/job/person by name is the
// same thing the read tools (list_customers / list_jobs / list_team) already do — it just
// happens server-side at write time so a spoken name doesn't dead-end the whole action.

/** A supabase-shaped query client. Deliberately minimal + structural so the resolver can be
 *  unit-tested with a plain fake (no DB, no Next runtime) — the real caller passes the
 *  RLS-scoped server client. */
export type ResolverClient = {
  from: (table: string) => {
    select: (cols: string) => any;
  };
};

/** Result of a resolve: either a settled id (possibly null when the input was empty and the
 *  caller treats it as optional) OR an error sentence to read back to the user. */
export type ResolveResult = { id: string | null } | { error: string };

/** Canonical v1–v5 UUID shape. The fast-path: a value that already looks like a uuid is
 *  returned untouched — the handler's existing existence check is still the real gate. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Does this look like a template placeholder / token the model fabricated rather than a
 *  real name the user said? — {{FOO}}, <foo>, [FOO], or a bare ALL_CAPS_SNAKE token with no
 *  spaces (e.g. APACHE_JOB_ID, JOB_ID). These are never a customer/job/person name, so we
 *  refuse fast with a "look it up first" nudge instead of a doomed name search. A real name
 *  has a space or lowercase letters; a single ordinary word ("Miller") does NOT match. */
export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // Wrapped in mustache / angle / square brackets → a template slot.
  if (/^\{\{.*\}\}$/.test(v) || /^<.*>$/.test(v) || /^\[.*\]$/.test(v)) return true;
  // Bare ALL-CAPS snake token with no spaces AND an underscore or digit — reads as a code
  // token (APACHE_JOB_ID, JOB_ID_1), never a spoken name. Requires the underscore/digit so a
  // legitimately all-caps company name typed as one word ("ACME") isn't caught.
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(v)) return true;
  return false;
}

export type ResolveOpts = {
  /** The name column(s) to match against, in priority order. Defaults to ["name"]. */
  nameColumns?: string[];
  /** Human noun for the error sentences, e.g. "customer", "job", "person". Default "record". */
  thing?: string;
};

/**
 * Resolve a raw value the model passed for an id column to a real id.
 *
 * Contract:
 *  · null / "" / whitespace           → { id: null }  (caller decides if required)
 *  · a uuid                            → { id: value } UNCHANGED (existence still checked downstream)
 *  · a placeholder token              → { error: "That looks like a placeholder…" }
 *  · a name, EXACTLY one match        → { id }
 *  · a name, ZERO matches             → { error: 'No <thing> named "…" — spelled right, or create it?' }
 *  · a name, TWO+ matches             → { error: 'Several <thing> match "…" — which one?' }
 *
 * The lookup runs through the passed RLS-scoped client, so it can only ever see (and match)
 * rows in the caller's own org. Name matching is case-insensitive: an EXACT match wins first
 * (so "Miller" resolves cleanly even when "Miller & Sons" also exists); only if there's no
 * exact match does it fall back to a "contains" search — and even then a single hit is
 * required. It NEVER returns an id when more than one row matches.
 */
export async function resolveEntityId(
  supabase: ResolverClient,
  table: string,
  value: string | null | undefined,
  opts?: ResolveOpts,
): Promise<ResolveResult> {
  const thing = opts?.thing ?? "record";
  const nameColumns = opts?.nameColumns?.length ? opts.nameColumns : ["name"];

  if (value == null) return { id: null };
  const raw = String(value).trim();
  if (!raw) return { id: null };

  // Fast-path: already a uuid — leave it exactly as-is (no DB round-trip). The handler's own
  // existence lookup remains the authority on whether that id is real and visible.
  if (isUuid(raw)) return { id: raw };

  // A fabricated placeholder / token — never a real name. Refuse with a look-it-up nudge
  // rather than running a name search that can only ever fail confusingly.
  if (looksLikePlaceholder(raw)) {
    return {
      error: `That looks like a placeholder, not a real ${thing} — look it up first (list_${thing}s) and pass the id.`,
    };
  }

  // NAME RESOLUTION against the RLS-scoped table. Try an exact (case-insensitive) match on
  // each name column first; only fall back to "contains" if nothing matched exactly.
  const escaped = safeForOr(raw);
  if (!escaped) {
    // The name was ONLY structural/punctuation characters — nothing to match on.
    return { error: `No ${thing} named "${raw}" — is it spelled right, or should I create it?` };
  }

  // 1) EXACT match, across the name columns (OR'd). ilike with no wildcards is a
  //    case-insensitive equality.
  const exactFilter = nameColumns.map((c) => `${c}.ilike.${escaped}`).join(",");
  const exact = await runMatch(supabase, table, exactFilter);
  if ("error" in exact) return { error: `Couldn't look up that ${thing} — ${exact.error}` };
  const exactDecision = decide(exact.rows, raw, thing);
  if (exactDecision) return exactDecision;

  // 2) CONTAINS match (only reached when there was no exact hit at all).
  const containsFilter = nameColumns.map((c) => `${c}.ilike.%${escaped}%`).join(",");
  const contains = await runMatch(supabase, table, containsFilter);
  if ("error" in contains) return { error: `Couldn't look up that ${thing} — ${contains.error}` };
  const containsDecision = decide(contains.rows, raw, thing);
  if (containsDecision) return containsDecision;

  // Nothing matched either way.
  return {
    error: `No ${thing} named "${raw}" — is it spelled right, or should I create it?`,
  };
}

/** Make a name safe to embed in a PostgREST `.or(...)` ilike filter. Same rule the app-wide
 *  sanitizeSearch uses: commas / parens / colons / quotes are STRUCTURAL delimiters in an
 *  `or(...)` list (backslash-escaping them doesn't reliably protect them), so they're stripped
 *  to spaces; %, _, * are LIKE/pattern wildcards, likewise stripped so "Miller & Sons" or
 *  "Joe's Plumbing, Inc." matches by its plain words instead of breaking or over-matching the
 *  filter. Collapses whitespace and caps length. Returns "" when nothing usable is left. */
function safeForOr(value: string): string {
  return value
    .replace(/[,()*:%\\"'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** Run one name-match query and return the matched rows (id only). Capped at 3 — we only need
 *  to know zero / one / many. */
async function runMatch(
  supabase: ResolverClient,
  table: string,
  orFilter: string,
): Promise<{ rows: { id: string }[] } | { error: string }> {
  const { data, error } = await supabase.from(table).select("id").or(orFilter).limit(3);
  if (error) return { error: error.message ?? "lookup failed" };
  return { rows: (data ?? []) as { id: string }[] };
}

/** Turn a set of matched rows into a decision, or null to signal "keep looking" (used so an
 *  empty exact-match set falls through to the contains pass instead of erroring early). */
function decide(rows: { id: string }[], raw: string, thing: string): ResolveResult | null {
  if (rows.length === 1) return { id: rows[0].id };
  if (rows.length > 1) {
    return { error: `Several ${thing}s match "${raw}" — which one? (be specific / pass the id)` };
  }
  return null; // zero — let the caller try the next strategy
}

// ── Typed convenience wrappers ──────────────────────────────────────────────────────────
// The three entities the handlers resolve by name, plus a generic contact resolver. Each
// pins the right table + name column(s) + noun so the call sites stay one line.

/** Customer / contact: match on their display name OR company name. */
export function resolveCustomerId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "customers", value, { nameColumns: ["name", "company_name"], thing: "customer" });
}

/** A contact in the unified book — same table + columns as a customer, worded as a contact. */
export function resolveContactId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "customers", value, { nameColumns: ["name", "company_name"], thing: "contact" });
}

/** Job: match on the job name. */
export function resolveJobId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "jobs", value, { nameColumns: ["name"], thing: "job" });
}

/** Crew member / assignee: profiles' name column is full_name. */
export function resolveProfileId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "profiles", value, { nameColumns: ["full_name"], thing: "person" });
}
