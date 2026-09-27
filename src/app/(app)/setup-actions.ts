"use server";
import { recordAiUsage, aiSpendExceeded, currentOrgId } from "@/lib/ai-cost";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runHear, type HearRun } from "@/lib/playbook/hear-run";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { applyFills, clearInapplicable, isAnswered } from "@/lib/playbook/resolve";
import { CONVERSE_SYSTEM, conversePrompt, fallbackSay, parseSpoken } from "@/lib/onboarding/converse";
import { asRegister, clampHumor, toneDirective } from "@/lib/nort/tone";
import { playbookForForm } from "@/lib/playbook/parse";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { orgTrade } from "@/lib/org-trade";
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

type Supa = Awaited<ReturnType<typeof createClient>>;

/**
 * THE NORT SWITCH GOVERNS THE SETUP AI TOO (0352). The chat route answers in words when Nort is off,
 * but the setup's three model calls (setup:converse, setup:talk, setup:draft) never asked, so a
 * company that switched Nort off still paid a model to phrase its setup. With Nort off, setup is the
 * plain questions: no model call, and nothing here says it's Nort.
 *
 * Read for the caller's own company (RLS scopes it; the org id pins it when we have one). A read
 * that fails or finds nothing is UNREAD, and calls no model either: the careful answer. But it is
 * never said as "Nort is off". The tour only runs with Nort on and has no plain boxes of its own,
 * so a blip in one read told a company with Nort on to type into boxes that refused the same way.
 * The draft door falls back to the plain questions (it has them); the talk doors say "try again".
 */
type NortSwitch = "on" | "off" | "unread";
async function nortSwitch(supabase: Supa, orgId: string | null): Promise<NortSwitch> {
  const q = supabase.from("organizations").select("settings");
  const { data, error } = await (orgId ? q.eq("id", orgId) : q.limit(1)).maybeSingle();
  if (error || !data) return "unread";
  return featureOn(getOrgSettings((data as { settings?: unknown }).settings).features, "nort") ? "on" : "off";
}

/** What a setup AI door says when Nort is off. Plain, and never "I". */
const NORT_OFF_SETUP = "Nort is off for your company, so type your answers into the boxes.";

/** What a setup talk door says when the switch couldn't be read. Plain, and never "I". */
const SWITCH_UNREAD = "Couldn't check your company's settings just now. Try that again.";

/** The refusal for a talk door when the switch isn't on: off says off, unread says try again. */
const notOnSays = (s: NortSwitch) => (s === "off" ? NORT_OFF_SETUP : SWITCH_UNREAD);

/** Does the company have a trade on file (the sign-up key, or its own words)? Read for its own org. */
async function tradeOnFile(supabase: Supa): Promise<boolean> {
  const orgId = await currentOrgId();
  const q = supabase.from("organizations").select("settings");
  const { data } = await (orgId ? q.eq("id", orgId) : q.limit(1)).maybeSingle();
  const t = orgTrade(getOrgSettings((data as { settings?: unknown } | null)?.settings));
  return Boolean(t.key || t.label);
}

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
  // Nort off: no model call and no Nort voice. The boxes still take a typed answer.
  const orgId = await currentOrgId();
  const sw = await nortSwitch(supabase, orgId);
  if (sw !== "on") return { ok: false, error: notOnSays(sw) };

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
  if (await aiSpendExceeded(orgId))
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
    void recordAiUsage({ orgId, model: DEFAULT_MODEL, surface: "setup:converse", usage: resp.usage as never });
    raw = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
  } catch {
    // A model that is down must not become an error message about a model being down.
    return { ok: true, say: fallbackSay(need, false, first), answers: known, filled: [] };
  }

  const spoken = parseSpoken(raw);
  // THE QUESTION ON SCREEN CAN BE ANSWERED AGAIN. The tour hands in what is already on file (the
  // trade picked at sign-up, the name on the account) and promises "say it your way and I'll use
  // your words" / "say a different name and I'll take that instead". FILL HOLES NEVER OVERWRITE A
  // HAND refused every such answer, so Nort said the new words back while the old ones were kept
  // and saved. The person answering the question in front of them IS the hand: that one key is
  // opened for this turn, through the same gate, and put back as it was if nothing lands in it.
  const onScreen = need?.key ?? null;
  const open = onScreen && spoken.fills.some((f) => f.key === onScreen) ? { ...known, [onScreen]: null } : known;
  // SAME GATE AS EVER: provenance, no overwriting a hand, no undeclared keys.
  const { answers: applied, rejected } = applyFills(SETUP_PLAYBOOK, open, spoken.fills, text);
  const next: Answers = { ...applied };
  if (onScreen && open !== known && !isAnswered(applied[onScreen])) {
    if (onScreen in known) next[onScreen] = known[onScreen];
    else delete next[onScreen];
  }
  const filled = spoken.fills
    .filter((f) => !rejected.includes(f))
    .map((f) => SETUP_PLAYBOOK.needs.find((n) => n.key === f.key)?.label ?? f.key);

  // THE ANSWERS THAT ACTUALLY SURVIVE — computed BEFORE `filled` is reported (audit 8).
  // clearInapplicable drops answers whose question no longer applies (skip the city question
  // and "I cover all of Nevada County" is inapplicable), so Nort said "got it — how far you go"
  // and confirmed a value that had already been nulled on its way out the door.
  const survived = clearInapplicable(SETUP_PLAYBOOK, coerceByPlaybook(SETUP_PLAYBOOK, next));
  const landed = filled.filter((label) =>
    SETUP_PLAYBOOK.needs.some(
      (n) => (n.label ?? n.key) === label && survived[n.key] !== null && survived[n.key] !== undefined && String(survived[n.key]).trim() !== "",
    ),
  );

  return {
    ok: true,
    say: spoken.say || fallbackSay(need, landed.length > 0, first),
    answers: survived,
    filled: landed,
  };
}

/** Setting a company up is the same shape as walking a job — same playbook, same extraction. */
export async function hearSetup(answers: Answers, transcript: string): Promise<HearRun> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  // Nort off: the setup questions are typed into their boxes; nothing is sent to a model.
  const orgId = await currentOrgId();
  const sw = await nortSwitch(supabase, orgId);
  if (sw !== "on") return { ok: false, error: notOnSays(sw) };
  return runHear(SETUP_PLAYBOOK, answers, transcript, { orgId, surface: "setup:talk" });
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
  const { data: me } = await supabase.from("profiles").select("role, org_id, active").eq("id", user.id).maybeSingle();
  const role = (me as { role?: string } | null)?.role;
  // A deactivated seat is refused here too (audit v921 critical — see staff-guard.ts).
  if (!role || !["owner", "admin", "office"].includes(role) || (me as { active?: boolean | null } | null)?.active === false)
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
 * say what a wrong answer costs. And it SAVES NOTHING of the draft: this returns a draft to argue
 * with. The one write is the starter SHEET the draft is read from, below, and only when there is
 * none: the same seed saveSetup plants when the trade is named.
 */
export async function draftMyPlaybook(): Promise<DraftResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const readSheet = async () =>
    (
      await supabase
        .from("forms")
        .select("id, schema, playbook")
        .eq("is_inspection", true)
        .order("created_at")
        .limit(1)
        .maybeSingle()
    ).data;
  let form = await readSheet();
  // A TRADE ON FILE WITH NO SHEET IS NOT "SAY WHAT TRADE YOU'RE IN". Only saveSetup seeded the
  // sheet, and only when it wrote the trade's words; sign-up (0352) keeps just the key. The
  // questions step now shows that key's words in the Trade box, so pressing Next with nothing
  // edited skipped the save and landed here, told to name a trade that was on screen. The key
  // picks the starter (createStarterInspectionSheet reads it), so seed it here and carry on.
  if (!form && (await tradeOnFile(supabase))) {
    const seeded = await createStarterInspectionSheet();
    if (seeded.ok) form = await readSheet();
  }
  if (!form) return { ok: false, error: "Say what trade you're in first — that's what builds your questions." };

  const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
  if (!pb.needs.length) return { ok: false, error: "That walk-through has no questions in it yet." };
  // THE PLAIN QUESTIONS, UNDRAFTED, whenever a model shouldn't be paid to draft them: no key, Nort
  // switched off (0352), or this month's ceiling reached (talkSetup's own escape, which this door
  // never had). Their own questions and any why lines already written come back as they are.
  const undrafted: DraftResult = { ok: true, formId: (form as { id: string }).id, needs: pb.needs, wasDrafted: false };
  if (!process.env.ANTHROPIC_API_KEY) return undrafted;
  const orgId = await currentOrgId();
  if ((await nortSwitch(supabase, orgId)) !== "on") return undrafted;
  if (await aiSpendExceeded(orgId)) return undrafted;

  const orgQ = supabase.from("organizations").select("settings");
  const { data: org } = await (orgId ? orgQ.eq("id", orgId) : orgQ.limit(1)).maybeSingle();
  const s = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const about = aboutFromSetup({
    trade: orgTrade(s).label,
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
    void recordAiUsage({ orgId, model: DEFAULT_MODEL, surface: "setup:draft", usage: resp.usage as never });
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
 * have a lot of it setup to learn the system." Per person (0180), never a gate, re-takeable
 * forever from Take The Setup Again (under Search Or Ask; under Help, behind the initials, with
 * Nort off).
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

/**
 * RECORD A LESSON OFFER (0197) — pressed "Show Me" or "No Thanks", both count. The inline offer
 * strip shows only while the key is absent, so recording the decline is what stops it nagging;
 * replay always lives under Show Me How (Search Or Ask; Help, behind the initials, with Nort
 * off), so declining loses nothing. Read-modify-write on the
 * caller's own row (RLS scopes it), and duplicates are dropped so a double-tap can't grow the
 * array forever.
 */
export async function markLessonSeen(key: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const k = String(key).slice(0, 40);
  const { data: prof } = await supabase.from("profiles").select("lessons_seen").eq("id", user.id).maybeSingle();
  const seen = Array.isArray((prof as { lessons_seen?: unknown } | null)?.lessons_seen)
    ? ((prof as { lessons_seen: unknown[] }).lessons_seen as unknown[]).map(String)
    : [];
  if (seen.includes(k)) return { ok: true };
  const { error } = await supabase
    .from("profiles")
    .update({ lessons_seen: [...seen, k] })
    .eq("id", user.id);
  if (error) return { ok: false };
  revalidatePath("/settings");
  return { ok: true };
}
