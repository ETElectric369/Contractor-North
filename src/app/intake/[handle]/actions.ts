"use server";

import { splitLeadAddress } from "@/lib/inquiries/lead-address";
import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { createTriagedInquiry } from "@/lib/inquiries/create-triaged-inquiry";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { clearInapplicable } from "@/lib/playbook/resolve";
import { publicIntakeNeeds } from "@/lib/playbook/public-intake";
import { isOwnIntakePath, uploadDisplayName } from "@/lib/playbook/uploads";
import { playbookForForm } from "@/lib/playbook/parse";
import type { Answers } from "@/lib/playbook/types";

export interface IntakePayload {
  /** Honeypot — a real person never fills it. */
  hp?: string;
  contact: { name?: string; phone?: string; email?: string; address?: string; city?: string; state?: string; zip?: string };
  /** Where the WORK is, when it isn't the contact's own address. null = same as home (0189). */
  site?: { address?: string; city?: string; state?: string; zip?: string } | null;
  answers: Answers;
}

/**
 * Public submit for the intake door. Same hardening ladder as submitEstimateLead, because this is
 * an unauthenticated write and every call costs the contractor something real (an inquiry row, a
 * push to every office phone, an email): honeypot first, per-IP ceiling, then a per-org daily
 * backstop a rotating-IP flood can't walk past.
 *
 * THE ANSWERS ARE COERCED AGAINST THE SERVER'S OWN PLAYBOOK — the client's key set is never
 * trusted. An answer to a question the org doesn't ask is dropped on the floor, and a select
 * value that isn't one of the org's options is nulled by the same coercer the inspector uses.
 */
export async function submitIntake(
  handle: string,
  payload: IntakePayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (payload?.hp) return { ok: true }; // bot trap — pretend success, write nothing

  const name = String(payload?.contact?.name ?? "").trim().slice(0, 120);
  if (!name) return { ok: false, error: "Please enter your name." };
  const phone = String(payload?.contact?.phone ?? "").trim().slice(0, 40);
  const email = String(payload?.contact?.email ?? "").trim().slice(0, 200);
  if (!phone && !email) return { ok: false, error: "Add a phone or email so we can reach you." };
  // TWO ADDRESSES, AND `address` IS STILL THE SITE (0189) — see lib/inquiries/lead-address.ts for
  // the rule and why it lives in one place rather than at both of its call sites.
  const split = splitLeadAddress({ contact: payload?.contact ?? {}, site: payload?.site ?? null });
  const address = split.site.address ?? "";
  const city = split.site.city;
  const state = split.site.state;
  const zip = split.site.zip;
  const contactAddress = split.contact.address ?? "";
  const contactCity = split.contact.city;
  const contactState = split.contact.state;
  const contactZip = split.contact.zip;

  const ip = clientIp(await headers());
  if (await rateLimited(`intake:${ip}`, 5, 60)) {
    return { ok: false, error: "Too many requests — please try again in a moment." };
  }

  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id, settings")
    .eq("settings->>public_handle", String(handle))
    .limit(1)
    .maybeSingle();
  if (!org) return { ok: false, error: "This form isn't available right now." };
  const orgId = (org as { id: string }).id;

  if (await rateLimited(`intake-org:${orgId}`, 50, 86400)) {
    return { ok: false, error: "We've had a lot of requests today — please call us instead." };
  }

  // The door must actually be ON. A disabled door that still accepts posts isn't an off switch.
  const { data: form } = await supabase
    .from("forms")
    .select("id, schema, playbook")
    .eq("org_id", orgId)
    .eq("is_public_intake", true)
    .limit(1)
    .maybeSingle();
  if (!form) return { ok: false, error: "This form isn't available right now." };

  // THE PLAYBOOK THE CUSTOMER ACTUALLY ANSWERED (audit 7): the public form serves
  // publicIntakeNeeds(pb) — internal-only needs pruned, their `when` clauses stripped — so
  // clearing against the UN-pruned playbook destroyed answers to questions the pruned form
  // deliberately shows unconditionally. Prune HERE too, or the two doors disagree forever.
  const pbFull = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  const pb = { ...pbFull, needs: publicIntakeNeeds(pbFull) };
  // COERCE, THEN CLEAR — in that order, and the clear is not optional. The client hides a
  // conditional follow-up when its trigger changes, but `set` only ever merges keys, so answering
  // "do you have plans? yes", typing the detail, then switching to "no" still SUBMITTED the
  // detail. The lead then read "Plans: No" and "About the plans: <text>" in the same summary. The
  // inspector has always cleared on save; this door didn't.
  let answers = clearInapplicable(pb, coerceByPlaybook(pb, (payload?.answers ?? {}) as Answers));

  // FILE PATHS ARE CLIENT-SUPPLIED, so they are filtered here and nowhere else. coerceByPlaybook
  // proved the SHAPE (a list of path-ish strings); only this boundary knows the org, and a caller
  // is perfectly capable of handing back another tenant's folder or a path it never uploaded to.
  // Anything outside this org's own intake prefix is dropped silently — there is no legitimate way
  // for a customer's browser to produce one.
  for (const n of pb.needs) {
    if (n.slot?.type !== "file") continue;
    const claimed = answers[n.key];
    if (!Array.isArray(claimed)) continue;
    const mine = claimed.filter((p): p is string => typeof p === "string" && isOwnIntakePath(orgId, p));
    answers = { ...answers, [n.key]: mine.length ? mine : null };
  }

  // A readable summary for the Leads board — label: answer, one per line, skipping blanks.
  // A file answer becomes the FILE NAMES, not the storage paths: the office wants to know that
  // "Plans.pdf" arrived, and a raw path in an email is noise.
  const lines = pb.needs
    .map((n) => {
      const v = answers[n.key];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return null;
      if (n.slot?.type === "file" && Array.isArray(v))
        return `${n.label}: ${v.filter((x): x is string => typeof x === "string").map(uploadDisplayName).join(", ")}`;
      return `${n.label}: ${Array.isArray(v) ? v.join(", ") : String(v)}`;
    })
    .filter(Boolean) as string[];

  const hasPlans = String(answers["has_plans"] ?? "").toLowerCase() === "yes";
  try {
    await createTriagedInquiry(supabase, orgId, {
    name,
    phone: phone || null,
    email: email || null,
    address: address || null,
    city,
    state,
    zip,
    contact_address: contactAddress || null,
    contact_city: contactCity,
    contact_state: contactState,
    contact_zip: contactZip,
    message: lines.join("\n").slice(0, 4000) || null,
    source: "intake",
    // Generic triage: plans → ready to quote; a written description → measure-and-talk; nothing
    // else claimed. No estimate total, so the $-gate and instant pricing never fire here.
    intake: {
      projectType: null,
      hasPlans,
      hasDimensions: false,
      needsDesignHelp: !hasPlans,
      estimateTotal: null,
      contact: { name, phone: phone || null, email: email || null, address: contactAddress || null },
    },
    intakeJson: { intake_answers: answers },
    // Caller-authored content with no size-verified total: a stranger must not be able to talk
    // their way onto the contractor's calendar. Booking stays a one-tap action on the Leads board.
      autoBookInspection: false,
    });
  } catch {
    return { ok: false, error: "Something went wrong — please call us instead." };
  }
  return { ok: true };
}
