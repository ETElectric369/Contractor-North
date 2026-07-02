"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getActionItems } from "@/lib/action-items/query";
import { dispatchAction } from "@/lib/action-items/dispatch";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { toIso } from "@/lib/forms";
import { executeAction } from "@/lib/actions/execute";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import type { Affordance } from "@/lib/action-items/types";

/** A pending field action that needs a spoken "yes" before it runs. */
export type VoiceConfirm = { name: string; input: Record<string, unknown>; speakDone: string };
/** A money action that additionally needs a WebAuthn (Face ID) tap — the client runs the
 *  assertion against `options` and re-calls confirmVoiceAction with it. */
export type VoiceStepUp = { name: string; input: Record<string, unknown>; options: unknown };
export type VoiceResult = { ok: boolean; message: string; navigate?: string; confirm?: VoiceConfirm; stepUp?: VoiceStepUp; needMore?: boolean };
/** A turn in the spoken back-and-forth, so a follow-up answer is read in context. */
export type VoiceTurn = { role: "user" | "assistant"; content: string };

// The ONLY registry actions voice may execute (safe, self-scoped field work). The
// server-side role gate in executeAction is the real enforcement; this is belt-and-
// suspenders so voice can never reach a money-/customer-facing or destructive verb.
const VOICE_ALLOWED = new Set(["time.clockIn", "time.clockOut", "time.addEntry", "bill.create"]);

const ROUTES: Record<string, string> = {
  "/planner": "My Day",
  "/jobs": "Jobs",
  "/schedule": "Scheduler",
  "/schedule?view=calendar": "Calendar",
  // Appointments live on the schedule calendar now — the week view is the browse door.
  "/schedule?view=week": "Appointments",
  "/crm": "Customers",
  "/quotes": "Quotes",
  "/billing": "Invoices",
  "/bills": "Bills & Purchasing",
  "/timeclock": "Timeclock",
  "/tasks": "Tasks",
  "/recurring": "Recurring",
  "/materials": "Material Lists",
  "/organize": "Organize My",
  "/activity": "Activity",
  "/schedule?view=map": "Map",
  "/settings": "Settings",
};

function jsonFrom(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("no json");
  return JSON.parse(body.slice(s, e + 1));
}

/**
 * Turn a spoken command into a single bounded action. Claude classifies the
 * intent; we execute only a whitelisted, non-destructive set (create task /
 * appointment / customer, or navigate). Everything else just speaks back.
 */
export async function runVoiceCommand(transcript: string, history: VoiceTurn[] = []): Promise<VoiceResult> {
  const text = transcript.trim();
  if (!text) return { ok: false, message: "I didn't catch that." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "You're signed out." };

  // Context for acting on EXISTING items hands-free: the current inbox + the team.
  const { data: prof } = await supabase.from("profiles").select("role, org_id").eq("id", user.id).maybeSingle();
  const isStaff = ["owner", "admin", "office"].includes((prof as any)?.role ?? "");
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", (prof as any)?.org_id ?? "")
    .maybeSingle();
  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";
  const today = todayStrInTz(tz);
  const [items, { data: peopleRows }, { data: jobRows }] = await Promise.all([
    getActionItems({ todayStr: today, isStaff, userId: user.id }),
    supabase.from("profiles").select("id, full_name").eq("active", true),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .in("status", ACTIVE_JOB_STATUSES)
      .order("scheduled_start", { ascending: true, nullsFirst: false })
      .limit(40),
  ]);
  const people = (peopleRows ?? []) as { id: string; full_name: string | null }[];
  const jobs = (jobRows ?? []) as { id: string; job_number: string; name: string }[];
  const jobsById = new Map(jobs.map((j) => [j.id, `${j.job_number} — ${j.name}`]));
  const jobList = jobs.length ? jobs.map((j) => `- id=${j.id}: "${j.job_number} ${j.name}"`).join("\n") : "(no active jobs)";

  const routeList = Object.entries(ROUTES).map(([p, n]) => `${p} — ${n}`).join("\n");
  const inboxList = items.length
    ? items
        .map((i) => `- id=${i.id} kind=${i.kind}: "${i.title}"${i.subtitle ? ` (${i.subtitle})` : ""}${i.who ? ` [${i.who}]` : ""}`)
        .join("\n")
    : "(nothing needs action right now)";
  const teamList = people.map((p) => p.full_name).filter(Boolean).join(", ") || "(none)";

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 500,
      system: `You turn a contractor's spoken command into ONE action. Output ONLY a JSON object, no prose:
{
  "intent": "create_task" | "create_appointment" | "create_customer" | "navigate" | "act_on_item" | "open_job" | "clock_in" | "clock_out" | "log_time" | "add_cost" | "none",
  "params": { ... },
  "speak": a short confirmation to read back (one sentence)
}

Params by intent:
- create_task: { "title": string, "category": "office" | "operations" | "sales" }   (default "operations")
- create_appointment: { "title": string, "type": "appointment" | "inspection", "date": "YYYY-MM-DD", "time": "HH:MM" 24h (default "08:00") }
- create_customer: { "name": string, "phone": string|null }
- navigate: { "path": one of the known paths below }
- act_on_item: { "item_id": EXACT id from the "needs action" list, "verb": "do"|"schedule"|"assign"|"convert"|"snooze"|"dismiss", "date": "YYYY-MM-DD" (for schedule/snooze), "assignee_name": string (for assign — match a team member), "target": "estimate"|"quote"|"job"|"customer" (for convert) }
- open_job: { "job_id": EXACT id from your jobs below }   ("open the Smith job", "pull up Tao Zhu", "edit J-12")
- clock_in: { "job_id": EXACT id from your jobs below, or null for no job }   ("clock me in", "start the clock on the Smith job")
- clock_out: { "miles": round-trip job miles as a number, or null }   ("clock me out", "clock out, 22 miles")
- log_time: { "hours": number, "job_id": id from your jobs or null }   ("log 2 hours on the Smith job")
- add_cost: { "amount": dollars as a number, "supplier": who it was paid to (default "Cash"), "job_id": id from your jobs or null }   ("add a 40 dollar Home Depot cost to the Smith job")
- none: {}   (when unclear or unsupported — explain briefly in "speak")

Use act_on_item when the user refers to one of their EXISTING items below — finishing/marking done (do), putting it on the calendar (schedule), giving it to someone (assign), pushing it later (snooze), advancing an inquiry (convert), or removing it (dismiss). Match the item by its title.

Today is ${today}. Resolve relative dates like "tomorrow" or "next Tuesday" to YYYY-MM-DD.
Known pages (path — name):
${routeList}

Items that currently need action:
${inboxList}
Team members (for assign): ${teamList}

Your active jobs (for open_job / clock_in / log_time / add_cost). Speech recognition MANGLES names — match PHONETICALLY by how it SOUNDS, not exact spelling (e.g. "town zoo" → "Tao Zhu"; "sue waltz" → the Waltz job; "tee tee pee" → "TTP"). Pick the closest-sounding job; only return null when nothing is remotely close:
${jobList}

If this is a follow-up (earlier turns are shown), COMBINE everything said so far into ONE complete action — e.g. you asked "how many hours?" and they now say "two", so emit the full log_time. Carry over the job/customer/title already mentioned earlier; don't ask again for something already given.`,
      messages: [
        ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: text },
      ],
    });
    const block = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    parsed = jsonFrom(block?.text ?? "");
  } catch (e: any) {
    return { ok: false, message: e?.message?.includes("ANTHROPIC_API_KEY") ? "Voice commands need the AI key set." : "I couldn't understand that command." };
  }

  const intent = String(parsed?.intent ?? "none");
  const p = parsed?.params ?? {};
  const speak = typeof parsed?.speak === "string" ? parsed.speak : "Done.";

  try {
    if (intent === "create_task") {
      const title = String(p.title ?? "").trim();
      if (!title) return { ok: false, message: "What should the task say?", needMore: true };
      const category = ["office", "operations", "sales"].includes(p.category) ? p.category : "operations";
      // Through the chokepoint (audit + role gate + source tag), not a bespoke insert.
      const res = await executeAction("task.create", { title, category }, { source: "voice" });
      if (!res.ok) return { ok: false, message: res.error ?? "Couldn't create that task." };
      revalidatePath("/tasks");
      return { ok: true, message: speak, navigate: "/tasks" };
    }

    if (intent === "create_appointment") {
      const title = String(p.title ?? "").trim();
      const startIso = toIso(String(p.date ?? ""), String(p.time ?? "08:00"));
      if (!title || !startIso) return { ok: false, message: "I need a title and a date for that appointment.", needMore: true };
      const type = p.type === "inspection" ? "inspection" : "appointment";
      const res = await executeAction("appointment.create", { title, type, starts_at: startIso }, { source: "voice" });
      if (!res.ok) return { ok: false, message: res.error ?? "Couldn't create that appointment." };
      revalidatePath("/schedule");
      // Land on the day the visit was booked for (toIso guaranteed p.date is YYYY-MM-DD).
      return { ok: true, message: speak, navigate: `/schedule?view=day&date=${p.date}` };
    }

    if (intent === "create_customer") {
      const name = String(p.name ?? "").trim();
      if (!name) return { ok: false, message: "What's the customer's name?", needMore: true };
      const phone = p.phone ? String(p.phone) : null;
      const res = await executeAction("customer.create", { name, phone }, { source: "voice" });
      if (!res.ok) return { ok: false, message: res.error ?? "Couldn't create that customer." };
      revalidatePath("/crm");
      return { ok: true, message: speak, navigate: "/crm" };
    }

    if (intent === "act_on_item") {
      const item = items.find((it) => it.id === String(p.item_id ?? ""));
      if (!item) return { ok: false, message: "I couldn't find that item — try saying its name again.", needMore: true };
      const verb = String(p.verb ?? "") as Affordance;
      // "Dismiss" hard-deletes a task/inquiry — NEVER by voice. Direct to the screen,
      // where the ✗ now asks to confirm. Voice keeps to the non-destructive verbs.
      if (verb === "dismiss") {
        return { ok: false, message: `Dismissing deletes "${item.title}". Tap it on screen to confirm — I won't delete by voice.` };
      }
      const payload: { date?: string; assignee?: string; target?: "customer" | "quote" | "estimate" | "job" } = {};
      if (p.date) payload.date = String(p.date);
      if (p.target) payload.target = String(p.target) as typeof payload.target;
      if (p.assignee_name) {
        const want = String(p.assignee_name).toLowerCase();
        payload.assignee = people.find((pp) => (pp.full_name ?? "").toLowerCase().includes(want))?.id;
      }
      const res = await dispatchAction({ kind: item.kind, id: item.id, verb, payload, source: "voice" });
      if (!res.ok) return { ok: false, message: res.error ?? "I couldn't do that one." };
      // Land on My Day so the spoken result is visible on screen (hands-free).
      return { ok: true, message: speak, navigate: "/planner" };
    }

    if (intent === "open_job") {
      const jobId = p.job_id && jobsById.has(String(p.job_id)) ? String(p.job_id) : null;
      if (!jobId) return { ok: false, message: "I couldn't tell which job you meant — say its name or number again.", needMore: true };
      return { ok: true, message: speak || `Opening ${jobsById.get(jobId)}.`, navigate: `/jobs/${jobId}` };
    }

    // Field actions DON'T execute here — they come back as a pending `confirm`, and
    // the client reads it back and waits for a spoken "yes" before running it.
    if (intent === "clock_in") {
      const jobId = p.job_id && jobsById.has(String(p.job_id)) ? String(p.job_id) : null;
      const label = jobId ? jobsById.get(jobId) : null;
      return {
        ok: true,
        message: label ? `Clock you in on ${label} — say yes to confirm.` : "Clock you in — say yes to confirm.",
        confirm: { name: "time.clockIn", input: { job_id: jobId, job_code: null }, speakDone: "You're clocked in." },
      };
    }

    if (intent === "clock_out") {
      const miles = Number(p.miles) > 0 ? Number(p.miles) : undefined;
      return {
        ok: true,
        message: miles ? `Clock you out with ${miles} miles — say yes to confirm.` : "Clock you out — say yes to confirm.",
        confirm: { name: "time.clockOut", input: { miles }, speakDone: "You're clocked out." },
      };
    }

    if (intent === "log_time") {
      const hours = Number(p.hours);
      if (!(hours > 0)) return { ok: false, message: "How many hours should I log?", needMore: true };
      const jobId = p.job_id && jobsById.has(String(p.job_id)) ? String(p.job_id) : null;
      const label = jobId ? jobsById.get(jobId) : null;
      const now = Date.now();
      const clockIn = new Date(now - hours * 3_600_000).toISOString();
      const clockOut = new Date(now).toISOString();
      const h = hours === 1 ? "hour" : "hours";
      return {
        ok: true,
        message: `Log ${hours} ${h}${label ? ` on ${label}` : ""} — say yes to confirm.`,
        confirm: {
          name: "time.addEntry",
          input: { clock_in: clockIn, clock_out: clockOut, job_id: jobId, lunch_minutes: 0, notes: "" },
          speakDone: `Logged ${hours} ${h}.`,
        },
      };
    }

    if (intent === "add_cost") {
      // bill.create is staff-only — don't walk a tech through the whole confirm just
      // to reject it at execution.
      if (!isStaff) return { ok: false, message: "Recording costs is office-only." };
      const amount = Number(p.amount);
      if (!(amount > 0)) return { ok: false, message: "How much was the cost?", needMore: true };
      const supplier = (String(p.supplier ?? "").trim() || "Cash").slice(0, 80);
      const jobId = p.job_id && jobsById.has(String(p.job_id)) ? String(p.job_id) : null;
      const label = jobId ? jobsById.get(jobId) : null;
      return {
        ok: true,
        message: `Add a $${amount.toFixed(2)} cost from ${supplier}${label ? ` on ${label}` : ""} — say yes to confirm.`,
        confirm: {
          name: "bill.create",
          input: { supplier, amount, job_id: jobId, status: "unpaid", bill_number: "", notes: "", category: "Materials", bill_date: today },
          speakDone: "Cost added.",
        },
      };
    }

    if (intent === "navigate") {
      const path = String(p.path ?? "");
      if (ROUTES[path]) return { ok: true, message: speak || `Opening ${ROUTES[path]}.`, navigate: path };
      return { ok: false, message: "I'm not sure which page you mean.", needMore: true };
    }

    return { ok: false, message: speak || "I can add tasks, appointments, customers, clock you in or out, log time, add a cost, or open a page — try again.", needMore: true };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Something went wrong." };
  }
}

/**
 * Run a voice field action — ONLY after the user said "yes" to the spoken confirm.
 * Whitelisted to the safe field verbs; executeAction still enforces the per-action
 * role gate server-side (so e.g. a tech can't add a cost even if it's offered).
 */
export async function confirmVoiceAction(
  name: string,
  input: Record<string, unknown>,
  stepUpAssertion?: unknown,
): Promise<VoiceResult> {
  if (!VOICE_ALLOWED.has(name)) return { ok: false, message: "That action can't be done by voice." };
  // The spoken "yes" the client already collected IS the consent — pass it so the
  // executeAction confirm gate (e.g. bill.create = financial) lets it through.
  const res = await executeAction(name, input, { source: "voice", confirmed: true, stepUpAssertion });
  // A money action from an enrolled user needs the Face ID tap — hand the options back so
  // the client runs it and re-calls with the assertion.
  if (res.needsStepUp) {
    return { ok: false, message: "Confirm with Face ID to finish.", stepUp: { name, input, options: res.stepUpOptions } };
  }
  if (!res.ok) return { ok: false, message: res.error ? `Sorry — ${res.error}` : "That didn't work." };
  revalidatePath("/timeclock");
  revalidatePath("/planner");
  if (name === "bill.create") revalidatePath("/bills");
  return { ok: true, message: "Done.", navigate: name === "bill.create" ? "/bills" : "/timeclock" };
}
