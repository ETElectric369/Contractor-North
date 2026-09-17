import { dbError } from "@/lib/db-error";
import { escapeLike } from "@/lib/utils";
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
 * rows in the caller's own org. Name matching is case-insensitive and runs in three passes,
 * each stopping the moment it decides: the name EXACTLY as it was said ("Joe's Plumbing", with
 * its punctuation), then the sanitized exact, then a "contains" search. An exact match wins
 * first so "Miller" resolves cleanly even when "Miller & Sons" also exists, and even the
 * contains pass requires a single hit. It NEVER returns an id when more than one row matches.
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

  // 0) THE NAME AS THE PERSON ACTUALLY SAID IT (audit v947).
  //
  // safeForOr strips [,()*:%\"'.] to spaces because those are STRUCTURAL in a PostgREST
  // `.or(...)` list — but it does that BEFORE the equality check below, so "Joe's Plumbing"
  // was compared as "Joe s Plumbing" and could never equal its own stored row. The contains
  // pass then searched for the same mangled string and missed too, so Nort answered "No
  // customer named Joe's Plumbing" about a customer sitting right there. This was patched at
  // exactly one call site (saveQuoteFromDraft); every entity handler — job, quote, bill, petty
  // cash, appointment, task, time, lien, permit, material — still took the broken path.
  //
  // A SINGLE `.ilike(col, value)` has no `or()` grammar to break out of, so the punctuation is
  // safe to carry: one query per name column (two at most), %/_ escaped so they stay literal.
  // Only worth the round trip when sanitizing actually changed the name — otherwise this pass
  // and the one below are the same query.
  const punctuated = escaped !== raw && escaped !== "";
  if (punctuated) {
    const literal = await runLiteralMatch(supabase, table, nameColumns, raw, "exact");
    if ("error" in literal) return { error: `Couldn't look up that ${thing} — ${literal.error}` };
    const literalDecision = decide(literal.rows, raw, thing);
    if (literalDecision) return literalDecision;
  }

  if (!escaped) {
    // The name was ONLY structural/punctuation characters — nothing to match on, and nothing
    // worth a literal lookup either (no record is named "(),:").
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

  // 3) CONTAINS on the punctuated name AS WRITTEN — the same blind spot one rung down. Nort says
  //    "Joe's"; the sanitized pass searched "%Joe s%" and missed "Joe's Plumbing" too. Last
  //    resort, and only for a name sanitizing actually changed, so the ordinary lookup still
  //    costs the two queries it always did.
  if (punctuated) {
    const loose = await runLiteralMatch(supabase, table, nameColumns, raw, "contains");
    if ("error" in loose) return { error: `Couldn't look up that ${thing} — ${loose.error}` };
    const looseDecision = decide(loose.rows, raw, thing);
    if (looseDecision) return looseDecision;
  }

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
 *  filter. Collapses whitespace and caps length. Returns "" when nothing usable is left.
 *  NOT the first thing tried any more: runExactLiteral above matches the name as written, so a
 *  punctuated name never has to be found by its mangled form. */
function safeForOr(value: string): string {
  return value
    .replace(/[,()*:%\\"'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** Match the name EXACTLY as it was said, one column at a time. A single `.ilike(col, value)` is
 *  a filter VALUE, not an `or()` expression, so commas, parens, colons, quotes and periods travel
 *  intact; escapeLike keeps % and _ literal instead of turning "Joe_s" into a wildcard. Ids are
 *  de-duplicated across the columns so a row matching on both `name` and `company_name` still
 *  reads as ONE match rather than an ambiguity. */
async function runLiteralMatch(
  supabase: ResolverClient,
  table: string,
  columns: string[],
  raw: string,
  mode: "exact" | "contains",
): Promise<{ rows: { id: string }[] } | { error: string }> {
  const pattern = mode === "contains" ? `%${escapeLike(raw)}%` : escapeLike(raw);
  const seen = new Set<string>();
  const rows: { id: string }[] = [];
  for (const col of columns) {
    const { data, error } = await supabase.from(table).select("id").ilike(col, pattern).limit(3);
    if (error) return { error: dbError(error) ?? "lookup failed" };
    for (const r of (data ?? []) as { id: string }[]) {
      if (r?.id && !seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
    if (rows.length > 1) break; // already ambiguous — decide() only needs zero / one / many
  }
  return { rows };
}

/** Run one name-match query and return the matched rows (id only). Capped at 3 — we only need
 *  to know zero / one / many. */
async function runMatch(
  supabase: ResolverClient,
  table: string,
  orFilter: string,
): Promise<{ rows: { id: string }[] } | { error: string }> {
  const { data, error } = await supabase.from(table).select("id").or(orFilter).limit(3);
  if (error) return { error: dbError(error) ?? "lookup failed" };
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

/** Job: match on the job name OR its display number (J-012) — the number is exactly what
 *  Nort sees on the card and says out loud, so accepting it kills the "grab the real id" loop. */
export function resolveJobId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "jobs", value, { nameColumns: ["name", "job_number"], thing: "job" });
}

/** Quote / estimate: match on its display number (E-010 / Q-012) or title — same reason as
 *  the job number above. quote_number is unique per org, so a number resolves to exactly one. */
export function resolveQuoteId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "quotes", value, { nameColumns: ["quote_number", "title"], thing: "estimate" });
}

/** Crew member / assignee: profiles' name column is full_name. */
export function resolveProfileId(supabase: ResolverClient, value: string | null | undefined): Promise<ResolveResult> {
  return resolveEntityId(supabase, "profiles", value, { nameColumns: ["full_name"], thing: "person" });
}
