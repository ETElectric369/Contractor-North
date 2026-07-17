import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";

/**
 * NORT'S SELF-REVIEW — "the logic center gets a pulse."
 *
 * Nort has quietly logged every conversation + the crew's bug reports for weeks. This reads that
 * operational signal BACK and has Claude cluster it into a short, ranked digest: what the crew asked
 * Nort that it couldn't do (capability gaps), what recurred (automation candidates), what broke
 * (bugs), and the top things to build/fix next. Written by the service-role job so it can read the
 * WHOLE crew's conversations (per-user RLS would otherwise hide teammates); staff read it back.
 *
 * This is the active half of the learning loop: instead of a human scanning transcripts each night,
 * Nort reviews its own day and surfaces the work.
 */

export type NortFinding = {
  title: string;
  kind: "gap" | "bug" | "pain" | "win" | "other";
  priority: number; // 1 = build/fix now, 3 = nice-to-have
  evidence: string;
};
export type NortReview = {
  id?: string;
  summary: string;
  findings: NortFinding[];
  counts: { bug_reports: number; conversations: number; messages: number };
  period_start: string;
  period_end: string;
};

const ANALYST_SYSTEM =
  "You are the operations analyst for Nort, the in-app assistant of a small field-service contractor. " +
  "You are handed the crew's RECENT conversations WITH Nort plus the bug reports they filed. Your job is " +
  "to make the assistant and the app better. Find, in order of value:\n" +
  "1. GAPS — things the crew asked Nort to do that it couldn't, fumbled, or answered wrong (a missing tool, " +
  "missing data, or a confusing flow). These are the next capabilities to build.\n" +
  "2. PAIN — the same question or complaint recurring (candidates for automation or a fix).\n" +
  "3. BUGS — concrete broken behavior from the bug reports or the transcripts.\n" +
  "4. WINS — what worked well (keep it).\n" +
  "Be concrete and specific — cite the actual ask or report, not generalities. Rank by real impact on the " +
  "crew's daily work and on money not slipping. Keep it tight; a busy owner reads this.\n\n" +
  "Return ONLY a JSON object, no prose around it:\n" +
  '{ "summary": "2-4 sentences: the headline of the day", ' +
  '"findings": [ { "title": "short imperative", "kind": "gap|bug|pain|win|other", "priority": 1, ' +
  '"evidence": "the specific ask/report this came from" } ] }. ' +
  "Cap findings at 8, most important first. If there is almost no signal, say so in the summary and return few or no findings.";

/** Pull the org's operational signal and build a compact digest for the analyst. */
async function buildDigest(supabase: SupabaseClient, orgId: string, sinceIso: string) {
  // Column is full_name (0001_init) — "name" 42703'd silently and the review generator
  // read ZERO transcripts for weeks (counts.conversations was always 0). Fixed 2026-07-16.
  const { data: profs } = await supabase.from("profiles").select("id, full_name").eq("org_id", orgId);
  const idToName = new Map((profs ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name || "crew"]));
  const profileIds = (profs ?? []).map((p: { id: string }) => p.id);

  // Bug reports the crew filed (open + recent).
  const { data: bugs } = await supabase
    .from("bug_reports")
    .select("note, page, status, created_at, reported_by")
    .eq("org_id", orgId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(40);

  // The crew's recent Nort conversations (cross-user — needs the service client).
  let messages: { role: string; content: string; created_at: string; who: string }[] = [];
  let convoCount = 0;
  if (profileIds.length) {
    const { data: convos } = await supabase
      .from("conversations")
      .select("id, user_id, created_at")
      .in("user_id", profileIds)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(30);
    convoCount = (convos ?? []).length;
    const convoUser = new Map((convos ?? []).map((c: { id: string; user_id: string }) => [c.id, c.user_id]));
    const convoIds = (convos ?? []).map((c: { id: string }) => c.id);
    if (convoIds.length) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("conversation_id, role, content, created_at")
        .in("conversation_id", convoIds)
        .order("created_at", { ascending: true })
        .limit(200);
      messages = (msgs ?? []).map((m: { conversation_id: string; role: string; content: string; created_at: string }) => ({
        role: m.role,
        content: String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 500),
        created_at: m.created_at,
        who: idToName.get(convoUser.get(m.conversation_id) ?? "") ?? "crew",
      }));
    }
  }

  const bugLines = (bugs ?? []).map(
    (b: { note: string; page: string | null; status: string }) =>
      `- [${b.status}] ${b.page ? `(${b.page}) ` : ""}${String(b.note || "").replace(/\s+/g, " ").trim().slice(0, 500)}`,
  );
  const convoLines = messages.map((m) => `[${m.who} · ${m.role === "user" ? "asked" : "Nort"}] ${m.content}`);

  const digest =
    `=== BUG REPORTS FILED (${bugLines.length}) ===\n${bugLines.join("\n") || "(none)"}\n\n` +
    `=== NORT CONVERSATIONS (${convoCount} threads, ${messages.length} turns) ===\n${convoLines.join("\n") || "(none)"}`;

  return { digest, counts: { bug_reports: bugLines.length, conversations: convoCount, messages: messages.length } };
}

/** Best-effort JSON extraction — the model is asked for pure JSON, but tolerate stray wrapping text. */
function parseReview(text: string): { summary: string; findings: NortFinding[] } {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1));
      const findings: NortFinding[] = Array.isArray(obj.findings)
        ? obj.findings.slice(0, 8).map((f: Record<string, unknown>) => ({
            title: String(f.title ?? "").slice(0, 200),
            kind: (["gap", "bug", "pain", "win", "other"].includes(String(f.kind)) ? String(f.kind) : "other") as NortFinding["kind"],
            priority: Math.max(1, Math.min(3, Math.round(Number(f.priority) || 2))),
            evidence: String(f.evidence ?? "").slice(0, 400),
          }))
        : [];
      return { summary: String(obj.summary ?? "").slice(0, 2000) || "No summary produced.", findings };
    }
  } catch {
    /* fall through to raw */
  }
  return { summary: text.slice(0, 2000), findings: [] };
}

/**
 * Generate + persist one org's review over the last `hours` (default 36h → yesterday + today).
 * Uses the SERVICE client (cross-crew read + service-role write). Returns null when the AI is
 * unconfigured or on any failure — callers treat it as best-effort.
 */
export async function generateNortReview(
  supabase: SupabaseClient,
  orgId: string,
  hours = 36,
): Promise<NortReview | null> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - hours * 3600_000);
  const { digest, counts } = await buildDigest(supabase, orgId, periodStart.toISOString());

  // Nothing happened → don't burn a model call or write an empty review.
  if (counts.bug_reports === 0 && counts.messages === 0) return null;

  let client;
  try {
    client = getAnthropic();
  } catch {
    return null; // AI not configured
  }

  let text = "";
  try {
    const resp = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1500,
      system: [{ type: "text", text: ANALYST_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Review the last ${Math.round(hours)} hours for this contractor:\n\n${digest}` }],
    });
    text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
  } catch {
    return null;
  }

  const { summary, findings } = parseReview(text);
  const row = {
    org_id: orgId,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    summary,
    findings,
    counts,
  };
  const { data, error } = await supabase.from("nort_reviews").insert(row).select("id").single();
  if (error) return null;
  return { id: (data as { id: string }).id, ...row };
}

/** Nightly cron entry: generate a review for every org that had activity. Best-effort per org. */
export async function generateNortReviewsForAllOrgs(supabase: SupabaseClient): Promise<number> {
  const { data: orgs } = await supabase.from("organizations").select("id");
  let made = 0;
  for (const o of (orgs ?? []) as { id: string }[]) {
    try {
      const r = await generateNortReview(supabase, o.id);
      if (r) made++;
    } catch {
      /* one org failing must not stop the rest */
    }
  }
  return made;
}
