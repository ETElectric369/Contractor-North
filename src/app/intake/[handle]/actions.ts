"use server";

import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { createTriagedInquiry } from "@/lib/inquiries/create-triaged-inquiry";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { playbookForForm } from "@/lib/playbook/parse";
import type { Answers } from "@/lib/playbook/types";

export interface IntakePayload {
  /** Honeypot — a real person never fills it. */
  hp?: string;
  contact: { name?: string; phone?: string; email?: string; address?: string };
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
  const address = String(payload?.contact?.address ?? "").trim().slice(0, 300);

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

  const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  const answers = coerceByPlaybook(pb, (payload?.answers ?? {}) as Answers);

  // A readable summary for the Leads board — label: answer, one per line, skipping blanks.
  const lines = pb.needs
    .map((n) => {
      const v = answers[n.key];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return null;
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
      contact: { name, phone: phone || null, email: email || null, address: address || null },
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
