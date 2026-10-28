import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCREEN_CLOSE, SCREEN_OPEN, screenBlocks, type AgentScreen } from "@/lib/assistant-protocol";
import { performScreen } from "@/lib/nort/screen-driver";

// The chat component pulls in server actions and the browser voice stack at import; the helpers under
// test are pure, so those modules are stubbed (nothing here touches a database or a speaker).
vi.mock("@/app/(app)/assistant/actions", () => ({
  confirmAgentAction: vi.fn(),
  saveQuoteFromDraft: vi.fn(),
  loadConversation: vi.fn(),
  saveConversation: vi.fn(),
  clearConversation: vi.fn(),
  recoverTurn: vi.fn(),
}));

import { MISSING_BOX_NOTE, recoveredLines, refuseStaleFill, screenStepsPossible, spotMissNote } from "@/app/(app)/assistant/assistant-chat";
import { dict } from "@/lib/i18n";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123), the Nort chat: three findings in the stream loop and
 * the recovery lines. The fill guard is a function of (the step, where the screen is, where the boxes
 * were listed, whether this turn already moved it), so it is tested as one.
 */
const ROOT = path.resolve(__dirname, "..");
const chat = readFileSync(path.join(ROOT, "src/app/(app)/assistant/assistant-chat.tsx"), "utf8");

const VISIT_A = "/appointments/0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const VISIT_B = "/appointments/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const fillNotes: AgentScreen = { fill: { door: "insp-notes", value: "Panel is full; add a subpanel." } };

describe("A Nort fill can land on the page being left when show_screen and fill_screen share a turn", () => {
  it("the stream loop's first block pushes and the location has NOT changed when the next block is read", () => {
    // The real driver, with the app router's behaviour: push does not commit before the next read.
    const pushed: string[] = [];
    const nav = { here: () => VISIT_A, push: (p: string) => pushed.push(p) };
    const win = { dispatchEvent: () => true, setTimeout: () => 0, document: { querySelectorAll: () => [], getElementById: () => null } } as unknown as Window;
    const blocks = screenBlocks(
      `${SCREEN_OPEN}${JSON.stringify({ path: VISIT_B })}${SCREEN_CLOSE}${SCREEN_OPEN}${JSON.stringify(fillNotes)}${SCREEN_CLOSE}`,
    );
    expect(blocks).toHaveLength(2);
    const first = performScreen(blocks[0], nav, win);
    expect(first.moved).toBe(true); // the loop reads this and remembers the turn moved the screen
    expect(pushed).toEqual([VISIT_B]);
    expect(nav.here()).toBe(VISIT_A); // ...which is exactly why the pathname alone never caught it
  });

  it("a fill after a move earlier in the SAME turn is refused, though the pathname still matches", () => {
    const line = refuseStaleFill(fillNotes, VISIT_A, VISIT_A, true);
    expect(line).not.toBeNull();
    expect(line).toContain("insp-notes: NOT filled");
    expect(line).toContain(VISIT_A);
    // An add-a-row step is a typing step too.
    expect(refuseStaleFill({ add: { door: "insp-measures", fields: { label: "north wall", value: "12" } } }, VISIT_A, VISIT_A, true)).toContain("insp-measures: NOT filled");
  });

  it("the fill is not refused when nothing has moved, and the person's own move still refuses it", () => {
    expect(refuseStaleFill(fillNotes, VISIT_A, VISIT_A, false)).toBeNull();
    expect(refuseStaleFill(fillNotes, VISIT_B, VISIT_A, false)).toContain("the screen moved from");
  });

  it("a block that carries its own path moves first and waits for the page; a point after a move is not a fill", () => {
    expect(refuseStaleFill({ path: VISIT_B, fill: fillNotes.fill }, VISIT_A, VISIT_A, true)).toBeNull();
    expect(refuseStaleFill({ anchor: "insp-notes" }, VISIT_A, VISIT_A, true)).toBeNull();
    expect(refuseStaleFill({ path: VISIT_B }, VISIT_A, VISIT_A, true)).toBeNull();
  });

  it("the loop asks the guard with the turn's move flag, says it under the chat and by voice, and sets the flag from the driver", () => {
    expect(chat).toContain("let movedThisTurn = false;");
    expect(chat).toContain("const stale = refuseStaleFill(step, window.location.pathname, turnPathRef.current, movedThisTurn);");
    // The words are the nt_ catalog's since cn-v1138 (a tech reads them in Spanish); the keys hold them.
    expect(chat).toContain('noteUnder(t("nt_screenChanged"));');
    expect(chat).toContain('if (viaVoice) say(t("nt_screenChangedSay"));');
    expect(dict("en").nt_screenChanged).toBe("The screen changed — say that again.");
    expect(dict("en").nt_screenChangedSay).toBe("The screen changed. Say that again.");
    expect(chat).toContain("const did = performScreen(");
    expect(chat).toContain("if (did.moved) movedThisTurn = true;");
    // The flag is a per-turn local: declared where the turn's stream starts, so a new turn starts clean.
    expect(chat.indexOf("let movedThisTurn = false;")).toBeLessThan(chat.indexOf("const stale = refuseStaleFill("));
    expect(chat.indexOf('full = "";\n      screenDoneRef.current = 0;')).toBeLessThan(chat.indexOf("let movedThisTurn = false;"));
  });
});

describe("A screen-off dropped stream loses its fill/point blocks but the recovered reply is spoken as if they ran", () => {
  const plain = { text: "Put that in the visit notes.", confirm: null, stale: false };

  it("a recovered reply carries a line saying the typing or pointing may not have happened, with one thing to do", () => {
    const lines = recoveredLines(plain);
    expect(lines.map((l) => l.role)).toEqual(["assistant", "assistant"]);
    expect(lines[0].content).toBe("Put that in the visit notes.");
    expect(lines[1].content).toMatch(/connection dropped/i);
    expect(lines[1].content).toMatch(/may not have happened/);
    expect(lines[1].content).toMatch(/say it again/);
    // Said as what it is, not as a certainty either way; no door or anchor names in it.
    expect(lines[1].content).not.toMatch(/insp-|task-|need-|door|anchor/i);
  });

  it("an expired proposal keeps its own line first, and the screen note is last", () => {
    const lines = recoveredLines({ text: "Sending the invoice to Snowbell Rd.", confirm: null, stale: true });
    expect(lines).toHaveLength(3);
    expect(lines[1].content).toMatch(/too old to answer/);
    expect(lines[2].content).toMatch(/may not have happened/);
  });

  it("a turn that only proposed still reads its read-back first", () => {
    const lines = recoveredLines({ text: "", confirm: { name: "x", input: {}, prompt: "Send it?" }, stale: false });
    expect(lines[0].content).toBe("Send it?");
    expect(lines).toHaveLength(2);
  });

  it("both recovery paths use the lines; the dropped stream reads the rest of them out by voice", () => {
    expect(chat).toContain("const lines = recoveredLines(rec, p.screen !== false, lang);"); // reload catch-up: the marker carries it
    expect(chat).toContain("const lines = recoveredLines(rec, screenTurn, lang);"); // dropped stream: asked as the turn left
    expect(chat).toContain('const tail = lines.slice(1).map((l) => l.content).join(" ");');
    expect(chat).toContain('const toSay = [unspoken, tail].filter(Boolean).join(" ");');
    expect(chat).toContain("if (toSay) say(toSay, () => { if (voiceModeRef.current) startMic(); });");
  });
});

describe("Every recovered reply carries the lost-screen-steps sentence, plain Q&A turns and the reload catch-up included", () => {
  const plain = { text: "Two invoices are unpaid.", confirm: null, stale: false };

  it("a turn that could not have carried screen steps gets the words only", () => {
    const lines = recoveredLines(plain, false);
    expect(lines.map((l) => l.content)).toEqual(["Two invoices are unpaid."]);
    // an expired proposal still says so on its own line, with no screen note after it
    const stale = recoveredLines({ text: "Sending the invoice.", confirm: null, stale: true }, false);
    expect(stale).toHaveLength(2);
    expect(stale[1].content).toMatch(/too old to answer/);
  });

  it("the default stays the safe side: a caller that does not know says the sentence", () => {
    expect(recoveredLines(plain)).toHaveLength(2);
    expect(recoveredLines(plain, true)).toHaveLength(2);
  });

  it("a turn could have carried screen steps when the page listed boxes, or is one of the registry's screens", () => {
    expect(screenStepsPossible("/assistant", 0)).toBe(false); // Nort's own chat: a plain question
    expect(screenStepsPossible("/", 0)).toBe(false);
    expect(screenStepsPossible("/assistant", 3)).toBe(true); // boxes he may type into
    expect(screenStepsPossible("/appointments/some-visit", 0)).toBe(true);
    expect(screenStepsPossible("/jobs", 0)).toBe(true);
    expect(screenStepsPossible("/planner", 0)).toBe(true);
    expect(screenStepsPossible("", 0)).toBe(false);
  });

  it("the marker carries the answer across a reload, and an older marker without it counts as yes", () => {
    expect(chat).toContain("type PendingTurn = { content: string; at: string; voice: boolean; screen?: boolean };");
    expect(chat).toContain("return { content: p.content, at: p.at, voice: !!p.voice, screen: p.screen !== false };");
    expect(chat).toContain("const screenTurn = screenStepsPossible(window.location.pathname, listNortDoors().length);");
    expect(chat).toContain("writePendingTurn({ content, at: sentAt, voice: viaVoice, screen: screenTurn });");
  });
});

describe("Failed fill and miss notes show raw door and anchor names to the user", () => {
  const RAW = /task-hours-[0-9a-f-]{8,}|need-q_\w+|insp-notes|job-tabs/;

  it("a box that is gone is said in plain words, never by its name, and names one action", () => {
    expect(MISSING_BOX_NOTE).toBe("That box isn't on this screen — say that again.");
    expect(MISSING_BOX_NOTE).not.toMatch(RAW);
  });

  it("a spot that never showed is said by the model's label, else 'that spot' — never the anchor name", () => {
    expect(spotMissNote("the Costs tab")).toBe("Couldn't find the Costs tab on this screen.");
    expect(spotMissNote("  the Costs   tab ")).toContain("the Costs");
    for (const none of [undefined, null, "", "   "]) expect(spotMissNote(none)).toBe("Couldn't find that spot on this screen.");
    expect(spotMissNote(null)).not.toMatch(RAW);
  });

  it("the loop shows those two sentences, and no user-facing note interpolates the door or the anchor", () => {
    expect(chat).toContain("setMissNote(spotMissNote(s.label, lang));");
    expect(chat).toContain('const words = "missing" in o.result ? t(MISSING_BOX_KEY) : fillText(t("nt_couldntPutIn"), { why: o.result.why });');
    expect(dict("en").nt_couldntPutIn).toBe("Couldn't put that in: {why}");
    expect(chat).not.toContain("No box called ${o.door}");
    expect(chat).not.toContain('${s.label ?? s.anchor ?? "that"}');
    // What the MODEL is told keeps the names (they are its handles); only the person's lines changed.
    expect(chat).toContain("seenRef.current.push(`${o.door}: NOT filled — ${o.result.why}`);");
    expect(chat).toContain('seenRef.current.push(`${s.anchor ?? "a spot"}: not on this screen`);');
  });
});
