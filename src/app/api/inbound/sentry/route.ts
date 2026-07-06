import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimited, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Sentry error webhook sink. Point a Sentry Internal Integration / alert webhook at:
 *   POST https://<app>/api/inbound/sentry?s=<SENTRY_WEBHOOK_SECRET>
 * and every alerting issue lands in the sentry_events table — a queryable error log the operator
 * (and Claude, each session) can triage + fix, instead of the owner getting paged by email. Deduped
 * by Sentry issue id (repeat occurrences bump a count + last_seen). The full body is kept in payload
 * so nothing is lost even if a field moves between Sentry payload shapes.
 */
const pick = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 500);
  }
  return null;
};

export async function POST(req: Request) {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const url = new URL(req.url);
  const provided = url.searchParams.get("s") ?? req.headers.get("x-webhook-secret") ?? "";
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (await rateLimited(`sentry:${clientIp(req.headers)}`, 120, 60)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request." }, { status: 400 }); }

  // Extract defensively across Sentry's alert / issue / event payload shapes.
  const issue = body?.data?.issue ?? {};
  const event = body?.data?.event ?? body?.event ?? {};
  const issueId = pick(issue.id, event.issue_id, body?.id, event.groupID);
  const title = pick(issue.title, event.title, body?.message, event.message, issue.culprit, event.culprit) ?? "Sentry error";
  const culprit = pick(issue.culprit, event.culprit, event.transaction, (event.tags && event.tags.where));
  const level = pick(issue.level, event.level, body?.level) ?? "error";
  const project = pick(body?.project, issue?.project?.slug, event?.project, body?.project_slug);
  const permalink = pick(issue.web_url, issue.permalink, event.web_url, body?.url);

  const supabase = createServiceClient();
  try {
    // Dedupe by issue id: bump the count + last_seen on a repeat, else insert.
    if (issueId) {
      const { data: existing } = await supabase.from("sentry_events").select("id, event_count").eq("issue_id", issueId).maybeSingle();
      if (existing) {
        await supabase.from("sentry_events").update({
          title, culprit, level, project, permalink,
          event_count: (Number(existing.event_count) || 0) + 1,
          last_seen: new Date().toISOString(),
          payload: body,
          status: "new", // a fresh occurrence re-surfaces a previously-triaged issue
        }).eq("id", existing.id);
        return NextResponse.json({ ok: true, deduped: true });
      }
    }
    await supabase.from("sentry_events").insert({ issue_id: issueId, title, culprit, level, project, permalink, payload: body });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Store failed." }, { status: 500 });
  }
}
