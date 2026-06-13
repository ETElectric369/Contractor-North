"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAnthropic, DEFAULT_MODEL } from "@/lib/anthropic";

export type VoiceResult = { ok: boolean; message: string; navigate?: string };

const ROUTES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/planner": "My Day",
  "/jobs": "Jobs",
  "/schedule": "Scheduler",
  "/calendar": "Calendar",
  "/appointments": "Appointments",
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
  "/map": "Map",
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

function toIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = /^\d{2}:\d{2}/.test(time) ? time : "08:00";
  const d = new Date(`${date}T${t}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
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

  const today = new Date().toISOString().slice(0, 10);
  const routeList = Object.entries(ROUTES).map(([p, n]) => `${p} — ${n}`).join("\n");

  let parsed: any;
  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 500,
      system: `You turn a contractor's spoken command into ONE action. Output ONLY a JSON object, no prose:
{
  "intent": "create_task" | "create_appointment" | "create_customer" | "navigate" | "none",
  "params": { ... },
  "speak": a short confirmation to read back (one sentence)
}

Params by intent:
- create_task: { "title": string, "category": "office" | "operations" | "sales" }   (default "operations")
- create_appointment: { "title": string, "type": "appointment" | "inspection", "date": "YYYY-MM-DD", "time": "HH:MM" 24h (default "08:00") }
- create_customer: { "name": string, "phone": string|null }
- navigate: { "path": one of the known paths below }
- none: {}   (when unclear or unsupported — explain briefly in "speak")

Today is ${today}. Resolve relative dates like "tomorrow" or "next Tuesday" to YYYY-MM-DD.
Known pages (path — name):
${routeList}`,
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
      revalidatePath("/appointments");
      revalidatePath("/calendar");
      return { ok: true, message: speak, navigate: "/appointments" };
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
