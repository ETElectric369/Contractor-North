"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";
import { getActionItems } from "@/lib/action-items/query";
import { dispatchAction } from "@/lib/action-items/dispatch";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { toIso } from "@/lib/forms";
import type { Affordance } from "@/lib/action-items/types";

export type VoiceResult = { ok: boolean; message: string; navigate?: string };

const ROUTES: Record<string, string> = {
  "/planner": "My Day",
  "/jobs": "Jobs",
  "/schedule": "Scheduler",
  "/schedule?view=calendar": "Calendar",
  "/schedule?view=appointments": "Appointments",
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
export async function runVoiceCommand(transcript: string): Promise<VoiceResult> {
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
  const [items, { data: peopleRows }] = await Promise.all([
    getActionItems({ todayStr: today, isStaff, userId: user.id }),
    supabase.from("profiles").select("id, full_name").eq("active", true),
  ]);
  const people = (peopleRows ?? []) as { id: string; full_name: string | null }[];

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
  "intent": "create_task" | "create_appointment" | "create_customer" | "navigate" | "act_on_item" | "none",
  "params": { ... },
  "speak": a short confirmation to read back (one sentence)
}

Params by intent:
- create_task: { "title": string, "category": "office" | "operations" | "sales" }   (default "operations")
- create_appointment: { "title": string, "type": "appointment" | "inspection", "date": "YYYY-MM-DD", "time": "HH:MM" 24h (default "08:00") }
- create_customer: { "name": string, "phone": string|null }
- navigate: { "path": one of the known paths below }
- act_on_item: { "item_id": EXACT id from the "needs action" list, "verb": "do"|"schedule"|"assign"|"convert"|"snooze"|"dismiss", "date": "YYYY-MM-DD" (for schedule/snooze), "assignee_name": string (for assign — match a team member), "target": "estimate"|"quote"|"job"|"customer" (for convert) }
- none: {}   (when unclear or unsupported — explain briefly in "speak")

Use act_on_item when the user refers to one of their EXISTING items below — finishing/marking done (do), putting it on the calendar (schedule), giving it to someone (assign), pushing it later (snooze), advancing an inquiry (convert), or removing it (dismiss). Match the item by its title.

Today is ${today}. Resolve relative dates like "tomorrow" or "next Tuesday" to YYYY-MM-DD.
Known pages (path — name):
${routeList}

Items that currently need action:
${inboxList}
Team members (for assign): ${teamList}`,
      messages: [{ role: "user", content: text }],
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
      if (!title) return { ok: false, message: "What should the task say?" };
      const category = ["office", "operations", "sales"].includes(p.category) ? p.category : "operations";
      const { error } = await supabase.from("tasks").insert({ title, category, status: "open", created_by: user.id });
      if (error) return { ok: false, message: error.message };
      revalidatePath("/tasks");
      return { ok: true, message: speak, navigate: "/tasks" };
    }

    if (intent === "create_appointment") {
      const title = String(p.title ?? "").trim();
      const startIso = toIso(String(p.date ?? ""), String(p.time ?? "08:00"));
      if (!title || !startIso) return { ok: false, message: "I need a title and a date for that appointment." };
      const type = p.type === "inspection" ? "inspection" : "appointment";
      const { error } = await supabase.from("appointments").insert({ type, title, starts_at: startIso, status: "scheduled", created_by: user.id });
      if (error) return { ok: false, message: error.message };
      revalidatePath("/schedule");
      return { ok: true, message: speak, navigate: "/schedule?view=appointments" };
    }

    if (intent === "create_customer") {
      const name = String(p.name ?? "").trim();
      if (!name) return { ok: false, message: "What's the customer's name?" };
      const phone = p.phone ? String(p.phone) : null;
      const { error } = await supabase.from("customers").insert({ name, phone, status: "active", created_by: user.id });
      if (error) return { ok: false, message: error.message };
      revalidatePath("/crm");
      return { ok: true, message: speak, navigate: "/crm" };
    }

    if (intent === "act_on_item") {
      const item = items.find((it) => it.id === String(p.item_id ?? ""));
      if (!item) return { ok: false, message: "I couldn't find that item — try saying its name again." };
      const verb = String(p.verb ?? "") as Affordance;
      const payload: { date?: string; assignee?: string; target?: "customer" | "quote" | "estimate" | "job" } = {};
      if (p.date) payload.date = String(p.date);
      if (p.target) payload.target = String(p.target) as typeof payload.target;
      if (p.assignee_name) {
        const want = String(p.assignee_name).toLowerCase();
        payload.assignee = people.find((pp) => (pp.full_name ?? "").toLowerCase().includes(want))?.id;
      }
      const res = await dispatchAction({ kind: item.kind, id: item.id, verb, payload });
      if (!res.ok) return { ok: false, message: res.error ?? "I couldn't do that one." };
      // Land on My Day so the spoken result is visible on screen (hands-free).
      return { ok: true, message: speak, navigate: "/planner" };
    }

    if (intent === "navigate") {
      const path = String(p.path ?? "");
      if (ROUTES[path]) return { ok: true, message: speak || `Opening ${ROUTES[path]}.`, navigate: path };
      return { ok: false, message: "I'm not sure which page you mean." };
    }

    return { ok: false, message: speak || "I can add tasks, appointments, customers, or open a page — try again." };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Something went wrong." };
  }
}
