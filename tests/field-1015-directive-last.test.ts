/**
 * THE ENVELOPE IS LAST (field feedback 10-15, the lock-screen freeze — both nights). A confirm /
 * open / pick directive rides at the END of the stream and the phone read its JSON as "everything
 * after the marker". Since 0394 the route emitted the holding count after the envelope, so that
 * parse threw: no card, no spoken question, the mic opened on a plain turn, and Nort "froze" with
 * the screen locked. Two rules now: the route emits the envelope after the count (last again), and
 * the phone reads an envelope up to the next block whatever follows it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONFIRM_MARKER, OPEN_MARKER, PICK_MARKER, HOLDING_OPEN, HOLDING_CLOSE, STATUS_OPEN, STATUS_CLOSE,
  directivePayload, type AgentConfirm, type AgentOpen, type AgentPick,
} from "@/lib/assistant-protocol";

const read = (p: string) => readFileSync(p, "utf8");
const ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const proposal = { name: "appointment.update", input: { id: ID, starts_at: "2026-10-19T09:00" }, prompt: "Move this appointment to Mon 10/19 at 9am? Check the details below before you confirm." };
const holding = HOLDING_OPEN + JSON.stringify({ updates: 2, reminders: 0 }) + HOLDING_CLOSE;

describe("the phone reads an envelope up to the next block", () => {
  it("parses the proposal when the holding count follows it (the stream of 10-14 to 10-15)", () => {
    const full = "One sec, pulling that up.\n" + CONFIRM_MARKER + JSON.stringify(proposal) + holding;
    expect(directivePayload<AgentConfirm>(full, CONFIRM_MARKER)).toEqual(proposal);
    // The old reader, for the record: this is the throw that lost the card.
    expect(() => JSON.parse(full.split(CONFIRM_MARKER)[1])).toThrow();
  });
  it("parses the proposal when it is last, with or without a trailing newline", () => {
    expect(directivePayload<AgentConfirm>("Sure.\n" + CONFIRM_MARKER + JSON.stringify(proposal), CONFIRM_MARKER)).toEqual(proposal);
    expect(directivePayload<AgentConfirm>(CONFIRM_MARKER + JSON.stringify(proposal) + "\n", CONFIRM_MARKER)).toEqual(proposal);
  });
  it("cuts at a status block too, and reads the open and pick envelopes the same way", () => {
    const open = { url: "https://maps.apple.com/?q=Bayberry", label: "Bayberry" };
    const pick = { kind: "contact", query: "Thistlewood" };
    expect(directivePayload<AgentOpen>("Opening.\n" + OPEN_MARKER + JSON.stringify(open) + STATUS_OPEN + JSON.stringify({ label: "x" }) + STATUS_CLOSE, OPEN_MARKER)).toEqual(open);
    expect(directivePayload<AgentPick>(PICK_MARKER + JSON.stringify(pick) + holding, PICK_MARKER)).toEqual(pick);
  });
  it("is null when there is no envelope, when it does not parse, and when it is not an object", () => {
    expect(directivePayload("just words" + holding, CONFIRM_MARKER)).toBeNull();
    expect(directivePayload(CONFIRM_MARKER + '{"name":', CONFIRM_MARKER)).toBeNull();
    expect(directivePayload(CONFIRM_MARKER + "7", CONFIRM_MARKER)).toBeNull();
    expect(directivePayload(CONFIRM_MARKER + "[1]", CONFIRM_MARKER)).toBeNull();
    expect(directivePayload(CONFIRM_MARKER + "null", CONFIRM_MARKER)).toBeNull();
  });
});

describe("the route ends the stream with the envelope, after the holding count", () => {
  const r = read("src/app/api/chat/route.ts");
  it("holds the directive and emits it last", () => {
    expect(r).toContain('let directive = "";');
    expect(r).toContain("directive = envelope(OPEN_MARKER, pendingOpen);");
    expect(r).toContain("directive = envelope(PICK_MARKER, pendingPick);");
    expect(r).toContain("directive = envelope(CONFIRM_MARKER, pendingConfirm);");
    expect(r).toMatch(/emit\(envelope\(HOLDING_OPEN, left, HOLDING_CLOSE\)\);[\s\S]{0,200}if \(directive\) emit\(directive\);[^\n]*\n\s*controller\.close\(\);/);
    for (const bad of ["emit(CONFIRM_MARKER", "emit(OPEN_MARKER", "emit(PICK_MARKER"]) expect(r).not.toContain(bad);
  });
});

describe("the chat reads every envelope through the one reader", () => {
  const c = read("src/app/(app)/assistant/assistant-chat.tsx");
  it("uses directivePayload for confirm, open, pick and the recovered turn — never a split to the end", () => {
    expect(c).toContain("const proposal = directivePayload<AgentConfirm>(full, CONFIRM_MARKER);");
    expect(c).toContain("const openDir = directivePayload<AgentOpen>(full, OPEN_MARKER);");
    expect(c).toContain("const pickDir = directivePayload<AgentPick>(full, PICK_MARKER);");
    expect(c).toContain("directivePayload<Partial<AgentConfirm> & { at?: string }>(reply, CONFIRM_MARKER)");
    expect(c).not.toContain("JSON.parse(full.split(");
    expect(c).not.toContain("JSON.parse(reply.slice(cut + CONFIRM_MARKER.length))");
  });
});
