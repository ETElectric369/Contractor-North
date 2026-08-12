"use server";
import { recordAiUsage, aiSpendExceeded, currentOrgId } from "@/lib/ai-cost";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runHear, type HearRun } from "@/lib/playbook/hear-run";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { applyFills, clearInapplicable } from "@/lib/playbook/resolve";
import { CONVERSE_SYSTEM, conversePrompt, fallbackSay, parseSpoken } from "@/lib/onboarding/converse";
import { asRegister, clampHumor, toneDirective } from "@/lib/nort/tone";
import { playbookForForm } from "@/lib/playbook/parse";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getOrgSettings } from "@/lib/org-settings";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { aboutFromSetup, applyDraft, draftRequest, DRAFT_SYSTEM } from "@/lib/onboarding/draft-playbook";
import { updateOrgSettings } from "./settings/actions";
import { createStarterInspectionSheet } from "./forms/actions";
import type { Answers, Need } from "@/lib/playbook/types";

type Result = { ok: true; seededSheet: boolean } | { ok: false; error: string };

export type DraftResult =
  | { ok: true; formId: string; needs: Need[]; wasDrafted: boolean }
  | { ok: false; error: string };

export type TalkResult =
  | { ok: true; say: string; answers: Answers; filled: string[] }
  | { ok: false; error: string };

/**
 * A TURN OF CONVERSATION during setup — Nort replies AND fills, in one call.
 *
 * Erik: "we are looking for an interactive dialogue not a dictation based response then frozen …
 * walked through and talked through like a 5 year old kid because thats how they are going to
 * learn." He said "Hello. That works. What's next?" and was told his words couldn't be turned into
 * an answer. Correct as extraction, wrong as behaviour: the thing being taught in that moment is
 * that Nort is somebody you can talk to, and an error message teaches the opposite.
 *
 * THE GATE IS UNCHANGED. Whatever the model proposes still goes through applyFills — the
 * provenance rule, and FILL HOLES NEVER OVERWRITE A HAND — and then through coerceByPlaybook, so
 * a friendlier voice buys exactly zero extra trust. Only the REPLY is new.
 */
export async function talkSetup(needKey: string | null, answers: Answers, said: string): Promise<TalkResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const text = String(said ?? "").trim();
  if (!text) return { ok: false, error: "Nothing to go on yet." };
  if (text.length > 4000) return { ok: false, error: "That's a lot at once — break it up a bit." };

  const known = coerceByPlaybook(SETUP_PLAYBOOK, answers);
  const need = needKey ? SETUP_PLAYBOOK.needs.find((n) => n.key === needKey) : undefined;
  // HOW THIS PERSON WANTS TO BE TALKED TO (0183). The tour is where somebody meets Nort, so it is
  // the last place he should sound like a form — and the first place a joke needs landing.
  const { data: me } = await supabase
    .from("profiles")
    .select("nort_humor, nort_register")
    .eq("id", user.id)
    .maybeSingle();
  const tone = toneDirective(
    clampHumor((me as { nort_humor?: unknown } | null)?.nort_humor),
    asRegister((me as { nort_register?: unknown } | null)?.nort_register),
  );
  const first = typeof known.full_name === "string" ? known.full_name.trim().split(/\s+/)[0] : "";

  // No model configured is not a dead end — the boxes still work, and Nort still says something.
  if (!process.env.ANTHROPIC_API_KEY)
    return { ok: true, say: fallbackSay(need, false, first), answers: known, filled: [] };
  // Over the ceiling, the interview keeps WORKING — it just stops paying a model to phrase it.
  // fallbackSay is the same escape used when the API key is absent, so somebody setting their
  // company up is never blocked; they get the plain question instead of the spoken one.
  if (await aiSpendExceeded(await currentOrgId()))
    return { ok: true, say: fallbackSay(need, false, first), answers: known, filled: [] };

  let raw = "";
  try {
    const resp = await getAnthropic().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      system: [
        { type: "text", text: CONVERSE_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: tone },
      ],
      messages: [{ role: "user", content: conversePrompt(need, known, text, first) }],
    });
    void recordAiUsage({ orgId: await currentOrgId(), model: DEFAULT_MODEL, surface: "setup:converse", usage: resp.usage as never });
    raw = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
  } catch {
    // A model that is down must not become an error message about a model being down.
    return { ok: true, say: fallbackSay(need, false, first), answers: known, filled: [] };
  }

  const spoken = parseSpoken(raw);
  // SAME GATE AS EVER: provenance, no overwriting a hand, no undeclared keys.
  const { answers: next, rejected } = applyFills(SETUP_PLAYBOOK, known, spoken.fills, text);
  const filled = spoken.fills
    .filter((f) => !rejected.includes(f))
    .map((f) => SETUP_PLAYBOOK.needs.find((n) => n.key === f.key)?.label ?? f.key);

  return {
    ok: true,
    say: spoken.say || fallbackSay(need, filled.length > 0, first),
    answers: clearInapplicable(SETUP_PLAYBOOK, coerceByPlaybook(SETUP_PLAYBOOK, next)),
    filled,
  };
}

/** Setting a company up is the same shape as walking a job — same playbook, same extraction. */
export async function hearSetup(answers: Answers, transcript: string): Promise<HearRun> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  return runHear(SETUP_PLAYBOOK, answers, transcript, { orgId: await currentOrgId(), surface: "setup:talk" });
}

/**
 * COMMIT THE SETUP. This one IS executing, which is why it is a separate press.
 *
 * Filling the boxes needed no permission — it wrote into fields he could see and change. Writing
 * them onto the company is a different act: it changes what every estimate is priced against and
 * what the public page says. So hearSetup fills, and this saves, and the two are never the same
 * button. [[fill-vs-execute]].
 *
 * THE TRADE SEEDS THE SHEET. Andrew Cohen signed up with a blank trade and got a generic
 * six-question walk-through, then pressed "generate questions" and couldn't find what it made.
 * Naming the trade is what was missing, so naming it is what fixes it — here, in the same press,
 * rather than as a second thing to go and discover.
 */
export async function saveSetup(answers: Answers): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const { data: me } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  const role = (me as { role?: string } | null)?.role;
  if (!role || !["owner", "admin", "office"].includes(role))
    return { ok: false, error: "You don't have access to that." };

  // Same coercion the fill path uses — a hand-typed rate and a heard one land identically.
  const a = coerceByPlaybook(SETUP_PLAYBOOK, answers);
  const text = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");

  const name = text("full_name");
  if (name) {
    const { error } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
    if (error) return { ok: false, error: dbError(error) };
  }

  // Only send what was actually answered. A blank in this card must never blank a setting somebody
  // already filled in elsewhere — the card is a way IN, not the source of truth for the whole org.
  const patch: Record<string, unknown> = {};
  if (text("trade")) patch.trade_label = text("trade");
  if (text("city")) patch.public_city = text("city");
  if (text("service_area")) patch.service_area = text("service_area");
  if (typeof a.labor_rate === "number" && a.labor_rate > 0) patch.default_labor_rate = a.labor_rate;
  if (Object.keys(patch).length) {
    const r = await updateOrgSettings(patch);
    if (!r.ok) return { ok: false, error: r.error ?? "Couldn't save that." };
  }

  // The trade is only worth naming if something happens because of it. If they have no
  // walk-through yet, this is the moment it exists — seeded for the trade they just said.
  let seededSheet = false;
  if (patch.trade_label) {
    const { count } = await supabase
      .from("forms")
      .select("id", { count: "exact", head: true })
      .eq("is_inspection", true);
    if (!count) {
      const r = await createStarterInspectionSheet();
      seededSheet = r.ok;
    }
  }

  revalidatePath("/planner");
  revalidatePath("/settings");
  return { ok: true, seededSheet };
}

/**
 * DRAFT THE WHY LINES — the training half of the interview.
 *
 * Erik: "his onboarding isn't complete if he hasn't been guided through the training and why
 * lines." Nobody writes a good `why` from a blank box; you discover you have one by reading a
 * version that is slightly wrong. So Nort drafts every line in their trade's terms from what they
 * just told the interview, and the learning is them saying "no, that's not why I ask that."
 *
 * IT DRAFTS PROSE ONLY. Keys, slots, options and rules come from their own sheet and pass through
 * untouched (see applyDraft) — the model never gets to invent a question, only to phrase one and
 * say what a wrong answer costs. And it SAVES NOTHING: this returns a draft to argue with.
 */
export async function draftMyPlaybook(): Promise<DraftResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: form } = await supabase
    .from("forms")
    .select("id, schema, playbook")
    .eq("is_inspection", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!form) return { ok: false, error: "Say what trade you're in first — that's what builds your questions." };

  const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  if (!pb.needs.length) return { ok: false, error: "That walk-through has no questions in it yet." };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true, formId: (form as { id: string }).id, needs: pb.needs, wasDrafted: false };

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const s = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const about = aboutFromSetup({
    trade: s.trade_label,
    city: s.public_city,
    service_area: s.service_area,
    labor_rate: s.default_labor_rate,
  });

  let text = "";
  try {
    const resp = await getAnthropic().messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 4000,
      system: [{ type: "text", text: DRAFT_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: draftRequest(pb, about) }],
    });
    void recordAiUsage({ orgId: await currentOrgId(), model: DEFAULT_MODEL, surface: "setup:draft", usage: resp.usage as never });
    text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
  } catch {
    // A drafting failure is not a dead end — they can still read and write their own lines.
    return { ok: true, formId: (form as { id: string }).id, needs: pb.needs, wasDrafted: false };
  }

  let raw: unknown = null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { raw = JSON.parse(text.slice(a, b + 1)); } catch { /* leave null */ } }
  const drafted = applyDraft(pb, raw);
  return { ok: true, formId: (form as { id: string }).id, needs: drafted.needs, wasDrafted: raw !== null };
}

/**
 * "I've been shown the system."
 *
 * Deliberately a RECORDED FACT, not a derived one. A populated settings row is evidence somebody
 * typed, not evidence anybody learned — Andrew filled Vivian Builders in and the old card decided
 * he was finished, having never seen a why line. Erik: "everyone should go through it even if they
 * have a lot of it setup to learn the system." Per person (0180), never a gate, re-takeable from
 * the top bar forever.
 */
export async function finishOnboarding(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const { error } = await supabase
    .from("profiles")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/", "layout");
  return { ok: true };
}
