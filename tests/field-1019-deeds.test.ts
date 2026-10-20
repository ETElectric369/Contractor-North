/**
 * A DEED IS A TOOL RESULT, NEVER NORT'S WORD (2026-10-19, the lock-screen clock-in round).
 *
 * Nort told Erik twice that a write had happened when nothing had run: "the whole punch moved over,
 * nothing left on the other job" and "Clocked out — 2 minutes on 12 Larkspur Lane. All set." — no
 * audit row, no change; the one punch of the night sat on the job the app had picked until a
 * confirmed fix closed it. Three parts, pinned here: ONE law in the core prompt (it applies whether
 * or not a write tool is offered; the route's honesty rule defers to it), the clock-in verb resolving
 * a spoken job name or street (the unit test is beside the entity), and the page re-reading after a
 * write so the clock and the site fence follow a Nort punch at once instead of a minute later ("It
 * just went off") — under the same guards RefreshOnVisible has, because a refresh whose fetch fails
 * is a full navigation that would end the voice session.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSISTANT_SYSTEM_PROMPT } from "@/lib/anthropic";
import { CONFIRM_MARKER, HOLDING_OPEN, HOLDING_CLOSE, WROTE_OPEN, WROTE_CLOSE, directivePayload, envelope, type AgentConfirm } from "@/lib/assistant-protocol";
import { APP_VERSION } from "@/lib/version";
import { RELEASE_NOTES } from "@/lib/release-notes";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("the deeds law is in the core prompt, once", () => {
  it("a deed is a tool result in THIS turn; a yes is permission to call; refused → reason, asked → ask, no tool → say so", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("A DEED IS A TOOL RESULT, NEVER YOUR WORD.");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("ONLY when a tool result in THIS turn says ok for that very thing");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("A yes from the person is permission to CALL the tool now, never a result: on a yes, call it, then report.");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("When a tool REFUSES, give its reason. When a tool ASKS (which one? a missing field?), ask the person that question, then call it again with the answer.");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("When there is NO tool for it, say so in one plain sentence, and say where in the app it is done if you know the screen.");
  });
  it("the route's honesty rule defers to the law instead of carrying a second threshold", () => {
    const r = src("src/app/api/chat/route.ts");
    expect(r).toContain("THE HONESTY RULE (absolute) is the deeds law above — a deed is a tool result in THIS turn, never your word.");
    expect(r).not.toContain("SUCCEEDED in this conversation");
    expect(r).toContain("offer capture.quick so it still lands somewhere real");
  });
  it("the switch verb says never to claim a move its result did not make", () => {
    expect(src("src/lib/actions/entities/time.ts")).toContain("never say a punch moved unless this tool's result says so");
  });
});

describe("the clock-in verb resolves a named job before the punch, and says which job it is on", () => {
  it("the handler runs resolveJobId, refuses on its error before clockIn, and echoes the job", () => {
    const t = src("src/lib/actions/entities/time.ts");
    const body = t.slice(t.indexOf('"time.clockIn": {'), t.indexOf('"time.clockOut": {'));
    expect(body).toContain("const job = await resolveJobId(supabase, i.job_id ?? null);");
    expect(body).toContain('if ("error" in job) return { ok: false, error: job.error };');
    expect(body).toContain("const punched = await clockIn({ job_id: job.id,");
    expect(body.indexOf("resolveJobId(")).toBeLessThan(body.indexOf("await clockIn("));
    expect(body).toContain("const onJob = punched.ok && job.id ? await jobSaidAs(supabase, job.id) : null;");
    expect(body).toContain("When the result carries `recorded`, say it: it names the job the punch is on.");
  });
  it("a job is named by its street from the truck: the resolver and list_jobs both read the address", () => {
    expect(src("src/lib/actions/resolve-id.ts")).toContain('{ nameColumns: ["name", "job_number", "address"], thing: "job" }');
    expect(src("src/lib/assistant-tools.ts")).toContain("description.ilike.%${s}%,address.ilike.%${s}%`);");
  });
});

describe("the page follows a write", () => {
  it("the route names the registry writes that said ok, once, before the holding count, only to a bundle that strips it", () => {
    const r = src("src/app/api/chat/route.ts");
    expect(r).toContain("if (res.ok && !readOnlyAction) wroteActions.push(actionName);");
    expect(r).toContain("if (wroteActions.length && (versionNumber(phoneVersion) ?? 0) >= 1122) emit(envelope(WROTE_OPEN, { actions: wroteActions }, WROTE_CLOSE));");
    expect(r.indexOf("emit(envelope(WROTE_OPEN")).toBeLessThan(r.indexOf("emit(envelope(HOLDING_OPEN, left, HOLDING_CLOSE))"));
  });
  it("the block cannot carry a marker, the client strips it whole or half-arrived, and a directive read past it still parses", () => {
    expect(envelope(WROTE_OPEN, { actions: ["time.clockIn"] }, WROTE_CLOSE)).toBe('␞CN_WROTE␞{"actions":["time.clockIn"]}␞/CN_WROTE␞');
    const c = src("src/app/(app)/assistant/assistant-chat.tsx");
    expect(c).toContain('const wre = new RegExp(WROTE_OPEN + "([\\\\s\\\\S]*?)" + WROTE_CLOSE, "g");');
    expect(c).toContain('.replace(nre, "").replace(wre, "").replace(sre, "")');
    expect(c).toContain("for (const m of [DRAFT_OPEN, HUD_OPEN, STATUS_OPEN, HOLDING_OPEN, WROTE_OPEN, SCREEN_OPEN])");
    // the cut list where the 10-15 bug lived: a block after the directive must not swallow it
    const full = "Fixing it." + envelope(CONFIRM_MARKER, { name: "time.fixEntry", input: { entry_id: "e" }, prompt: "Fix it?" }) + envelope(WROTE_OPEN, { actions: ["x"] }, WROTE_CLOSE) + envelope(HOLDING_OPEN, { reports: 0, dailyReports: [] }, HOLDING_CLOSE);
    expect(directivePayload<AgentConfirm>(full, CONFIRM_MARKER)?.name).toBe("time.fixEntry");
  });
  it("the client re-reads under RefreshOnVisible's guards: never offline, never under a sheet, deferred while dark; after a settled writing turn and after a confirmed action", () => {
    const c = src("src/app/(app)/assistant/assistant-chat.tsx");
    const guard = c.slice(c.indexOf("const refreshIfClear = () => {"), c.indexOf("const followWrite = () => {"));
    expect(guard).toContain("if (typeof navigator !== \"undefined\" && navigator.onLine === false) return;");
    expect(guard).toContain('if (document.body.classList.contains("modal-open")) return;');
    expect(guard).toContain("router.refresh();");
    expect(c).toContain('if (document.visibilityState !== "visible") { refreshWhenVisibleRef.current = true; return; }');
    expect(c).toContain('document.addEventListener("visibilitychange", onVisible);');
    expect(c).toContain("if (settled.wrote?.actions.length) followWrite();");
    expect(c.indexOf("turnSettled = true; // every byte arrived")).toBeLessThan(c.indexOf("if (settled.wrote?.actions.length) followWrite();"));
    const confirm = c.slice(c.indexOf("async function resolveConfirm("), c.indexOf("// When opened with ?q="));
    expect(confirm).toContain("const res = await confirmAgentAction(c.name, c.input);");
    expect(confirm).toContain("if (res.ok) followWrite();");
    expect((c.match(/router\.refresh\(\)/g) ?? []).length).toBe(1); // one door, guarded
  });
});

describe("the law covers what Nort looked up and what he knows (the 10-19 phone tries' nits)", () => {
  it("a lookup is a deed: no 'can't find it' without the search tool in THIS turn", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("THE SAME LAW COVERS WHAT YOU LOOKED UP AND WHAT YOU KNOW.");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("A lookup is a deed: never say \"there's no job named that\" or \"I can't find it\" unless the search tool (list_jobs, the customer or item search) ran in THIS turn — run it, or say you did not look.");
  });
  it("where someone IS is a read in THIS turn, never a memory", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("the screen can close a punch between two of your turns, so read it again in THIS turn (who_is_clocked_in, time.listEntries, the schedule) before you say it.");
  });
  it("the resolver's zero-match sentence names ONE action; it no longer offers a tech a thing he cannot do", () => {
    const r = src("src/lib/actions/resolve-id.ts");
    expect(r).toContain('error: `No ${thing} named "${raw}" — is it spelled right?`');
    expect(r).not.toContain("or should I create it?` ");
  });
  it("time.switchJob reads the running shift before it resolves the job", () => {
    const t = src("src/lib/actions/entities/time.ts");
    const body = t.slice(t.indexOf('"time.switchJob": {'), t.indexOf("WHICH SHIFT DID THEY MEAN?"));
    const openRead = body.indexOf('if (!open) return { ok: false, error: "You\'re not clocked in." };');
    const resolve = body.indexOf("const job = await resolveJobId(supabase, i.job_id ?? null);");
    expect(openRead).toBeGreaterThan(0);
    expect(resolve).toBeGreaterThan(openRead);
  });
});

describe("the release carries the round", () => {
  it("the running build carries cn-v1122's note, which names the three", () => {
    expect(Number(APP_VERSION.replace("cn-v", ""))).toBeGreaterThanOrEqual(1122);
    const note = RELEASE_NOTES.find((r) => r.version === "cn-v1122");
    expect(note?.date).toBe("2026-10-19");
    expect(note?.line).toContain("only when the app did it");
    expect(note?.line).toContain("a job you name at clock-in is the job the punch lands on");
  });
});
