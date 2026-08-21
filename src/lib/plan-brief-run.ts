import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, getAnthropic } from "@/lib/anthropic";
import { aiSpendExceeded, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimited } from "@/lib/rate-limit";
import { getOrgSettings } from "@/lib/org-settings";
import { playbookForForm } from "@/lib/playbook/parse";
import { INTAKE_BUCKET, extOf, intakePaths, uploadDisplayName } from "@/lib/playbook/uploads";
import type { Need, Playbook } from "@/lib/playbook/types";
import {
  BRIEF_LIMITS,
  answersFromBrief,
  parsePlanBrief,
  pickReadablePlans,
  type PlanBrief,
  type PlanBriefSkip,
} from "@/lib/plan-brief";

/**
 * THE READING ITSELF — a lead's uploaded plans become a preliminary walk-through report.
 *
 * Runs on the SERVICE client because its two callers both arrive without a usable session for
 * this work: the public intake door (a stranger's browser, via after()) and the staff retry
 * button (whose own action verifies membership through an RLS read before calling here). Every
 * query still pins org_id explicitly — the service role reads all tenants, so the pin IS the
 * boundary.
 *
 * This is the first model call reachable from an unauthenticated door, so it wears the full
 * harness: the org's monthly AI ceiling, a fail-closed per-org daily limit (rate-limit.ts's own
 * doc: unauthenticated money-spending paths fail closed), and a meter row per call. The model
 * only ever READS — the brief lands as data on the lead, and a human carries it forward.
 */

/** One attempt already running? Give it this long before a retry may stomp it. */
const PENDING_GRACE_MS = 3 * 60 * 1000;

const nowIso = () => new Date().toISOString();

async function writeBrief(
  svc: ReturnType<typeof createServiceClient>,
  orgId: string,
  inquiryId: string,
  brief: PlanBrief,
): Promise<boolean> {
  // Read-modify-write on the intake bag; nothing else writes intake after submit, and the
  // .select("id") is the silent-write check (a vanished row must not report success).
  const { data: row } = await svc
    .from("inquiries")
    .select("intake")
    .eq("id", inquiryId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!row) return false;
  const intake =
    row.intake && typeof row.intake === "object" ? (row.intake as Record<string, unknown>) : {};
  const { data: upd } = await svc
    .from("inquiries")
    .update({ intake: { ...intake, plan_brief: brief }, updated_at: nowIso() })
    .eq("id", inquiryId)
    .eq("org_id", orgId)
    .select("id");
  return !!upd?.length;
}

/** The question list the model answers — the org's own walk-through, typed. */
function questionLines(needs: Need[]): string {
  return needs
    .filter((n) => n.slot?.type !== "scopes" && n.slot?.type !== "file")
    .map((n) => {
      const s = n.slot;
      const kind =
        s?.type === "number"
          ? `number${s.unit ? ` in ${s.unit}` : ""}`
          : s?.type === "select"
            ? `one of: ${s.options.join(" | ")}${s.multi ? " (multiple allowed, as an array)" : ""}`
            : "short text";
      const measured = n.measured
        ? " [a measurement — answer ONLY if a dimension printed on the sheets states it]"
        : "";
      return `- "${n.key}" (${n.label}): ${n.ask} — ${kind}${measured}`;
    })
    .join("\n");
}

export async function runPlanBrief(
  orgId: string,
  inquiryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();

  const { data: inq } = await svc
    .from("inquiries")
    .select("id, name, message, intake")
    .eq("id", inquiryId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!inq) return { ok: false, error: "Lead not found." };

  const paths = intakePaths(inq.intake);
  if (!paths.length) return { ok: false, error: "This lead has no uploaded files." };

  // The last GOOD report survives every failure below (review: "Read again" plus a tripped
  // budget deleted working data while refusing to do any work). Only a successful new reading
  // may replace it.
  const priorReady = (() => {
    const b = parsePlanBrief(inq.intake);
    return b?.status === "ready" ? b : null;
  })();

  const fail = async (error: string, skipped: PlanBriefSkip[] = [], status: "failed" | "skipped" = "failed") => {
    if (priorReady) {
      // Restore the good report over the pending mark; the caller's toast carries the error.
      await writeBrief(svc, orgId, inquiryId, priorReady);
    } else {
      await writeBrief(svc, orgId, inquiryId, { v: 1, status, at: nowIso(), files: [], skipped, error });
    }
    return { ok: false as const, error };
  };

  // Spend gates BEFORE any claim, download or model call — and when a good report exists they
  // write NOTHING (a refusal to work must not cost the work already done).
  if (await aiSpendExceeded(orgId)) {
    const msg = "This month's AI budget is used up — the plans are still on the lead.";
    return priorReady ? { ok: false, error: msg } : fail(msg, [], "skipped");
  }
  if (await rateLimited(`plan-brief:${orgId}`, 20, 86400, { failClosed: true })) {
    const msg = "A lot of plans were read today — try again tomorrow.";
    return priorReady ? { ok: false, error: msg } : fail(msg, [], "skipped");
  }

  // THE CLAIM IS ATOMIC — one conditional UPDATE whose WHERE encodes "no live pending run".
  // The old shape read the brief, checked pending, then wrote: the intake-door after() and the
  // staff retry could both pass the check and read the same plans twice, twice billed. Under
  // READ COMMITTED a concurrent staker serializes on the row lock and re-evaluates this WHERE
  // against the winner's row, matching zero rows — which .select("id") reports honestly.
  const intakeBag = inq.intake && typeof inq.intake === "object" ? (inq.intake as Record<string, unknown>) : {};
  const staleBefore = new Date(Date.now() - PENDING_GRACE_MS).toISOString();
  const { data: claimed } = await svc
    .from("inquiries")
    .update({ intake: { ...intakeBag, plan_brief: { v: 1, status: "pending", at: nowIso(), files: [], skipped: [] } }, updated_at: nowIso() })
    .eq("id", inquiryId)
    .eq("org_id", orgId)
    .or(
      `intake->plan_brief.is.null,intake->plan_brief->>status.neq.pending,intake->plan_brief->>at.lt.${staleBefore}`,
    )
    .select("id");
  if (!claimed?.length) return { ok: false, error: "Already reading the plans — give it a minute." };

  try {
    // Per-file sizes, never a folder listing. The first cut listed `${orgId}/intake` with
    // limit 200 — an O(org-lifetime) folder for an O(lead) question, name-ascending on
    // epoch-prefixed names, so once an org passed 200 uploads every NEW lead's files fell off
    // the page and were skipped as "no longer in storage". This lead's own handful of paths is
    // the whole question; ask about exactly those.
    const sized: { path: string; bytes: number | null }[] = [];
    for (const p of paths) {
      if (extOf(p) !== "pdf") {
        sized.push({ path: p, bytes: null }); // pickReadablePlans skips non-PDFs by extension first
        continue;
      }
      const { data: meta, error: infoErr } = await svc.storage.from(INTAKE_BUCKET).info(p);
      if (infoErr) {
        const status = Number((infoErr as { status?: number; statusCode?: number | string }).status ?? (infoErr as { statusCode?: number | string }).statusCode ?? 0);
        // Only a genuine not-found means the file is gone; any other failure is OUR problem
        // and must not write a report blaming the customer's files.
        if (status === 404 || status === 400) {
          sized.push({ path: p, bytes: null });
          continue;
        }
        throw new Error("Couldn't check the uploaded files in storage — try again.");
      }
      sized.push({ path: p, bytes: Number((meta as { size?: number } | null)?.size ?? 0) });
    }
    const { read, skipped } = pickReadablePlans(sized);
    if (!read.length) {
      return fail("None of the uploads is a readable plan PDF.", skipped, "skipped");
    }

    const docs: Anthropic.ContentBlockParam[] = [];
    const readPaths: string[] = [];
    for (const p of read) {
      const { data: blob } = await svc.storage.from(INTAKE_BUCKET).download(p);
      if (!blob) {
        skipped.push({ name: uploadDisplayName(p), reason: "file no longer in storage" });
        continue;
      }
      docs.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
        },
      });
      readPaths.push(p);
    }
    if (!docs.length) return fail("The uploads couldn't be opened from storage.", skipped);

    const [{ data: form }, { data: org }] = await Promise.all([
      svc
        .from("forms")
        .select("id, schema, playbook")
        .eq("org_id", orgId)
        .eq("is_inspection", true)
        .limit(1)
        .maybeSingle(),
      svc.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    ]);
    const pb: Playbook = form ? playbookForForm(form as { schema?: unknown; playbook?: unknown }) : { needs: [] };
    const questions = questionLines(pb.needs);
    const trade = getOrgSettings((org as { settings?: unknown } | null)?.settings).trade_label?.trim() || "contractor";

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system:
        `You prepare a PRELIMINARY walk-through report for a ${trade}, from plan documents a customer uploaded with their request — before anyone has visited the site. ` +
        "You are a careful reader, not an estimator: report what the documents and the customer's own words actually state, and nothing else. " +
        "THE CUSTOMER'S WORDS OVERRIDE THE DRAWINGS — if they say the work covers only part of the plans (rooms excluded, phases, work already done), the report and every answer must honor that, even where the sheets still show the excluded work. " +
        'Respond with ONLY a JSON object: {"summary": string, "scope_included": string[], "scope_excluded": string[], "answers": object, "observations": string[], "cautions": string[]}. ' +
        "summary = 2-4 plain sentences: what the project is, per the plans and the request. " +
        "scope_included / scope_excluded = the work the customer is asking for vs. explicitly not asking for (empty arrays when they didn't limit it). " +
        '"answers" = the walk-through questions below, keyed EXACTLY by their keys. Answer ONLY what the documents or the customer state — OMIT any key you cannot support; never guess. A select answer must be one of its listed options, verbatim. A number answer is a plain number in the stated unit. ' +
        "observations = concrete details from the sheets a walk-through should know that no question asks (counts, callouts, notes, existing conditions) — at most 10, each one sentence. " +
        "cautions = what to verify on site: dimension ambiguities, conflicts between the request and the drawings, sheets too dense to count reliably. " +
        "No prose outside the JSON.",
      messages: [
        {
          role: "user",
          content: [
            ...docs,
            {
              type: "text",
              text:
                `THE CUSTOMER'S REQUEST (their words govern):\nName: ${String(inq.name ?? "")}\n${String(inq.message ?? "").slice(0, 4000) || "(no message)"}\n\n` +
                (questions
                  ? `THE WALK-THROUGH QUESTIONS (answer by key, only what the documents support):\n${questions}`
                  : "This organization has no walk-through question list — return answers as {}."),
            },
          ],
        },
      ],
    });
    void recordAiUsage({ orgId, model: DEFAULT_MODEL, surface: "plan-brief", usage: msg.usage as never });

    if (msg.stop_reason === "max_tokens") {
      return fail("The report ran too long in one pass — try again, or read the plans from the paperclip.");
    }
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const parsed = (await parseAiJson(client, text, orgId)) as {
      summary?: unknown;
      scope_included?: unknown;
      scope_excluded?: unknown;
      answers?: unknown;
      observations?: unknown;
      cautions?: unknown;
    };

    const list = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_LIMITS.itemChars))
            .filter(Boolean)
            .slice(0, BRIEF_LIMITS.listItems)
        : [];

    const brief: PlanBrief = {
      v: 1,
      status: "ready",
      at: nowIso(),
      model: DEFAULT_MODEL,
      files: readPaths,
      skipped,
      summary: String(parsed.summary ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_LIMITS.summary),
      scope_included: list(parsed.scope_included),
      scope_excluded: list(parsed.scope_excluded),
      answers: answersFromBrief(pb, parsed.answers),
      observations: list(parsed.observations),
      cautions: list(parsed.cautions),
    };
    const wrote = await writeBrief(svc, orgId, inquiryId, brief);
    if (!wrote) return { ok: false, error: "The lead disappeared while the plans were being read." };
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The plans couldn't be read.";
    return fail(
      /ANTHROPIC_API_KEY/i.test(message)
        ? "AI isn't configured on this server."
        : `The plans couldn't be read: ${message.slice(0, 300)}`,
    );
  }
}
