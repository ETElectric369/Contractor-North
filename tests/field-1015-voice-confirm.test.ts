import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * THE CONFIRM QUESTION NOBODY HEARD (Erik's locked round, 2026-10-15 22:50). Nort's reply was a confirm
 * card ("Move this appointment to Monday at 9?"); in voice mode its question is spoken by the one-line
 * say path, then Nort listens for a yes. That path lost its one clip request, fell to the browser voice
 * (silent in the dark), and listened to silence. Three things changed: the say path and the reply
 * queue ask twice and trace every stage; nothing is "spoken" by the browser voice while the page is
 * dark; and a failed clip reaches the ops sink from the server too.
 *
 * SAME NIGHT, the appointment form: a new person is a NEW LEAD or a NEW CUSTOMER in plain sight (the
 * old choice was an option at the bottom of the Customer list, unseen), the lead goes through the
 * visit page's own door with the visit's address, and the Location box is the address picker the
 * lead form has. And Nort reads no price-book cost back on a materials list.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("the say path and the reply queue (lib/tts)", () => {
  const tts = src("src/lib/tts.ts");
  it("asks for a clip twice, traces each stage, and never uses the browser voice in the dark", () => {
    expect(tts).toContain("export const CLIP_RETRY_MS = 1500;");
    expect(tts).toContain("async function clipTwice(t: string, alive: () => boolean = () => true): Promise<{ blob: Blob } | { why: string }>");
    // One request may not hang the turn; a cut phrase makes no second try and never plays late; a refusal is not retried.
    expect(tts).toContain("export const CLIP_WAIT_MS = 8000;");
    expect(tts).toContain("AbortSignal.timeout(CLIP_WAIT_MS)");
    expect(tts).toContain("sayEpoch++; // a phrase still fetching its clip is cut too");
    expect(tts).toContain("if (!alive()) return; // cut while the clip was on its way");
    expect(tts).toContain("if ([400, 401, 403, 404].includes(r.status)) return { why };");
    expect(tts).toContain('if (buf.byteLength >= 1024) return { blob: new Blob([buf], { type: "audio/mpeg" }) };');
    // The caller is told whether anything was heard.
    expect(tts).toContain("export function speakSmart(text: string, onEnd?: (heard: boolean) => void, onStart?: () => void) {");
    expect(tts).toContain('if (o === "refused") { if (dark()) fire(false); else browserSpeak(t, fire, begin); }');
    expect(tts).toContain("for (let attempt = 0; attempt < 2; attempt++) {");
    expect(tts).toContain('if (!attempt) trace("clip retry", why);');
    for (const line of ['trace("say sent", `${t.length} chars`);', 'trace("say failed", got.why);', 'trace("say clip", `${blob.size}b native`);', 'trace("say done", o);']) expect(tts).toContain(line);
    expect(tts).toContain("if (dark()) { fire(false); return; }");
    expect(tts).toContain('return typeof document !== "undefined" && document.visibilityState === "hidden";');
    // The reply queue: the same two tries, and a lost sentence is skipped in the dark, never read silently.
    expect(tts).toContain("return clipTwice(speakableText, alive).then((got) => {");
    expect(tts).toContain("clip: synthClip(t, () => !this.stopped)");
    expect(tts).toContain('trace("clip failed", got.why);');
    expect(tts).toContain('} else if (nativePlaybackOn() && pageHidden()) {\n        trace("clip skipped", "dark");');
    // Only audio is a clip.
    expect(tts).toContain('if (r.ok && (!ct || ct.startsWith("audio/")))');
    expect(tts).toContain('why = r.ok ? "tts not audio" : `tts ${r.status}`;');
  });
  it("keeps the player's contract: onEnd at the end or a failure (a failure is unheard), never on a cut", () => {
    expect(tts).toContain('if (o === "refused") { if (dark()) fire(false); else browserSpeak(t, fire, begin); }\n        else if (o !== "stopped") fire(o === "ended");');
  });
});

describe("the chat: a confirm question nobody heard gates nothing", () => {
  it("listens for the yes only when the question was heard; unheard, it is asked again when the screen comes back", () => {
    const chat = src("src/app/(app)/assistant/assistant-chat.tsx");
    expect(chat).toContain("function confirmAfterSaid(heard: boolean) {");
    expect(chat).toContain("if (heard) { confirmListen(); return; }");
    expect(chat).toContain('trace("confirm unheard");');
    expect(chat).toContain('document.addEventListener("visibilitychange", again);');
    expect(chat).toContain("if (viaVoice) say(proposal.prompt, confirmAfterSaid);");
    expect(chat).toContain('say("Say yes or no.", confirmAfterSaid);');
    // No confirm prompt listens straight after say() any more.
    expect(chat).not.toContain("() => { if (voiceModeRef.current) confirmListen(); }");
  });
});

describe("/api/tts reports a failed clip to the ops sink", () => {
  const route = src("src/app/api/tts/route.ts");
  it("both providers", () => {
    expect(route).toContain('import { reportError } from "@/lib/observe";');
    // Status and size only: a provider's body can echo the spoken words, which the sink never holds.
    expect(route).toContain('reportError("api/tts", new Error(`ElevenLabs ${r.status}`), { provider: "elevenlabs", status: r.status, chars: text.length });');
    expect(route).toContain('reportError("api/tts", new Error(`OpenAI ${r.status}`), { provider: "openai", status: r.status, chars: text.length });');
    expect(route).not.toContain("detail: detail");
  });
});

describe("the appointment form: a new person in plain sight, and the address picker", () => {
  const form = src("src/app/(app)/appointments/appointment-button.tsx");
  it("offers New Lead and New Customer as buttons (Title Case), not an option at the bottom of the list", () => {
    expect(form).not.toContain("+ New customer…");
    expect(form).toContain('<UserPlus className="h-4 w-4" /> New Lead');
    expect(form).toContain('<Plus className="h-4 w-4" /> New Customer');
    expect(form).toContain('const isNewPerson = (id: string) => id === "__new__" || id === "__lead__";');
    expect(form).toContain('<input type="hidden" name="customer_id" value={form.customer_id} />');
    expect(form).toContain('{newLead ? "New lead name" : "New customer name"}');
    // The list itself no longer carries the name: the hidden input does.
    expect(form).toContain('<Select\n                id="ap-cust"\n                value={form.customer_id}');
  });
  it("the Location box is the lead form's address picker, and a pick's parts ride as hidden inputs", () => {
    expect(form).toContain('import { AddressAutocomplete } from "@/components/address-autocomplete";');
    expect(form).toContain('<AddressAutocomplete\n              key={locSeed}\n              id="ap-loc"\n              name="location"');
    expect(form).toContain('onResolved={(p) => patchSuggesting({ location: p.formatted, city: p.city, state: p.state, zip: p.zip, parts_picked: true })}');
    expect(form).toContain('<input type="hidden" name="city" value={form.city} />');
    // Typing over a pick drops its parts; a prefill from a customer or job pick re-seeds the box.
    expect(form).toContain('patchSuggesting(form.parts_picked ? { location: v, city: "", state: "", zip: "", parts_picked: false } : { location: v });');
    expect(form.split("reseedLocation();").length - 1).toBeGreaterThanOrEqual(4);
    // Both save paths say what a lead that could not be made would otherwise hide.
    expect(form.split('toast(res.warning, "info", undefined, { sticky: true })').length - 1).toBe(2); // must be READ: the form closes
    // A new person made by an edit's save is made once: the box goes back to the list.
    expect(form).toContain('const cleared = isNewPerson(form.customer_id) ? { ...form, customer_id: "", new_customer_name: "", new_customer_phone: "" } : form;');
  });
});

describe("the appointment writers: a new lead goes through the visit page's own door", () => {
  const acts = src("src/app/(app)/appointments/actions.ts");
  it("__lead__ makes the lead after the visit exists, with the phone, on create, edit and propose", () => {
    expect(acts).toContain('if (customerId === "__lead__") {\n    if (!newName) return { customerId: null, error: "Enter a name for the new lead." };');
    // (the edit passes whether the visit had a customer, so a failed lead leaves it: carried-1123-link-picker)
    expect(acts).toContain("async function attachNewLead(\n  appointmentId: string,\n  lead: { name: string; phone: string | null },\n  hadCustomer = false,\n): Promise<string | undefined> {");
    expect(acts).toContain("const made = await linkAppointmentToNewLead(appointmentId, lead.name, lead.phone);");
    expect(acts).toContain("const warning = cust.lead ? await attachNewLead(data.id, cust.lead) : undefined;");
    expect(acts).toContain("const warning = cust.lead ? await attachNewLead(id, cust.lead, !!row?.customer_id) : undefined;");
    expect(acts).toContain("const warning = cust.lead ? await attachNewLead(res.appointmentId, cust.lead) : undefined;");
    expect(acts).toContain('if (phone) fd.set("phone", phone);');
    expect(acts).toContain("return { ok: true, id: data.id, ...(warning ? { warning } : {}) };");
    expect(acts).toContain("return { ok: true, ...(warning ? { warning } : {}) };");
    expect(acts).toContain('return [made.note, kept].filter(Boolean).join(" ") || undefined;');
    // One lead per visit.
    expect(acts).toContain('if (cust.lead && row?.inquiry_id) return { ok: false, error: "This visit already has a lead attached — change who it\'s for from the visit\'s page." };');
  });
  it("a pick's parts are written on create, propose and edit; on edit a typed line that no longer says a stored part drops the parts", () => {
    expect(acts).toContain('if (!formData.has("city")) return {};');
    expect(acts.split("...placeParts(formData),").length - 1).toBe(2); // create + propose
    expect(acts).toContain('const parts = formData.has("city") ? placeParts(formData) : row && !typedLineKeepsParts(line, row) ? { city: null, state: null, zip: null } : {};');
    const prop = src("src/lib/appointments/proposal.ts");
    expect(prop).toContain("return { ok: true, token: prop.token as string, appointmentId: appt.id };");
    expect(prop).toContain("city: input.city ?? null,\n      state: input.state ?? null,\n      zip: input.zip ?? null,");
  });
});

describe("Nort reads no cost back on a materials list", () => {
  it("the staff projection has vendor, never est_cost", () => {
    const tools = src("src/lib/assistant-tools.ts");
    expect(tools).toContain('.select(staff ? "id, description, part_number, quantity, unit, vendor, purchased, purchased_at, is_tool, sort_order" : TECH_ITEM_COLUMNS)');
    expect(tools).toContain("...(staff ? { vendor: it.vendor ?? null } : {}),");
    expect(tools).not.toContain("money(it.est_cost)");
  });
});
